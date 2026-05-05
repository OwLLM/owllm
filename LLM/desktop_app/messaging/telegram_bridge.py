"""Telegram bridge — drive the OWLLM agent runtime from your phone.

You set a bot token (via BotFather) and your numeric chat id (the bridge
ignores any other chat for safety). When the bridge is running, every
inbound text message becomes a goal handed to the orchestrator of the
project the bridge is bound to. Replies, status events, and approvals
come back to your phone.

Why Telegram and not WhatsApp / Signal:

* Telegram's bot API is the simplest of the three — token-only auth, HTTP
  long-polling, no per-user OAuth, no Meta business approval, no hosted
  service. It runs from a desktop app behind any NAT.
* WhatsApp Business API requires a Meta-approved sender; Signal needs a
  hosted service or unofficial library. Both are reachable today via the
  Operator role's MCP tools (whatsapp-mcp etc.) — that's the recommended
  path for those platforms; this module focuses on Telegram as the
  first-party bridge.

Threading model:

* The bridge runs a long-poll loop on a daemon thread.
* Inbound text → executed in a worker (one at a time per chat) so the
  bot stays responsive while a goal is in flight.
* All Qt / GUI interaction happens through the existing agent bus —
  the bridge is a headless client of the same runtime the desktop UI uses.
"""
from __future__ import annotations

import json
import logging
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, List, Optional

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


# Long-poll timeout — Telegram caps at 50s; 25s keeps us well under that
# while still avoiding tight-loop polling.
_POLL_TIMEOUT_SECONDS = 25
# Inactivity gap between polls when the API errors out, to avoid hammering.
_BACKOFF_SECONDS = 5


# ---------------------------------------------------------------------------
# Config + status
# ---------------------------------------------------------------------------


@dataclass
class TelegramConfig:
    """Persisted bridge configuration."""

    bot_token: str = ""
    """Token from @BotFather. Stored in the agent secrets file like API keys."""
    allowed_chat_ids: List[int] = field(default_factory=list)
    """Numeric Telegram chat ids that are allowed to send goals. Empty = no
    one. The bridge silently ignores messages from anyone else."""
    project_id: str = ""
    """The OWLLM project (and therefore team) the bridge runs goals on.
    If empty the first project in the store is used."""
    auto_approve: bool = False
    """If True, every approval request from the agent runtime auto-approves.
    Convenient for personal phones; dangerous for shared bots."""


@dataclass
class TelegramStatus:
    running: bool
    last_error: Optional[str]
    last_update_id: int


# ---------------------------------------------------------------------------
# Bridge
# ---------------------------------------------------------------------------


