#!/usr/bin/env python3
"""
Proxy server for bundled llama.cpp server.
Exposes the same /health and /generate API shape expected by InferenceClient.
"""
from __future__ import annotations

import atexit
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

import requests
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel


app = FastAPI(title="Bundled llama.cpp Proxy", version="1.0.0")

_child_proc: Optional[subprocess.Popen] = None
_child_log_handle = None
_child_log_path: str = ""
_load_state: str = "not_started"  # not_started|loading|ready|error
_load_error: str = ""
_inner_url: str = ""
_model_name: str = os.getenv("MODEL_NAME", "local-llm")


class GenerateRequest(BaseModel):
    prompt: str
    max_new_tokens: int = 256
    temperature: float = 0.7


class GenerateResponse(BaseModel):
    text: str


def _nvidia_gpu_available() -> bool:
    """Probe for a usable NVIDIA GPU without importing torch (the bundled
    proxy must stay light)."""
    try:
        creationflags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
        r = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=4, creationflags=creationflags,
        )
        return r.returncode == 0 and bool(r.stdout.strip())
    except Exception:
        return False


def _default_n_gpu_layers() -> int:
    """How many model layers to offload to GPU.

    Resolution order:
      1. ``LLM_BUNDLED_N_GPU_LAYERS`` — explicit override (e.g. ``-1`` for
         full offload, ``0`` to force CPU, or any positive int for a
         partial offload).
      2. ``CUDA_VISIBLE_DEVICES`` — if the parent process narrowed the
         devices to something usable, full-offload onto whatever's left.
         Set to ``-1`` / ``cpu`` / ``none`` / empty to opt out.
      3. ``nvidia-smi`` probe — if an NVIDIA GPU is physically present and
         the driver answers, default to full offload. The previous
         behaviour required CUDA_VISIBLE_DEVICES to be preset and silently
         fell back to CPU when the launcher didn't set it, which is the
         "I have a 4090 and the model is running on CPU" bug.
      4. Otherwise CPU.
    """
    raw = str(os.getenv("LLM_BUNDLED_N_GPU_LAYERS", "")).strip()
    if raw:
        try:
            return int(raw)
        except Exception:
            return 0

    cuda_visible = str(os.getenv("CUDA_VISIBLE_DEVICES", "")).strip().lower()
    if cuda_visible:
        if cuda_visible in {"-1", "cpu", "none"}:
            return 0
        return -1

    if _nvidia_gpu_available():
        return -1
    return 0


def _schedule_process_exit(delay_s: float = 0.2) -> None:
    def _exit() -> None:
        try:
            _shutdown_child()
        except Exception:
            pass
        time.sleep(max(0.0, float(delay_s)))
        os._exit(0)

    threading.Thread(target=_exit, daemon=True).start()


def _pick_free_port(start: int) -> int:
    p = int(start)
    for _ in range(200):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(0.4)
        try:
            if s.connect_ex(("127.0.0.1", p)) != 0:
                return p
        finally:
            s.close()
        p += 1
    raise RuntimeError(f"Could not find free port near {start}")


def _discover_llama_server() -> Optional[Path]:
    env = (os.getenv("LLM_BUNDLED_LLAMA_SERVER_EXE", "") or "").strip()
    if env:
        p = Path(env)
        if p.exists():
            return p
    root = Path(__file__).resolve().parents[2]
    candidates = [
        root / "runtime" / "llama.cpp" / "llama-server.exe",
        root / "runtime" / "llama_cpp" / "llama-server.exe",
        root / "bin" / "llama-server.exe",
        root / "tools" / "llama.cpp" / "llama-server.exe",
    ]
    for p in candidates:
        if p.exists():
            return p
    return None


def _child_health_ok(base_url: str) -> bool:
    try:
        r = requests.get(f"{base_url}/health", timeout=2)
        if r.status_code == 200:
            return True
    except Exception:
        pass
    try:
        r = requests.get(f"{base_url}/v1/models", timeout=2)
        return r.status_code == 200
    except Exception:
        return False


def _resolve_bundled_model_path(model_path: str) -> Path:
    path = Path(model_path)
    if path.is_file():
        return path
    if not path.is_dir():
        return path

    marker = path / ".selected_weights.json"
    if marker.exists():
        try:
            data = json.loads(marker.read_text(encoding="utf-8"))
            active = data.get("active_variant")
            if isinstance(active, str) and active.strip():
                candidate = (path / active).resolve()
                if candidate.exists() and candidate.suffix.lower() == ".gguf":
                    return candidate
        except Exception:
            pass

    ggufs = sorted(path.rglob("*.gguf"))
    if ggufs:
        return ggufs[0]
    return path


def _read_child_log_tail(limit_chars: int = 2000) -> str:
    try:
        if not _child_log_path:
            return ""
        content = Path(_child_log_path).read_text(encoding="utf-8", errors="replace")
        return content[-limit_chars:].strip()
    except Exception:
        return ""


