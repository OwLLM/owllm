"""WhatsApp bridge — Meta Cloud API.

Same shape as the Telegram bridge: inbound message → goal → reply, with
the team running on the configured project. Differences from Telegram:

* **Auth model** — Cloud API uses an access token + phone_number_id (the
  business sender) + verify_token (handshake string the user invents).
  All three live in the local secrets file like API keys.
* **Inbound delivery is webhook-only** — Meta does not expose long-polling.
  This module embeds an :mod:`http.server` that listens on a configurable
  port for ``GET`` (verify handshake) and ``POST`` (incoming messages).
  Because most users run OWLLM behind NAT, the README of this module
  recommends pairing it with ``cloudflared tunnel`` / ``ngrok`` / similar
  to expose the local port at a public HTTPS URL Meta can reach.
* **Outbound** — direct HTTPS POST to ``graph.facebook.com``; works
  without any tunnel.

If you don't want the inbound complexity, the simpler path is to use the
existing whatsapp-mcp MCP server through the Operator role — the
``OPERATOR`` agent can already send/receive messages via that pathway.
This module exists for users who want a *first-party* WhatsApp inbox
that drives the orchestrator directly.
"""
from __future__ import annotations

import json
import logging
import ssl
import threading
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import List, Optional

from core.agents.attachments import (
    Attachment,
    KIND_AUDIO,
    KIND_IMAGE,
    MAX_ATTACHMENT_BYTES,
    save_bytes_for_goal,
)
from core.agents.backends import dispatch_model_fn
from core.agents.bus import get_bus
from core.agents.message import Message, MessageKind
from core.agents.orchestrator import Team, build_team
from core.agents.projects import Project, get_project_store
from core.agents.tools import builtin_registry, register_mcp_tools
from core.agents.agent_definitions import list_all_definitions
from core.inference import clean_display_answer

logger = logging.getLogger(__name__)


_GRAPH_API_VERSION = "v20.0"
_GRAPH_BASE = f"https://graph.facebook.com/{_GRAPH_API_VERSION}"


# ---------------------------------------------------------------------------
# Config + status
# ---------------------------------------------------------------------------


@dataclass
class WhatsAppConfig:
    """Persisted bridge configuration."""

    access_token: str = ""
    """Cloud API access token from the Meta App's WhatsApp section."""
    phone_number_id: str = ""
    """The business sender's phone-number id (NOT the phone number itself)."""
    verify_token: str = ""
    """Arbitrary string Meta echoes during webhook setup; we compare both."""
    webhook_port: int = 8911
    """Local port the embedded webhook server listens on."""
    webhook_host: str = "0.0.0.0"
    """Bind host. ``0.0.0.0`` so a tunnel client can reach it from outside."""
    allowed_senders: List[str] = field(default_factory=list)
    """E.164 phone numbers (digits only, e.g. '393331234567') allowed to
    send goals. Empty list means no one — explicit allow-list, not deny."""
    project_id: str = ""
    """The OWLLM project (and team) the bridge runs goals on."""
    auto_approve: bool = False
    """If True, every approval request from the agent runtime auto-approves."""


@dataclass
class WhatsAppStatus:
    running: bool
    last_error: Optional[str]
    bind: str  # "0.0.0.0:8911"


# ---------------------------------------------------------------------------
# HTTP request handler
# ---------------------------------------------------------------------------


