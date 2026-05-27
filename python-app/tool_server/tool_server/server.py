from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

# NOTE:
# - This server is intentionally dependency-light (std lib only).
# - It exposes:
#     Tool endpoints (MCP-style): /health, /tools, /call
#     OpenAI-compatible endpoints (subset): /v1/models, /v1/chat/completions
# - Authentication: X-Auth-Token header (shared token) for /tools and /call
#   (OpenAI endpoints can be configured to also require the token.)

@dataclass
class ToolContext:
    root: Path
    token: str
    allow_shell: bool = False
    allow_write: bool = False
    allow_git: bool = True  # Default to True for git
    allow_network: bool = False
    require_token_for_openai: bool = False

    # OpenAI backend config
    backend: str = "transformers"  # transformers | proxy | mock
    model_path: str = ""
    backend_url: str = ""  # for proxy
    system_fingerprint: str = "local-llm-studio"
    
    # Tool enablement map (tool name -> enabled)
    enabled_tools: Dict[str, bool] = field(default_factory=dict)
    
    # Auth policy
    require_auth_for_tools_list: bool = False  # If True, /tools requires auth

    def _safe_path(self, rel: str) -> Path:
        p = (self.root / rel).resolve()
        if not str(p).startswith(str(self.root)):
            raise PermissionError("Path escapes workspace root")
        return p


# -------------------------
# Tool implementations (using registry)
# -------------------------
from tool_server.registry import ToolRegistry
from tool_server.discovery import discover_tools

# Discover tools on import
_discovery_done = False

def _ensure_discovery():
    global _discovery_done
    if not _discovery_done:
        discover_tools()
        _discovery_done = True


def list_tools(ctx: ToolContext) -> List[Dict[str, Any]]:
    """List all tools from registry."""
    _ensure_discovery()
    registry = ToolRegistry()
    return registry.list_tools(ctx.enabled_tools)


