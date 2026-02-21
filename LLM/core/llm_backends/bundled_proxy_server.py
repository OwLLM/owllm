#!/usr/bin/env python3
"""
Proxy server for bundled llama.cpp server.
Exposes the same /health and /generate API shape expected by InferenceClient.
"""
from __future__ import annotations

import atexit
import os
import socket
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

import requests
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel


app = FastAPI(title="Bundled llama.cpp Proxy", version="1.0.0")

_child_proc: Optional[subprocess.Popen] = None
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


def _start_child_server() -> None:
    global _child_proc, _load_state, _load_error, _inner_url
    model_path = (os.getenv("BASE_MODEL", "") or "").strip()
    if not model_path:
        _load_state = "error"
        _load_error = "BASE_MODEL is required for bundled proxy."
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
        str(model_path),
        "--ctx-size",
        str(int(os.getenv("LLM_BUNDLED_CTX_SIZE", "4096"))),
        "--n-gpu-layers",
        str(int(os.getenv("LLM_BUNDLED_N_GPU_LAYERS", "0"))),
    ]
    flags: Dict[str, Any] = {}
    if os.name == "nt":
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = subprocess.SW_HIDE
        flags["startupinfo"] = si
        flags["creationflags"] = subprocess.CREATE_NO_WINDOW

    _load_state = "loading"
    try:
        _child_proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
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
            _load_error = "Bundled llama-server exited during startup."
            return
        if _child_health_ok(_inner_url):
            _load_state = "ready"
            return
        time.sleep(1.0)
    _load_state = "error"
    _load_error = "Bundled llama-server did not become healthy in time."


def _shutdown_child() -> None:
    global _child_proc
    if _child_proc is None:
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
        text = (
            (((data or {}).get("choices") or [{}])[0].get("message") or {}).get("content", "")
            if isinstance(data, dict)
            else ""
        )
        text = (text or "").strip()
        if not text:
            raise RuntimeError(f"Bundled backend returned empty completion. Raw: {data}")
        return GenerateResponse(text=text)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Bundled generation failed: {e}") from e