class _WebhookHandler(BaseHTTPRequestHandler):
    """Per-request handler for the embedded webhook server.

    The bridge instance is attached to the server via ``server.bridge`` so
    each request finds the right config. Spec for the two URL paths:

    GET /:    Meta verify-handshake. Query params:
              hub.mode = "subscribe"
              hub.verify_token = matches our config
              hub.challenge = string to echo back as 200 body.

    POST /:   Inbound webhook. Body is the standard graph.facebook.com
              messaging payload. We only care about ``messages[*].text``
              for the v1 bridge.
    """

    # Quiet by default — every Meta retry would otherwise spam the log.
    def log_message(self, format, *args):  # noqa: A003
        logger.debug("whatsapp webhook: " + format, *args)

    def do_GET(self):  # noqa: N802
        bridge: WhatsAppBridge = self.server.bridge
        try:
            qs = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(qs)
            mode = (params.get("hub.mode") or [""])[0]
            token = (params.get("hub.verify_token") or [""])[0]
            challenge = (params.get("hub.challenge") or [""])[0]
            if mode == "subscribe" and bridge._config and token == bridge._config.verify_token:
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(challenge.encode("utf-8"))
                return
        except Exception:  # noqa: BLE001
            logger.exception("whatsapp webhook GET failed")
        self.send_response(403)
        self.end_headers()

    def do_POST(self):  # noqa: N802
        bridge: WhatsAppBridge = self.server.bridge
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length > 0 else b""
            payload = json.loads(body or b"{}")
            # Always 200 immediately so Meta doesn't retry and double-fire.
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"ok")
            # Process out of band to keep the response cycle snappy.
            threading.Thread(
                target=bridge._process_webhook_payload,
                args=(payload,),
                daemon=True,
                name="whatsapp-process",
            ).start()
        except Exception:  # noqa: BLE001
            logger.exception("whatsapp webhook POST failed")
            try:
                self.send_response(500)
                self.end_headers()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Bridge
# ---------------------------------------------------------------------------