def call_tool(ctx: ToolContext, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    """Call a tool via registry."""
    _ensure_discovery()
    registry = ToolRegistry()
    
    # Check if tool is enabled
    if ctx.enabled_tools and not ctx.enabled_tools.get(name, True):
        return {"ok": False, "error": f"Tool '{name}' is disabled"}
    
    return registry.call_tool(name, args, ctx)


# -------------------------
# OpenAI-compatible backend
# -------------------------
class ChatBackend:
    def list_models(self) -> List[str]:
        return []

    def complete(self, messages: List[Dict[str, str]], *, temperature: float, max_tokens: int) -> str:
        raise NotImplementedError

    def stream(self, messages: List[Dict[str, str]], *, temperature: float, max_tokens: int):
        # yields token strings
        text = self.complete(messages, temperature=temperature, max_tokens=max_tokens)
        yield from text.split()


class MockBackend(ChatBackend):
    def __init__(self, model_id: str = "mock-local") -> None:
        self.model_id = model_id

    def list_models(self) -> List[str]:
        return [self.model_id]

    def complete(self, messages: List[Dict[str, str]], *, temperature: float, max_tokens: int) -> str:
        last = ""
        for m in messages[::-1]:
            if m.get("role") == "user":
                last = m.get("content", "")
                break
        return f"[mock] {last}"


class TransformersBackend(ChatBackend):
    def __init__(self, model_path: str) -> None:
        self.model_path = model_path
        self._loaded = False
        self._lock = threading.Lock()
        self._tok = None
        self._model = None
        self._device = None
        self._model_id = Path(model_path).name if model_path else "transformers-local"

    def list_models(self) -> List[str]:
        return [self._model_id]

    def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        with self._lock:
            if self._loaded:
                return
            from transformers import AutoTokenizer, AutoModelForCausalLM  # type: ignore

            # Best-effort device map; user can manage CUDA via env/torch settings
            self._tok = AutoTokenizer.from_pretrained(self.model_path, use_fast=True)
            self._model = AutoModelForCausalLM.from_pretrained(
                self.model_path,
                torch_dtype="auto",
                device_map="auto",
            )
            self._loaded = True

    def _format_prompt(self, messages: List[Dict[str, str]]) -> str:
        # Simple chat template (works with most instruct models; customize as needed)
        parts: List[str] = []
        for m in messages:
            role = m.get("role", "user")
            content = m.get("content", "")
            if role == "system":
                parts.append(f"System: {content}")
            elif role == "assistant":
                parts.append(f"Assistant: {content}")
            else:
                parts.append(f"User: {content}")
        parts.append("Assistant:")
        return "\n".join(parts)

    def complete(self, messages: List[Dict[str, str]], *, temperature: float, max_tokens: int) -> str:
        self._ensure_loaded()
        assert self._tok is not None and self._model is not None
        import torch  # type: ignore

        prompt = self._format_prompt(messages)
        inputs = self._tok(prompt, return_tensors="pt")
        inputs = {k: v.to(self._model.device) for k, v in inputs.items()}

        gen = self._model.generate(
            **inputs,
            max_new_tokens=max_tokens,
            do_sample=temperature > 1e-6,
            temperature=max(temperature, 1e-6),
            pad_token_id=getattr(self._tok, "eos_token_id", None),
        )
        out = self._tok.decode(gen[0], skip_special_tokens=True)
        # best-effort: return only after last "Assistant:"
        if "Assistant:" in out:
            out = out.split("Assistant:", 1)[-1].strip()
        return out

    def stream(self, messages: List[Dict[str, str]], *, temperature: float, max_tokens: int):
        self._ensure_loaded()
        assert self._tok is not None and self._model is not None

        from transformers import TextIteratorStreamer  # type: ignore
        import torch  # type: ignore

        prompt = self._format_prompt(messages)
        inputs = self._tok(prompt, return_tensors="pt")
        inputs = {k: v.to(self._model.device) for k, v in inputs.items()}

        streamer = TextIteratorStreamer(self._tok, skip_prompt=True, skip_special_tokens=True)
        kwargs = dict(
            **inputs,
            max_new_tokens=max_tokens,
            do_sample=temperature > 1e-6,
            temperature=max(temperature, 1e-6),
            streamer=streamer,
            pad_token_id=getattr(self._tok, "eos_token_id", None),
        )

        t = threading.Thread(target=self._model.generate, kwargs=kwargs, daemon=True)
        t.start()
        for piece in streamer:
            if piece:
                yield piece


def build_backend(ctx: ToolContext) -> ChatBackend:
    if ctx.backend == "mock":
        return MockBackend()
    if ctx.backend == "transformers":
        if not ctx.model_path:
            # allow running without a model path; mock it
            return MockBackend(model_id="missing-model-path")
        return TransformersBackend(ctx.model_path)
    if ctx.backend == "proxy":
        return MockBackend(model_id="proxy-not-implemented")
    return MockBackend(model_id=f"unknown-backend:{ctx.backend}")


# -------------------------
# HTTP server
# -------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "LLMStudioToolServer/1.1"

    def _ctx(self) -> ToolContext:
        return self.server.ctx  # type: ignore[attr-defined]

    def _send_json(self, code: int, payload: Any, headers: Optional[Dict[str, str]] = None) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        if headers:
            for k, v in headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _send_text(self, code: int, text: str, content_type: str = "text/plain; charset=utf-8") -> None:
        data = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _auth_ok(self) -> bool:
        token = self.headers.get("X-Auth-Token", "")
        return token and token == self._ctx().token

    def _require_auth(self) -> bool:
        if not self._auth_ok():
            self._send_json(401, {"error": "unauthorized"})
            return False
        return True

    def log_message(self, format: str, *args: Any) -> None:
        # Keep logs concise
        sys.stderr.write("%s - - [%s] %s\n" % (self.client_address[0], self.log_date_time_string(), format % args))

    # -------- GET --------
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/health":
            self._send_json(200, {"ok": True, "root": str(self._ctx().root)})
            return

        if path == "/tools":
            # Check if auth is required for tools list
            if self._ctx().require_auth_for_tools_list:
                if not self._require_auth():
                    return
            # Otherwise, allow unauthenticated access (for localhost convenience)
            tools = list_tools(self._ctx())
            # Convert args_schema_json back to dict for compatibility
            for tool in tools:
                if tool.get("args_schema_json"):
                    import json
                    try:
                        tool["input_schema"] = json.loads(tool["args_schema_json"])
                    except:
                        pass
            self._send_json(200, {"tools": tools})
            return

        if path == "/v1/models":
            # Optional auth
            if self._ctx().require_token_for_openai and not self._require_auth():
                return
            backend = self.server.backend  # type: ignore[attr-defined]
            models = backend.list_models()
            self._send_json(
                200,
                {"object": "list", "data": [{"id": mid, "object": "model", "owned_by": "local"} for mid in models]},
            )
            return

        self._send_json(404, {"error": "not_found", "path": path})

    # -------- POST --------
    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(body.decode("utf-8")) if body else {}
        except Exception:
            self._send_json(400, {"error": "invalid_json"})
            return

        if path == "/call":
            if not self._require_auth():
                return
            try:
                name = payload.get("name")
                args = payload.get("args") or {}
                if not name:
                    raise ValueError("name is required")
                result = call_tool(self._ctx(), name, args)
                # Result already has ok/error structure from registry
                if result.get("ok"):
                    self._send_json(200, result)
                else:
                    self._send_json(400, result)
            except PermissionError as e:
                self._send_json(403, {"ok": False, "error": str(e)})
            except Exception as e:
                self._send_json(400, {"ok": False, "error": str(e)})
            return

        if path == "/v1/chat/completions":
            if self._ctx().require_token_for_openai and not self._require_auth():
                return

            # OpenAI chat completions (subset)
            # Request fields: model, messages, temperature, max_tokens, stream
            model = payload.get("model") or "local"
            messages = payload.get("messages") or []
            temperature = float(payload.get("temperature", 0.2))
            max_tokens = int(payload.get("max_tokens", 512))
            stream = bool(payload.get("stream", False))

            backend: ChatBackend = self.server.backend  # type: ignore[attr-defined]

            if not isinstance(messages, list):
                self._send_json(400, {"error": "messages must be a list"})
                return

            created = int(time.time())
            completion_id = f"chatcmpl-{created}-{threading.get_ident()}"

            if not stream:
                try:
                    text = backend.complete(messages, temperature=temperature, max_tokens=max_tokens)
                except Exception as e:
                    self._send_json(500, {"error": str(e)})
                    return

                resp = {
                    "id": completion_id,
                    "object": "chat.completion",
                    "created": created,
                    "model": model,
                    "system_fingerprint": self._ctx().system_fingerprint,
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": text},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                }
                self._send_json(200, resp)
                return

            # Streaming (SSE): data: {json}\n\n ... data: [DONE]\n\n
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()

            def send_sse(obj: Any) -> None:
                chunk = f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode("utf-8")
                try:
                    self.wfile.write(chunk)
                    self.wfile.flush()
                except BrokenPipeError:
                    raise

            # initial chunk (role)
            send_sse(
                {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "system_fingerprint": self._ctx().system_fingerprint,
                    "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
                }
            )

            try:
                for piece in backend.stream(messages, temperature=temperature, max_tokens=max_tokens):
                    if not piece:
                        continue
                    send_sse(
                        {
                            "id": completion_id,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": model,
                            "system_fingerprint": self._ctx().system_fingerprint,
                            "choices": [{"index": 0, "delta": {"content": piece}, "finish_reason": None}],
                        }
                    )
            except BrokenPipeError:
                return
            except Exception as e:
                send_sse(
                    {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model,
                        "choices": [{"index": 0, "delta": {"content": f"\n[server error] {e}"}, "finish_reason": "stop"}],
                    }
                )

            # final
            try:
                send_sse(
                    {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model,
                        "system_fingerprint": self._ctx().system_fingerprint,
                        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                    }
                )
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except BrokenPipeError:
                return
            return

        self._send_json(404, {"error": "not_found", "path": path})


class Server(ThreadingHTTPServer):
    def __init__(self, host: str, port: int, ctx: ToolContext):
        super().__init__((host, port), Handler)
        self.ctx = ctx
        self.backend = build_backend(ctx)


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description="LLM Studio Local Tool + OpenAI API Server")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--root", default=".", help="Workspace root (tools are jailed to this directory)")
    p.add_argument("--token", default="", help="Shared token for /tools and /call")
    p.add_argument("--allow-shell", action="store_true")
    p.add_argument("--allow-write", action="store_true")

    # OpenAI compatibility
    p.add_argument("--require-token-for-openai", action="store_true", help="Require X-Auth-Token for /v1/* endpoints")
    p.add_argument("--backend", choices=["transformers", "proxy", "mock"], default="transformers")
    p.add_argument("--model-path", default="", help="Transformers model path (local folder or HF id if online)")
    p.add_argument("--backend-url", default="", help="Proxy base URL (if backend=proxy)")

    args = p.parse_args(argv)

    root = Path(args.root).resolve()
    token = args.token or os.getenv("LLM_STUDIO_TOOL_TOKEN", "")
    if not token:
        # safe default: still allow /health and /v1/models, but protect /tools and /call
        token = "CHANGE_ME"

    ctx = ToolContext(
        root=root,
        token=token,
        allow_shell=bool(args.allow_shell),
        allow_write=bool(args.allow_write),
        allow_git=True,  # Default True
        allow_network=False,  # Default False
        require_token_for_openai=bool(args.require_token_for_openai),
        backend=args.backend,
        model_path=args.model_path,
        backend_url=args.backend_url,
        enabled_tools={},  # Will be loaded from config if available (via UI)
        require_auth_for_tools_list=False,  # Default False (for CLI, UI sets this)
    )

    srv = Server(args.host, args.port, ctx)
    print(f"[server] root={ctx.root}")
    print(f"[server] listening http://{args.host}:{args.port}")
    print(f"[server] tools auth token required for /tools and /call")
    print(f"[server] openai endpoints available at /v1/models and /v1/chat/completions (stream supported)")
    print(f"[server] backend={ctx.backend} model_path={ctx.model_path!r}")

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
