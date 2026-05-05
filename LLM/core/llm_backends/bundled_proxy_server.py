#!/usr/bin/env python3
"""
Proxy server for bundled llama.cpp server.

Exposes:
- /health, /generate, /shutdown — the InferenceClient API shape used by OWLLM
  internals.
- /v1/* — OpenAI-compatible passthrough to the inner llama-server, so Cline
  (via cline_proxy → this outer port) and any other OpenAI client can reach
  /v1/chat/completions and /v1/models. Without the passthrough Cline gets
  FastAPI's default 404 because the outer FastAPI doesn't define those routes.
"""
from __future__ import annotations

import atexit
import json
import logging
import os
import socket
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

import requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel


# Hop-by-hop headers (RFC 7230 §6.1) that must not be forwarded across a proxy.
_HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
}


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


def _discover_mmproj(weights_path: Path) -> Optional[Path]:
    """Find a multimodal projector (mmproj) GGUF *that's already on disk*.

    This is on the critical path of ``_start_child_server`` — it MUST NOT do
    network I/O. A previous version called the HF Hub here, which blocked
    server startup for the entire duration of a multi-hundred-MB download
    and made Cline see 503s for minutes. The async fetch lives in
    :func:`_kick_mmproj_autofetch` and runs after the server is up.

    Resolution order:
      1. ``LLM_BUNDLED_MMPROJ`` env override (explicit path).
      2. Any sibling file matching common mmproj naming patterns.
      3. None — server starts text-only; autofetch may land a file for
         the next restart.
    """
    override = (os.getenv("LLM_BUNDLED_MMPROJ", "") or "").strip()
    if override:
        p = Path(override)
        if p.exists():
            return p

    weights_path = Path(weights_path)
    search_dirs: list[Path] = []
    if weights_path.is_file():
        search_dirs.append(weights_path.parent)
    elif weights_path.is_dir():
        search_dirs.append(weights_path)
    else:
        return None

    patterns = ("mmproj*.gguf", "*mmproj*.gguf", "*.mmproj.gguf", "*-mmproj-*.gguf")
    for d in search_dirs:
        for pat in patterns:
            hits = sorted(d.glob(pat))
            if hits:
                return hits[0]
        # One level up: some onboarding layouts put mmproj next to the
        # weights folder rather than inside it.
        parent_hits = sorted(d.parent.glob("mmproj*.gguf")) if d.parent != d else []
        if parent_hits:
            return parent_hits[0]
    return None


_mmproj_fetch_started = False


def _kick_mmproj_autofetch(weights_path: Path) -> None:
    """Spawn a daemon thread that pulls the mmproj from HF if missing.

    Decoupled from server startup so the model server can come up
    text-only immediately. The download lands in the model folder and is
    picked up by :func:`_discover_mmproj` on the *next* restart — we
    don't try to hot-attach it to a running llama-server because
    llama-server only reads ``--mmproj`` at launch.

    Disabled with ``LLM_BUNDLED_MMPROJ_AUTOFETCH=0``. Idempotent: only one
    fetch per process.
    """
    global _mmproj_fetch_started
    if _mmproj_fetch_started:
        return
    if (os.getenv("LLM_BUNDLED_MMPROJ_AUTOFETCH", "1") or "1").strip() == "0":
        return
    weights_path = Path(weights_path)
    target_dir = weights_path.parent if weights_path.is_file() else weights_path
    if not target_dir.is_dir():
        return
    _mmproj_fetch_started = True

    def _run() -> None:
        try:
            fetched = _try_fetch_mmproj_from_hf(target_dir)
            if fetched is not None:
                logger.info(
                    "mmproj autofetch landed at %s — restart the model server "
                    "to enable image input.", fetched,
                )
        except Exception as e:
            logger.warning("mmproj autofetch thread crashed: %s", e)

    threading.Thread(target=_run, name="mmproj-autofetch", daemon=True).start()