class WhatsAppBridge:
    """Embedded HTTP webhook + Cloud API client.

    Construct once, ``start(config)`` brings up the webhook listener,
    ``stop()`` shuts it down. Configuration changes require a stop+start.
    """

    def __init__(self) -> None:
        self._config: Optional[WhatsAppConfig] = None
        self._server: Optional[ThreadingHTTPServer] = None
        self._server_thread: Optional[threading.Thread] = None
        self._team: Optional[Team] = None
        self._registry = builtin_registry()
        self._last_error: Optional[str] = None
        self._lock = threading.Lock()
        self._listener_attached = False
        self._ssl_ctx = self._build_ssl_context()

    @staticmethod
    def _build_ssl_context() -> ssl.SSLContext:
        """Same Windows-friendly TLS handling as the Telegram bridge —
        use ``certifi``'s CA bundle so outbound calls to graph.facebook.com
        don't trip CERTIFICATE_VERIFY_FAILED on Windows."""
        try:
            import certifi
            return ssl.create_default_context(cafile=certifi.where())
        except Exception:
            return ssl.create_default_context()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self, config: WhatsAppConfig) -> None:
        with self._lock:
            if self._server is not None:
                self.stop()
            if not config.access_token or not config.phone_number_id:
                raise ValueError("access_token and phone_number_id are required")
            if not config.verify_token:
                raise ValueError("verify_token is required (any string Meta will echo)")
            self._config = config
            self._team = None
            self._listener_attached = False
            self._last_error = None

            try:
                server = ThreadingHTTPServer(
                    (config.webhook_host, int(config.webhook_port)),
                    _WebhookHandler,
                )
            except OSError as exc:
                self._last_error = f"could not bind {config.webhook_host}:{config.webhook_port}: {exc}"
                raise

            server.bridge = self  # type: ignore[attr-defined]
            self._server = server
            self._server_thread = threading.Thread(
                target=server.serve_forever,
                kwargs={"poll_interval": 0.5},
                name="whatsapp-bridge",
                daemon=True,
            )
            self._server_thread.start()
            logger.info(
                "WhatsApp bridge listening on %s:%s", config.webhook_host, config.webhook_port
            )

    def stop(self) -> None:
        with self._lock:
            srv = self._server
            self._server = None
            t = self._server_thread
            self._server_thread = None
        if srv is not None:
            try:
                srv.shutdown()
                srv.server_close()
            except Exception:
                logger.exception("WhatsApp bridge shutdown error")
        if t and t.is_alive():
            t.join(timeout=5)
        logger.info("WhatsApp bridge stopped")

    def status(self) -> WhatsAppStatus:
        cfg = self._config
        bind = (
            f"{cfg.webhook_host}:{cfg.webhook_port}" if cfg else "—"
        )
        running = bool(
            self._server is not None and self._server_thread and self._server_thread.is_alive()
        )
        return WhatsAppStatus(running=running, last_error=self._last_error, bind=bind)

    # ------------------------------------------------------------------
    # Outbound
    # ------------------------------------------------------------------

    def send_text(self, to_phone: str, text: str) -> dict:
        """Send a plain-text message to a recipient.

        ``to_phone`` is digits only (E.164 without the leading +). Returns
        Meta's response on success, raises on failure. Used both internally
        (for replies) and exposable as an agent tool.
        """
        cfg = self._config
        if cfg is None or not cfg.access_token or not cfg.phone_number_id:
            raise RuntimeError("WhatsApp bridge not configured")
        url = f"{_GRAPH_BASE}/{cfg.phone_number_id}/messages"
        body = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to_phone,
            "type": "text",
            "text": {"body": text[:4096]},  # WhatsApp text body cap
        }
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {cfg.access_token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=15, context=self._ssl_ctx) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            err = exc.read().decode("utf-8", errors="replace") if exc.fp else str(exc)
            raise RuntimeError(f"WhatsApp API HTTP {exc.code}: {err[:300]}")
        except urllib.error.URLError as exc:
            raise RuntimeError(f"WhatsApp API network error: {exc.reason}")

    # ------------------------------------------------------------------
    # Inbound
    # ------------------------------------------------------------------

    def _process_webhook_payload(self, payload: dict) -> None:
        """Walk the Meta webhook envelope and dispatch each user-message.

        Skips delivery-receipt entries and status notifications. Handles
        text, audio (voice notes + uploaded audio), and image messages;
        anything else (sticker / location / video / document / contact)
        is ignored with a debug log so the user can tell why nothing
        happened from the desktop logs.
        """
        try:
            for entry in payload.get("entry") or []:
                for change in entry.get("changes") or []:
                    value = change.get("value") or {}
                    for msg in value.get("messages") or []:
                        sender = msg.get("from") or ""
                        if not sender:
                            continue
                        mtype = (msg.get("type") or "").lower()
                        if mtype == "text":
                            text = ((msg.get("text") or {}).get("body") or "").strip()
                            if text:
                                self._handle_inbound(sender, text, [])
                        elif mtype in ("audio", "voice", "image"):
                            text, attachments = self._extract_media(mtype, msg)
                            if text or attachments:
                                self._handle_inbound(sender, text, attachments)
                        else:
                            logger.debug("WhatsApp ignoring message type=%s", mtype)
        except Exception:  # noqa: BLE001
            logger.exception("WhatsApp webhook processing failed")

    def _handle_inbound(
        self,
        sender: str,
        text: str,
        attachments: List[Attachment],
    ) -> None:
        cfg = self._config
        if cfg is None:
            return
        if cfg.allowed_senders and sender not in cfg.allowed_senders:
            logger.warning("WhatsApp message from disallowed sender %s ignored", sender)
            return
        if text.startswith("/") and not attachments:
            self._handle_command(sender, text)
            return

        try:
            self.send_text(sender, "🧠 Working on it…")
        except Exception:  # noqa: BLE001
            logger.exception("could not send WhatsApp ack")

        threading.Thread(
            target=self._run_goal_for_sender,
            args=(sender, text, attachments),
            daemon=True,
            name=f"whatsapp-goal-{sender}",
        ).start()

    def _handle_command(self, sender: str, text: str) -> None:
        cmd = text.split()[0].lower()
        try:
            if cmd in ("/help", "/start"):
                self.send_text(
                    sender,
                    "OWLLM bridge ready.\n\nSend any message to run it as a goal.\n\n"
                    "Commands:\n  /from   show your sender id\n  /status project + team\n  /help",
                )
            elif cmd == "/from":
                self.send_text(sender, f"Your sender id: {sender}")
            elif cmd == "/status":
                cfg = self._config
                project_id = cfg.project_id if cfg else ""
                project = get_project_store().get_project(project_id) if project_id else None
                name = project.name if project else "(default — first project)"
                team = ", ".join(project.team) if project else ""
                self.send_text(sender, f"Project: {name}\nTeam: {team or '(empty)'}")
            else:
                self.send_text(sender, f"Unknown command: {cmd}")
        except Exception:  # noqa: BLE001
            logger.exception("WhatsApp command reply failed")

    def _run_goal_for_sender(
        self,
        sender: str,
        goal: str,
        attachments: Optional[List[Attachment]] = None,
    ) -> None:
        try:
            team = self._ensure_team()
            if team is None:
                self.send_text(sender, "No project / team configured.")
                return
            self._wire_chat_listener(sender)
            try:
                reply = team.run_goal(goal, attachments=attachments)
                # Phone view = filtered view. Strip CoT / tool transcripts /
                # EOS noise so what lands on WhatsApp matches the GUI's
                # "Filtered" panel, not the raw model dump.
                clean_body = clean_display_answer(reply.body or "")
                self.send_text(sender, f"✅ Done.\n\n{clean_body}")
            except Exception as exc:  # noqa: BLE001
                logger.exception("WhatsApp goal run failed")
                try:
                    self.send_text(sender, f"❌ Run failed: {exc}")
                except Exception:
                    pass
        except Exception as exc:  # noqa: BLE001
            logger.exception("WhatsApp goal handler crashed")
            try:
                self.send_text(sender, f"❌ Internal error: {exc}")
            except Exception:
                pass

    def _wire_chat_listener(self, sender: str) -> None:
        """Mirror agent REPLY / ERROR messages to WhatsApp as they happen."""
        if self._listener_attached:
            return
        self._listener_attached = True
        bus = get_bus()

        def on_msg(msg: Message) -> None:
            try:
                if msg.kind == MessageKind.REPLY and msg.from_agent != "user":
                    body_clean = clean_display_answer((msg.body or "").strip())
                    if body_clean:
                        self.send_text(
                            sender, f"💬 {msg.from_agent}: {body_clean[:1500]}"
                        )
                elif msg.kind == MessageKind.EVENT and "error" in (msg.body or "").lower():
                    self.send_text(sender, f"⚠️ {msg.from_agent}: {msg.body}")
            except Exception:  # noqa: BLE001
                pass

        bus.subscribe(on_msg, kinds=[MessageKind.REPLY, MessageKind.EVENT])

        if self._config and self._config.auto_approve:
            from core.agents.tools import ApprovalDecision

            def auto_approve(req):
                try:
                    self.send_text(
                        sender, f"⚙️  Auto-approving {req.tool_name} (auto_approve is on)"
                    )
                except Exception:
                    pass
                threading.Thread(
                    target=lambda: self._registry.gate.resolve(
                        req.id, ApprovalDecision.APPROVE
                    ),
                    daemon=True,
                ).start()

            self._registry.gate.add_listener(auto_approve)

    # ------------------------------------------------------------------
    # Media: audio + image download via the Cloud API two-step
    # ------------------------------------------------------------------
    #
    # Meta's Cloud API delivers media as a ``media_id`` that you must
    # exchange for a short-lived download URL:
    #
    #   GET /{media-id}                  → JSON with {"url": "...", "mime_type": ...}
    #   GET <that url> with Bearer auth  → the actual bytes
    #
    # Both calls require the access_token. The download URL is signed
    # and expires in ~5 minutes, so we fetch + persist immediately.

    def _extract_media(self, mtype: str, msg: dict) -> tuple[str, List[Attachment]]:
        """Pull an audio or image attachment off a WhatsApp message.

        ``mtype`` is the message envelope type — already filtered to
        one of ``audio`` / ``voice`` / ``image`` by the caller. Returns
        ``(text_caption, attachments)`` so a captioned image surfaces
        the caption to the orchestrator alongside the image.
        """
        if mtype in ("audio", "voice"):
            block = msg.get(mtype) or {}
            media_id = block.get("id")
            if not media_id:
                return "", []
            mime = block.get("mime_type") or "audio/ogg"
            kind = KIND_AUDIO
            fallback_name = f"voice_{media_id[:8]}.ogg" if mtype == "voice" else f"audio_{media_id[:8]}.bin"
            caption = ""
        elif mtype == "image":
            block = msg.get("image") or {}
            media_id = block.get("id")
            if not media_id:
                return "", []
            mime = block.get("mime_type") or "image/jpeg"
            kind = KIND_IMAGE
            fallback_name = f"image_{media_id[:8]}.jpg"
            caption = (block.get("caption") or "").strip()
        else:
            return "", []

        att = self._download_media_as_attachment(
            media_id,
            kind=kind,
            fallback_name=fallback_name,
            fallback_mime=mime,
            caption=caption,
        )
        if att is None:
            return caption, []
        return caption, [att]

    def _download_media_as_attachment(
        self,
        media_id: str,
        *,
        kind: str,
        fallback_name: str,
        fallback_mime: str,
        caption: str = "",
    ) -> Optional[Attachment]:
        cfg = self._config
        if cfg is None or not cfg.access_token:
            return None
        try:
            meta = self._graph_get(f"/{media_id}")
        except Exception:  # noqa: BLE001
            logger.exception("WhatsApp media metadata fetch failed for %s", media_id)
            return None
        url = meta.get("url")
        if not url:
            return None
        mime = meta.get("mime_type") or fallback_mime
        try:
            data = self._graph_get_bytes(url)
        except Exception:  # noqa: BLE001
            logger.exception("WhatsApp media download failed for %s", media_id)
            return None
        if not data:
            return None
        if len(data) > MAX_ATTACHMENT_BYTES:
            logger.warning(
                "WhatsApp attachment %s exceeds %d-byte cap; dropping",
                fallback_name, MAX_ATTACHMENT_BYTES,
            )
            return None
        att = save_bytes_for_goal(
            "whatsapp-pending",
            data,
            suggested_name=fallback_name,
            mime=mime,
            source="whatsapp",
            caption=caption,
        )
        if att is not None and kind in (KIND_AUDIO, KIND_IMAGE):
            att.kind = kind
        return att

    def _graph_get(self, path: str, *, timeout: int = 15) -> dict:
        """GET a Graph API endpoint (path beginning with ``/``) as JSON."""
        cfg = self._config
        assert cfg is not None
        url = f"{_GRAPH_BASE}{path}"
        req = urllib.request.Request(
            url,
            method="GET",
            headers={"Authorization": f"Bearer {cfg.access_token}"},
        )
        with urllib.request.urlopen(req, timeout=timeout, context=self._ssl_ctx) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _graph_get_bytes(self, url: str, *, timeout: int = 30) -> bytes:
        """GET an absolute Graph URL with bearer auth, returning raw bytes."""
        cfg = self._config
        assert cfg is not None
        req = urllib.request.Request(
            url,
            method="GET",
            headers={"Authorization": f"Bearer {cfg.access_token}"},
        )
        with urllib.request.urlopen(req, timeout=timeout, context=self._ssl_ctx) as resp:
            return resp.read()

    # ------------------------------------------------------------------
    # Team
    # ------------------------------------------------------------------

    def _ensure_team(self) -> Optional[Team]:
        if self._team is not None:
            return self._team
        cfg = self._config
        if cfg is None:
            return None
        store = get_project_store()
        project: Optional[Project] = None
        if cfg.project_id:
            project = store.get_project(cfg.project_id)
        if project is None:
            projects = store.list_projects()
            project = projects[0] if projects else None
        if project is None or not project.team:
            return None

        try:
            from desktop_app.mcp.connection_manager import MCPConnectionManager
            register_mcp_tools(self._registry, MCPConnectionManager())
        except Exception:  # noqa: BLE001
            logger.exception("WhatsApp bridge: MCP tool registration failed")

        defs = list_all_definitions()
        from core.agents.roles.loader import Role
        roles = {}
        for name in project.team:
            d = defs.get(name)
            if d is None:
                continue
            roles[name] = Role(
                name=d.name,
                description=d.description,
                system_prompt=d.system_prompt,
                tool_allowlist=(
                    list(d.tool_allowlist) + list(d.mcp_allowlist or [])
                    if d.tool_allowlist is not None or d.mcp_allowlist is not None
                    else None
                ),
                can_dispatch=d.can_dispatch,
                default_temperature=d.default_temperature,
                icon=d.icon,
            )
        if not roles:
            return None

        # Same read-order logic as the Telegram bridge — see that
        # module for the rationale on why the per-project override beats
        # the agent's Studio default.
        overrides = project.model_overrides or {}

        def model_id_for(role_name: str) -> str:
            override = overrides.get(role_name)
            if override:
                return override
            d = defs.get(role_name)
            return d.default_model_id if d else ""

        self._team = build_team(
            get_bus(),
            roles=roles,
            model_id_for=model_id_for,
            model_fn=dispatch_model_fn,
            base_registry=self._registry,
        )
        return self._team


# ---------------------------------------------------------------------------
# Process-wide singleton
# ---------------------------------------------------------------------------


_bridge: Optional[WhatsAppBridge] = None
_bridge_lock = threading.Lock()


def get_whatsapp_bridge() -> WhatsAppBridge:
    global _bridge
    with _bridge_lock:
        if _bridge is None:
            _bridge = WhatsAppBridge()
        return _bridge