def _start_child_server() -> None:
    global _child_proc, _child_log_handle, _child_log_path, _load_state, _load_error, _inner_url
    model_path = (os.getenv("BASE_MODEL", "") or "").strip()
    if not model_path:
        _load_state = "error"
        _load_error = "BASE_MODEL is required for bundled proxy."
        return
    resolved_model_path = _resolve_bundled_model_path(model_path)
    if not resolved_model_path.exists():
        _load_state = "error"
        _load_error = f"Bundled proxy model path does not exist: {resolved_model_path}"
        return
    server_exe = _discover_llama_server()
    if server_exe is None:
        _load_state = "error"
        _load_error = "Bundled llama-server.exe not found. Set LLM_BUNDLED_LLAMA_SERVER_EXE."
        return

    outer_port = int(os.getenv("SERVER_PORT", "9100"))
    inner_port = _pick_free_port(outer_port + 1000)
    _inner_url = f"http://127.0.0.1:{inner_port}"

    cmd = [
        str(server_exe),
        "--host",
        "127.0.0.1",
        "--port",
        str(inner_port),
        "--model",
        str(resolved_model_path),
        "--ctx-size",
        str(int(os.getenv("LLM_BUNDLED_CTX_SIZE", "4096"))),
        "--n-gpu-layers",
        str(_default_n_gpu_layers()),
        "--reasoning-format",
        "none",
    ]
    flags: Dict[str, Any] = {}

    _load_state = "loading"
    try:
        child_log_dir = Path(tempfile.gettempdir())
        child_log_dir.mkdir(parents=True, exist_ok=True)
        _child_log_path = str(
            child_log_dir / f"bundled_llama_server_{int(time.time())}_{os.getpid()}.log"
        )
        _child_log_handle = open(_child_log_path, "w", encoding="utf-8", errors="replace")
        _child_proc = subprocess.Popen(
            cmd,
            stdout=_child_log_handle,
            stderr=subprocess.STDOUT,
            text=True,
            **flags,
        )
    except Exception as e:
        _load_state = "error"
        _load_error = f"Failed to launch bundled llama-server: {e}"
        return

    started = time.time()
    while time.time() - started < 180:
        if _child_proc is None:
            _load_state = "error"
            _load_error = "Bundled process missing after launch."
            return
        if _child_proc.poll() is not None:
            _load_state = "error"
            details = _read_child_log_tail()
            _load_error = "Bundled llama-server exited during startup."
            if details:
                _load_error += f" Details: {details[:1600]}"
            return
        if _child_health_ok(_inner_url):
            _load_state = "ready"
            return
        time.sleep(1.0)
    _load_state = "error"
    details = _read_child_log_tail()
    _load_error = "Bundled llama-server did not become healthy in time."
    if details:
        _load_error += f" Details: {details[:1600]}"


def _shutdown_child() -> None:
    global _child_proc, _child_log_handle
    if _child_proc is None:
        if _child_log_handle is not None:
            try:
                _child_log_handle.close()
            except Exception:
                pass
            _child_log_handle = None
        return
    try:
        _child_proc.terminate()
    except Exception:
        pass
    try:
        _child_proc.wait(timeout=5)
    except Exception:
        try:
            _child_proc.kill()
        except Exception:
            pass
    if _child_log_handle is not None:
        try:
            _child_log_handle.close()
        except Exception:
            pass
        _child_log_handle = None
    _child_proc = None


@app.on_event("startup")
async def startup_event() -> None:
    t = threading.Thread(target=_start_child_server, daemon=True)
    t.start()


@app.on_event("shutdown")
async def shutdown_event() -> None:
    _shutdown_child()


atexit.register(_shutdown_child)


@app.get("/health")
async def health() -> Dict[str, Any]:
    payload: Dict[str, Any] = {"status": _load_state, "model": _model_name}
    if _load_state == "error":
        payload["error"] = _load_error
        return payload
    if _load_state == "ready" and _inner_url:
        if _child_health_ok(_inner_url):
            payload["status"] = "ok"
        else:
            payload["status"] = "error"
            payload["error"] = "Bundled backend became unhealthy."
    return payload


@app.post("/generate", response_model=GenerateResponse)
async def generate(req: GenerateRequest) -> GenerateResponse:
    if _load_state != "ready":
        raise HTTPException(status_code=503, detail=f"Bundled backend not ready: {_load_state} {_load_error}")
    payload = {
        "model": _model_name,
        "messages": [{"role": "user", "content": req.prompt}],
        "temperature": float(req.temperature),
        "max_tokens": int(req.max_new_tokens),
        "stream": False,
    }
    try:
        r = requests.post(f"{_inner_url}/v1/chat/completions", json=payload, timeout=180)
        r.raise_for_status()
        data = r.json() if r.content else {}
        message = (((data or {}).get("choices") or [{}])[0].get("message") or {}) if isinstance(data, dict) else {}
        text = (
            message.get("content", "")
            if isinstance(message, dict)
            else ""
        )
        text = (text or "").strip()
        if not text:
            reasoning = ""
            if isinstance(message, dict):
                reasoning = str(message.get("reasoning_content") or "").strip()
            if reasoning:
                raise RuntimeError(
                    "Bundled backend returned reasoning_content without final content. "
                    "The llama.cpp server should emit final text in message.content when "
                    "--reasoning-format none is active. "
                    f"Raw: {data}"
                )
            raise RuntimeError(f"Bundled backend returned empty completion. Raw: {data}")
        return GenerateResponse(text=text)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Bundled generation failed: {e}") from e


@app.post("/shutdown")
async def shutdown() -> Dict[str, Any]:
    _schedule_process_exit()
    return {"status": "shutting_down", "model": _model_name}
