"""Stable-port HTTP proxy that fronts OWLLM's currently-active model.

Cline (and any other VSCodium agent extension) wants a single, fixed
``baseUrl`` in its settings — ``http://127.0.0.1:9999/v1``. OWLLM, however,
binds each loaded model to a per-model port (9100, 9101, …) which changes
when the user swaps which model is loaded. This proxy bridges the two:
Cline always talks to ``9999``; ``set_target_url(url)`` redirects upstream
to whichever OWLLM model port is live.

Streaming responses (Server-Sent Events for chat) are forwarded chunk-by-
chunk so token-by-token rendering inside Cline still works.

Implementation notes:
- Uses stdlib ``http.server.ThreadingHTTPServer`` + ``urllib.request`` to
  avoid pulling extra dependencies. ``urllib`` supports streaming reads
  via ``response.read(chunk_size)``.
- Singleton via module-level ``_INSTANCE``. ``ensure_started()`` is
  idempotent.
- Daemon thread, dies with the OWLLM process.
- 503 returned when no upstream is set (model not loaded yet) — Cline's
  retry logic handles this gracefully once the user starts a model.
"""
from __future__ import annotations

import http.server
import logging
import threading
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

logger = logging.getLogger(__name__)


PROXY_HOST = "127.0.0.1"
PROXY_PORT = 9999
PROXY_BASE_URL = f"http://{PROXY_HOST}:{PROXY_PORT}/v1"

# Hop-by-hop headers (RFC 7230 §6.1) that must not be forwarded.
_HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
}


class _State:
    target_url: Optional[str] = None
    lock = threading.Lock()


def set_target_url(url: Optional[str]) -> None:
    """Point the proxy at ``url`` (an OpenAI-compatible base, e.g.
    ``http://127.0.0.1:9100/v1``). ``None`` puts the proxy in 503 mode."""
    with _State.lock:
        if url and url.endswith("/"):
            url = url.rstrip("/")
        _State.target_url = url
        logger.info("cline_proxy target -> %s", url)


def get_target_url() -> Optional[str]:
    with _State.lock:
        return _State.target_url


class _Handler(http.server.BaseHTTPRequestHandler):
    # Shut up the noisy default request logger
    def log_message(self, format: str, *args) -> None:  # noqa: A002
        logger.debug("cline_proxy %s - " + format, self.address_string(), *args)

    def _proxy(self, method: str) -> None:
        target = get_target_url()
        if target is None:
            # NOTE: keep the reason phrase ASCII-only — http.client encodes
            # the status line as latin-1 and any non-latin-1 char (e.g. em
            # dash) crashes the response before headers are sent.
            self.send_error(503, "OWLLM has no model loaded - start one in the Server tab.")
            return

        # Cline's settings hard-code "/v1/...". We accept either with or
        # without "/v1" prefix and route to the upstream's "/v1/..." path.
        path = self.path
        if path.startswith("/v1/"):
            path = path[len("/v1"):]
        upstream = target.rstrip("/")
        if not upstream.endswith("/v1"):
            upstream = f"{upstream}/v1"
        url = f"{upstream}{path}"

        # Read request body if any.
        body: Optional[bytes] = None
        cl = self.headers.get("Content-Length")
        if cl is not None:
            try:
                body = self.rfile.read(int(cl))
            except Exception:
                body = b""

        # Forward all non-hop-by-hop headers.
        fwd_headers = {
            k: v for k, v in self.headers.items()
            if k.lower() not in _HOP_BY_HOP
        }

        req = urllib.request.Request(url, data=body, method=method, headers=fwd_headers)
        try:
            resp = urllib.request.urlopen(req, timeout=600)  # generous, chat completions can take a while
        except urllib.error.HTTPError as e:
            # Forward upstream HTTP errors verbatim with their body.
            try:
                self.send_response(e.code)
                for k, v in e.headers.items():
                    if k.lower() in _HOP_BY_HOP:
                        continue
                    self.send_header(k, v)
                self.end_headers()
                try:
                    self.wfile.write(e.read())
                except Exception:
                    pass
            except (BrokenPipeError, ConnectionResetError, OSError):
                # Client (Cline) disconnected before we could write — nothing
                # actionable; suppress to keep logs clean.
                pass
            return
        except (urllib.error.URLError, OSError) as e:
            # Upstream is gone or reset the connection (commonly: model server
            # crashed mid-request, e.g. when loaded on CPU and OOM'd on a
            # large prompt). send_error itself can raise BrokenPipe if the
            # caller has already disconnected — wrap it.
            try:
                self.send_error(502, f"Upstream unreachable: {e}")
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            return

        # Stream the response body. Don't trust Content-Length on streaming
        # responses — chunked transfer is common for SSE.
        self.send_response(resp.status)
        upstream_headers = dict(resp.headers.items())
        for k, v in upstream_headers.items():
            if k.lower() in _HOP_BY_HOP:
                continue
            self.send_header(k, v)
        self.end_headers()

        # Use read1() so each upstream packet — typically one SSE token from
        # llama-server — flushes downstream immediately. Plain read(4096) waits
        # until 4096 bytes accumulate, which on slow CPU inference can take
        # tens of seconds and makes Cline give up before the first token.
        try:
            reader = getattr(resp, "read1", None) or resp.read
            while True:
                chunk = reader(4096)
                if not chunk:
                    break
                self.wfile.write(chunk)
                try:
                    self.wfile.flush()
                except Exception:
                    break
        except Exception:
            # Client likely disconnected mid-stream; nothing actionable.
            pass

    # Map every common verb through _proxy
    def do_GET(self) -> None:
        self._proxy("GET")

    def do_POST(self) -> None:
        self._proxy("POST")

    def do_PUT(self) -> None:
        self._proxy("PUT")

    def do_DELETE(self) -> None:
        self._proxy("DELETE")

    def do_OPTIONS(self) -> None:
        # CORS preflight. Just allow everything from the embedded VSCodium —
        # it's local-only.
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()


_INSTANCE: Optional[http.server.ThreadingHTTPServer] = None
_THREAD: Optional[threading.Thread] = None
_START_LOCK = threading.Lock()


def ensure_started() -> None:
    """Start the proxy server (idempotent)."""
    global _INSTANCE, _THREAD
    with _START_LOCK:
        if _INSTANCE is not None:
            return
        try:
            srv = http.server.ThreadingHTTPServer((PROXY_HOST, PROXY_PORT), _Handler)
        except OSError as e:
            logger.warning("cline_proxy could not bind %s:%d (%s)", PROXY_HOST, PROXY_PORT, e)
            return
        srv.daemon_threads = True
        _INSTANCE = srv
        _THREAD = threading.Thread(target=srv.serve_forever, name="cline_proxy", daemon=True)
        _THREAD.start()
        logger.info("cline_proxy listening on %s", PROXY_BASE_URL)


def stop() -> None:
    """Shut the proxy down (best-effort)."""
    global _INSTANCE, _THREAD
    with _START_LOCK:
        srv, _INSTANCE = _INSTANCE, None
        thr, _THREAD = _THREAD, None
    if srv is not None:
        try:
            srv.shutdown()
            srv.server_close()
        except Exception:
            pass
    # Thread is daemon, will exit on shutdown signal.


__all__ = [
    "PROXY_HOST",
    "PROXY_PORT",
    "PROXY_BASE_URL",
    "ensure_started",
    "stop",
    "set_target_url",
    "get_target_url",
]