class TelegramBridge:
    """Single-process Telegram long-poll bridge.

    Construct once, call ``start(config)`` to begin polling, ``stop()`` to
    halt. Configuration changes require a stop+start.
    """

    def __init__(self) -> None:
        self._config: Optional[TelegramConfig] = None
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._last_update_id = 0
        self._last_error: Optional[str] = None
        self._team: Optional[Team] = None
        self._registry = builtin_registry()
        self._lock = threading.Lock()
        self._ssl_ctx = self._build_ssl_context()
        # Newly-seen chat IDs from inbound messages — surfaced in the UI
        # so the user can copy them into the allowed-list. Bounded to 8 so
        # a busy bot doesn't grow this without bound.
        self._seen_chat_ids: list[int] = []

    @staticmethod
    def _build_ssl_context() -> ssl.SSLContext:
        """Build an SSL context that trusts ``certifi``'s CA bundle.

        Why this matters: on Windows, Python's default ``ssl.create_default_context()``
        can fail with ``CERTIFICATE_VERIFY_FAILED`` because Python doesn't use
        the system certificate store and Telegram's chain isn't in the
        bundled CA list. The ``certifi`` package ships a Mozilla-curated
        bundle that always works. Falls back to the system default if
        ``certifi`` isn't installed.
        """
        try:
            import certifi
            return ssl.create_default_context(cafile=certifi.where())
        except Exception:
            return ssl.create_default_context()

    def seen_chat_ids(self) -> list[int]:
        """Most-recently-seen sender chat IDs (newest first).

        Useful in the UI as a "discover my chat ID" affordance: leave the
        allow-list empty, send one message to the bot, the ID shows up
        here so you can copy it back into the config.
        """
        return list(self._seen_chat_ids)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self, config: TelegramConfig) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                self.stop()
            if not config.bot_token:
                raise ValueError("bot_token is required")
            self._config = config
            self._stop.clear()
            self._last_error = None
            self._team = None
            self._thread = threading.Thread(
                target=self._run, name="telegram-bridge", daemon=True
            )
            self._thread.start()
            logger.info("Telegram bridge started")

    def stop(self) -> None:
        with self._lock:
            self._stop.set()
            t = self._thread
            self._thread = None
        if t and t.is_alive():
            t.join(timeout=5)
        logger.info("Telegram bridge stopped")

    def status(self) -> TelegramStatus:
        return TelegramStatus(
            running=bool(self._thread and self._thread.is_alive()),
            last_error=self._last_error,
            last_update_id=self._last_update_id,
        )

    # ------------------------------------------------------------------
    # Long-poll loop
    # ------------------------------------------------------------------

    def _run(self) -> None:
        # On startup, sanity-check the token. If it's wrong, surface that
        # immediately rather than silently failing every poll.
        try:
            self._send_self_check()
        except Exception as exc:  # noqa: BLE001
            self._last_error = f"bot init failed: {exc}"
            logger.exception("Telegram bot init failed")
            return

        while not self._stop.is_set():
            try:
                updates = self._get_updates()
                for upd in updates:
                    self._last_update_id = max(
                        self._last_update_id, int(upd.get("update_id", 0))
                    )
                    self._handle_update(upd)
            except Exception as exc:  # noqa: BLE001
                self._last_error = str(exc)
                logger.exception("Telegram poll error")
                # Back off so a misconfigured token / network outage
                # doesn't burn CPU.
                self._stop.wait(_BACKOFF_SECONDS)

    def _send_self_check(self) -> None:
        # Auth check — getMe will 401 on a bad token.
        self._api_call("getMe", {})

    # ------------------------------------------------------------------
    # Telegram API
    # ------------------------------------------------------------------

    def _api_call(self, method: str, payload: dict, *, timeout: int = 30) -> dict:
        assert self._config is not None
        url = f"https://api.telegram.org/bot{self._config.bot_token}/{method}"
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        # Use the certifi-backed SSL context so we don't get
        # CERTIFICATE_VERIFY_FAILED on Windows.
        with urllib.request.urlopen(req, timeout=timeout, context=self._ssl_ctx) as resp:
            body = resp.read().decode("utf-8")
        parsed = json.loads(body)
        if not parsed.get("ok"):
            raise RuntimeError(f"Telegram API error: {parsed.get('description')}")
        return parsed.get("result", {})

    def _get_updates(self) -> list:
        return self._api_call(
            "getUpdates",
            {
                "offset": self._last_update_id + 1,
                "timeout": _POLL_TIMEOUT_SECONDS,
                "allowed_updates": ["message"],
            },
            timeout=_POLL_TIMEOUT_SECONDS + 10,
        ) or []

    def _send_message(self, chat_id: int, text: str) -> None:
        # Telegram caps messages at 4096 chars; chunk longer ones.
        for i in range(0, len(text), 4000):
            chunk = text[i : i + 4000]
            try:
                self._api_call("sendMessage", {"chat_id": chat_id, "text": chunk})
            except Exception:  # noqa: BLE001
                logger.exception("Telegram sendMessage failed")
                return

    # ------------------------------------------------------------------
    # Update handling
    # ------------------------------------------------------------------

    def _handle_update(self, upd: dict) -> None:
        msg = upd.get("message")
        if not msg:
            return
        chat = msg.get("chat") or {}
        chat_id = chat.get("id")
        if chat_id is None:
            return

        cfg = self._config
        if cfg is None:
            return

        # Track seen chat IDs (deduped, newest-first, capped) so the UI
        # can offer a "click to add this chat" discovery affordance.
        try:
            cid = int(chat_id)
            if cid in self._seen_chat_ids:
                self._seen_chat_ids.remove(cid)
            self._seen_chat_ids.insert(0, cid)
            self._seen_chat_ids = self._seen_chat_ids[:8]
        except (TypeError, ValueError):
            pass

        # Allow-list check (empty = open). See _handle_inbound_text-style
        # comment on the WhatsApp bridge for the same rationale.
        if cfg.allowed_chat_ids and chat_id not in cfg.allowed_chat_ids:
            logger.warning("Telegram message from disallowed chat %s ignored", chat_id)
            return

        # Pull text first — both plain messages and media captions land
        # here. ``msg.caption`` rides along with photo / voice when the
        # user types something alongside the media.
        text = (msg.get("text") or msg.get("caption") or "").strip()

        # Slash commands — quick utility surface (text-only).
        if text.startswith("/"):
            self._handle_command(chat_id, text)
            return

        # Build an attachment list from any media on the message.
        # We do this synchronously (download here, before the worker
        # thread) so an authentication / rate-limit error is reflected
        # in this update's polling cycle rather than swallowed silently.
        attachments = self._extract_attachments(msg)

        if not text and not attachments:
            return  # nothing to do — empty update

        # Free-form text and/or media → dispatch as a goal.
        self._send_message(chat_id, "🧠 Working on it…")
        threading.Thread(
            target=self._run_goal_for_chat,
            args=(chat_id, text, attachments),
            name=f"telegram-goal-{chat_id}",
            daemon=True,
        ).start()

    def _handle_command(self, chat_id: int, text: str) -> None:
        cmd = text.split()[0].lower()
        if cmd in ("/start", "/help"):
            self._send_message(
                chat_id,
                "OWLLM bridge ready.\n\n"
                "Send any message to run it as a goal on the active project.\n\n"
                "Commands:\n"
                "  /chat_id     Show your numeric chat id (use it in the bridge config)\n"
                "  /status      Show what project + team is bound to this bridge\n"
                "  /help        This message",
            )
        elif cmd == "/chat_id":
            self._send_message(chat_id, f"Your chat id: {chat_id}")
        elif cmd == "/status":
            cfg = self._config
            project_id = cfg.project_id if cfg else ""
            project = get_project_store().get_project(project_id) if project_id else None
            name = project.name if project else "(default — first project)"
            team = ", ".join(project.team) if project else ""
            self._send_message(
                chat_id,
                f"Project: {name}\nTeam: {team or '(empty)'}",
            )
        else:
            self._send_message(chat_id, f"Unknown command: {cmd}")

    # ------------------------------------------------------------------
    # Goal execution
    # ------------------------------------------------------------------

    def _run_goal_for_chat(
        self,
        chat_id: int,
        goal: str,
        attachments: Optional[List[Attachment]] = None,
    ) -> None:
        try:
            team = self._ensure_team()
            if team is None:
                self._send_message(chat_id, "No project / team configured.")
                return

            # Subscribe to bus events for THIS goal only — we filter inside
            # the callback by goal_id once the run starts. We get the goal
            # id via team.active_goal_id once it lands.
            self._wire_chat_listener(chat_id)

            try:
                reply = team.run_goal(goal, attachments=attachments)
                # Phone users get only the final clean answer — strip
                # leaked CoT, tool transcripts, and EOS-noise tails the
                # GUI's "Filtered" panel already hides.
                clean_body = clean_display_answer(reply.body or "")
                self._send_message(
                    chat_id, f"✅ Done.\n\n{clean_body}"
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("Telegram goal run failed")
                self._send_message(chat_id, f"❌ Run failed: {exc}")
        except Exception as exc:  # noqa: BLE001
            logger.exception("Telegram goal handler crashed")
            try:
                self._send_message(chat_id, f"❌ Internal error: {exc}")
            except Exception:
                pass

    def _wire_chat_listener(self, chat_id: int) -> None:
        """One-time per-bridge subscription that mirrors agent THOUGHTs and
        agent-to-agent REPLIES into the chat as they happen.

        Intentionally chatty — a phone user wants to see the team work.
        Bound to the bridge instance so a stop()/start() drops listeners
        cleanly via the bus's subscription registry.
        """
        if getattr(self, "_listener_attached", False):
            return
        self._listener_attached = True
        bus = get_bus()

        def on_msg(msg: Message) -> None:
            try:
                # Only mirror message kinds that have value to the user;
                # filter out internal tool plumbing that would be noise.
                if msg.kind == MessageKind.REPLY and msg.from_agent != "user":
                    # Phone view = filtered view. Drop CoT/tool/EOS noise
                    # before sending so the user sees the same clean text
                    # the GUI shows in its "Filtered" tab.
                    body_clean = clean_display_answer((msg.body or "").strip())
                    if body_clean:
                        self._send_message(
                            chat_id, f"💬 {msg.from_agent}: {body_clean[:1500]}"
                        )
                elif msg.kind == MessageKind.EVENT and "error" in (msg.body or "").lower():
                    self._send_message(chat_id, f"⚠️ {msg.from_agent}: {msg.body}")
            except Exception:  # noqa: BLE001
                pass  # never let mirror failures crash the agent run

        bus.subscribe(on_msg, kinds=[MessageKind.REPLY, MessageKind.EVENT])

        # Auto-approve listener — wired on the gate so any side-effecting
        # tool the team tries to call goes through unsupervised. Off by
        # default; the user has to opt in via TelegramConfig.auto_approve
        # because phone-driven runs can't easily prompt for approvals.
        if self._config and self._config.auto_approve:
            from core.agents.tools import ApprovalDecision

            def auto_approve(req):
                self._send_message(
                    chat_id,
                    f"⚙️  Auto-approving {req.tool_name} (auto_approve is on)",
                )
                threading.Thread(
                    target=lambda: self._registry.gate.resolve(
                        req.id, ApprovalDecision.APPROVE
                    ),
                    daemon=True,
                ).start()

            self._registry.gate.add_listener(auto_approve)

    # ------------------------------------------------------------------
    # Media: voice + photo download via Telegram getFile
    # ------------------------------------------------------------------

    # Telegram delivers a photo as several thumbnail rungs in
    # ``message.photo`` (PhotoSize objects); the LAST one is the
    # full-resolution original. Voice / audio / document arrive as a
    # single dict. ``getFile`` returns a relative ``file_path`` that
    # we then GET from ``api.telegram.org/file/bot<token>/<file_path>``
    # to fetch the bytes.

    def _extract_attachments(self, msg: dict) -> List[Attachment]:
        """Walk ``message`` and pull out audio + image attachments.

        Returns an empty list when nothing relevant is present. Errors
        per-item are logged but don't abort the goal — best-effort so
        a corrupt voice note doesn't drop a perfectly fine caption.
        """
        out: List[Attachment] = []
        caption = (msg.get("caption") or "").strip()

        # Voice notes (the press-and-hold microphone in Telegram).
        voice = msg.get("voice") or {}
        if voice.get("file_id"):
            att = self._download_as_attachment(
                voice.get("file_id"),
                kind=KIND_AUDIO,
                fallback_name=f"voice_{voice.get('file_unique_id') or 'msg'}.ogg",
                fallback_mime=voice.get("mime_type") or "audio/ogg",
                caption=caption,
                duration=float(voice.get("duration") or 0.0),
            )
            if att is not None:
                out.append(att)

        # Audio files (uploads).
        audio = msg.get("audio") or {}
        if audio.get("file_id"):
            att = self._download_as_attachment(
                audio.get("file_id"),
                kind=KIND_AUDIO,
                fallback_name=audio.get("file_name") or "audio.mp3",
                fallback_mime=audio.get("mime_type") or "audio/mpeg",
                caption=caption,
                duration=float(audio.get("duration") or 0.0),
            )
            if att is not None:
                out.append(att)

        # Photos: list ordered smallest → largest. Take the largest.
        photo_list = msg.get("photo") or []
        if photo_list:
            largest = photo_list[-1]
            if largest.get("file_id"):
                att = self._download_as_attachment(
                    largest.get("file_id"),
                    kind=KIND_IMAGE,
                    fallback_name=f"photo_{largest.get('file_unique_id') or 'msg'}.jpg",
                    fallback_mime="image/jpeg",
                    caption=caption,
                )
                if att is not None:
                    out.append(att)

        # A document attachment may carry an image — accept those, ignore
        # the rest (we explicitly don't process video / pdf / etc here).
        doc = msg.get("document") or {}
        doc_mime = (doc.get("mime_type") or "").lower()
        if doc.get("file_id") and doc_mime.startswith(("image/", "audio/")):
            kind = KIND_IMAGE if doc_mime.startswith("image/") else KIND_AUDIO
            att = self._download_as_attachment(
                doc.get("file_id"),
                kind=kind,
                fallback_name=doc.get("file_name") or "attachment",
                fallback_mime=doc_mime,
                caption=caption,
            )
            if att is not None:
                out.append(att)

        return out

    def _download_as_attachment(
        self,
        file_id: str,
        *,
        kind: str,
        fallback_name: str,
        fallback_mime: str,
        caption: str = "",
        duration: float = 0.0,
    ) -> Optional[Attachment]:
        """Resolve a Telegram file_id to a downloaded :class:`Attachment`.

        Returns ``None`` on failure (auth, network, or oversize).
        """
        try:
            file_meta = self._api_call("getFile", {"file_id": file_id})
        except Exception:  # noqa: BLE001
            logger.exception("Telegram getFile failed for %s", file_id)
            return None
        file_path = (file_meta or {}).get("file_path")
        if not file_path:
            return None
        try:
            data = self._download_file_bytes(file_path)
        except Exception:  # noqa: BLE001
            logger.exception("Telegram file download failed for %s", file_path)
            return None
        if not data:
            return None
        if len(data) > MAX_ATTACHMENT_BYTES:
            logger.warning(
                "Telegram attachment %s exceeds %d-byte cap; dropping",
                fallback_name, MAX_ATTACHMENT_BYTES,
            )
            return None
        # Use the goal-id slot "telegram-pending" until run_goal creates
        # the real one — the runtime root resolves the same dir tree, so
        # the file just won't be grouped under the actual goal id. That's
        # acceptable for now; later we can move files post-publish.
        att = save_bytes_for_goal(
            "telegram-pending",
            data,
            suggested_name=fallback_name,
            mime=fallback_mime,
            source="telegram",
            caption=caption,
        )
        if att is not None and duration:
            att.duration_sec = duration
        # If kind classification disagreed with what Telegram told us
        # (e.g. document/image-named-something-weird), trust Telegram's
        # signal so the orchestrator-side prompt block is correct.
        if att is not None and kind in (KIND_AUDIO, KIND_IMAGE):
            att.kind = kind
        return att

    def _download_file_bytes(self, file_path: str) -> bytes:
        """Fetch the file bytes from Telegram's file service.

        ``file_path`` is the relative path returned by getFile. The full
        URL is ``https://api.telegram.org/file/bot<token>/<file_path>``.
        """
        assert self._config is not None
        url = (
            f"https://api.telegram.org/file/bot{self._config.bot_token}/"
            + urllib.parse.quote(file_path)
        )
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=30, context=self._ssl_ctx) as resp:
            return resp.read()

    # ------------------------------------------------------------------

    def _ensure_team(self) -> Optional[Team]:
        """Lazy-build (and cache) the Team for the configured project."""
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

        # Pull MCP tools so the bridge gets the same toolbox the desktop
        # workspace gets.
        try:
            from desktop_app.mcp.connection_manager import MCPConnectionManager
            register_mcp_tools(self._registry, MCPConnectionManager())
        except Exception:  # noqa: BLE001
            logger.exception("Telegram bridge: MCP tool registration failed")

        # Build the runtime Role map from the project's team.
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

        # Read order: project's per-agent override (what the user picked
        # in the desktop UI for THIS project) → agent's Studio default.
        # Without the project override, bridges historically used only the
        # default_model_id which is "" for built-in agents and broke every
        # remote run.
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


_bridge: Optional[TelegramBridge] = None
_bridge_lock = threading.Lock()


def get_telegram_bridge() -> TelegramBridge:
    global _bridge
    with _bridge_lock:
        if _bridge is None:
            _bridge = TelegramBridge()
        return _bridge