def _try_fetch_mmproj_from_hf(target_dir: Path) -> Optional[Path]:
    """Best-effort HF fetch of a sibling mmproj GGUF.

    The model folder is named ``<org>__<repo>`` for OWLLM's onboarder
    (e.g. ``unsloth__gemma-4-E4B-it-GGUF``). We invert that to the HF id
    and ask the Hub for files matching ``mmproj*.gguf``. The smallest one
    wins (these are projector weights — typical 200–800 MB — and the
    smaller variant is usually F16/BF16 with the same accuracy as Q8).

    Failures are non-fatal: the caller will treat the model as text-only.
    """
    folder_name = target_dir.name
    if "__" not in folder_name:
        return None
    org, _, repo = folder_name.partition("__")
    if not (org and repo):
        return None
    repo_id = f"{org}/{repo}"

    try:
        from huggingface_hub import HfApi, hf_hub_download
    except Exception as e:
        logger.warning("mmproj autofetch skipped: huggingface_hub unavailable (%s)", e)
        return None

    try:
        api = HfApi()
        info = api.repo_info(repo_id=repo_id, files_metadata=True)
    except Exception as e:
        logger.warning("mmproj autofetch: repo_info(%s) failed (%s)", repo_id, e)
        return None

    candidates: list[tuple[int, str]] = []
    for sib in (getattr(info, "siblings", None) or []):
        name = getattr(sib, "rfilename", "") or ""
        low = name.lower()
        if not low.endswith(".gguf"):
            continue
        if "mmproj" not in low:
            continue
        size = int(getattr(sib, "size", 0) or 0)
        candidates.append((size or 1 << 62, name))
    if not candidates:
        logger.info("mmproj autofetch: no mmproj sibling in %s", repo_id)
        return None

    candidates.sort()
    chosen = candidates[0][1]
    logger.info("mmproj autofetch: pulling %s from %s -> %s", chosen, repo_id, target_dir)
    try:
        local = hf_hub_download(
            repo_id=repo_id,
            filename=chosen,
            local_dir=str(target_dir),
            local_dir_use_symlinks=False,
        )
        return Path(local)
    except Exception as e:
        logger.warning("mmproj autofetch: hf_hub_download(%s, %s) failed (%s)", repo_id, chosen, e)
        return None


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
        # 4096 is way too small for OpenAI-protocol coding agents — Cline's
        # system prompt + tool catalog alone is ~14k tokens, which 400s with
        # "exceeds the available context size". 32768 fits modern coding
        # workloads and stays within most consumer-GPU KV-cache budgets.
        # Override with LLM_BUNDLED_CTX_SIZE when the model or VRAM differs.
        "--ctx-size",
        str(int(os.getenv("LLM_BUNDLED_CTX_SIZE", "32768"))),
        "--n-gpu-layers",
        str(_default_n_gpu_layers()),
        "--reasoning-format",
        "none",
    ]
    # Vision projector — required for image input on multimodal GGUFs
    # (Gemma 3/4-it, LLaVA, Qwen2-VL, Pixtral, …). Without it llama-server
    # answers image_url parts with 500 "image input is not supported".
    # Local-only lookup; the HF autofetch runs in a daemon thread below
    # so server startup is never blocked on a multi-hundred-MB download.
    mmproj = _discover_mmproj(resolved_model_path)
    if mmproj is not None:
        cmd.extend(["--mmproj", str(mmproj)])
    else:
        _kick_mmproj_autofetch(resolved_model_path)

    # Optional LoRA adapter applied on top of the base GGUF. Set by
    # llm_server_manager when starting a server for a tuned__*__lora_gguf
    # onboarding row — the row's adapter_dir holds the directory with
    # the converted ``<adapter>-lora-f16.gguf`` file. llama-server
    # patches the LoRA into the base weights at load and inference
    # proceeds at base-only speed (small one-time merge cost).
    lora_path = (os.getenv("LORA_GGUF", "") or "").strip()
    if lora_path:
        lora_p = Path(lora_path)
        if not lora_p.is_absolute():
            lora_p = (Path(os.getcwd()) / lora_path).resolve()
        if lora_p.exists():
            cmd.extend(["--lora", str(lora_p)])
        else:
            print(f"[bundled-proxy] WARN: LORA_GGUF not found at {lora_p}, skipping --lora", flush=True)
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


@app.api_route(
    "/v1/{rest:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
)
async def openai_passthrough(rest: str, request: Request):
    """Forward OpenAI-protocol traffic (/v1/chat/completions, /v1/models, …)
    to the inner llama-server.

    Without this route Cline gets FastAPI's default 404 when it POSTs to
    ``/v1/chat/completions`` against the bundled proxy port — the surface
    area visible to ``cline_proxy``. Streaming is preserved so SSE token
    chunks reach the client as they're emitted by llama-server."""
    if _load_state != "ready" or not _inner_url:
        raise HTTPException(
            status_code=503,
            detail=f"Bundled backend not ready: {_load_state} {_load_error}".strip(),
        )

    upstream = f"{_inner_url}/v1/{rest}"
    if request.url.query:
        upstream = f"{upstream}?{request.url.query}"

    fwd_headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in _HOP_BY_HOP
    }
    body = await request.body()

    try:
        upstream_resp = requests.request(
            request.method,
            upstream,
            headers=fwd_headers,
            data=body if body else None,
            stream=True,
            timeout=600,
        )
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Upstream unreachable: {e}") from e

    resp_headers = {
        k: v for k, v in upstream_resp.headers.items()
        if k.lower() not in _HOP_BY_HOP
    }
    media_type = upstream_resp.headers.get("content-type")

    # Non-streaming path: small responses (e.g. /v1/models) — return whole body.
    if "text/event-stream" not in (media_type or ""):
        content = upstream_resp.content
        upstream_resp.close()
        return Response(
            content=content,
            status_code=upstream_resp.status_code,
            headers=resp_headers,
            media_type=media_type,
        )

    def _iter():
        try:
            for chunk in upstream_resp.iter_content(chunk_size=None):
                if chunk:
                    yield chunk
        finally:
            upstream_resp.close()

    return StreamingResponse(
        _iter(),
        status_code=upstream_resp.status_code,
        headers=resp_headers,
        media_type=media_type,
    )


@app.post("/shutdown")
async def shutdown() -> Dict[str, Any]:
    _schedule_process_exit()
    return {"status": "shutting_down", "model": _model_name}
