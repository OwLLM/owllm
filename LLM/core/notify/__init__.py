"""External notifications when the team needs the user.

Pluggable backends (Telegram first). Configuration lives in QSettings
under ``notify/<key>`` so the UI can drive it without new files. A
disabled backend silently no-ops, so the calling code never has to care.
"""
from __future__ import annotations

import logging
import threading
import urllib.parse
import urllib.request
from typing import Optional

from PySide6.QtCore import QSettings

logger = logging.getLogger(__name__)


KEY_BACKEND = "notify/backend"        # "" | "telegram"
KEY_TG_TOKEN = "notify/telegram_token"
KEY_TG_CHAT_ID = "notify/telegram_chat_id"


class _NoopNotifier:
    name = "noop"

    def notify(self, title: str, body: str) -> bool:
        return False


class _TelegramNotifier:
    name = "telegram"

    def __init__(self, token: str, chat_id: str) -> None:
        self._token = token
        self._chat_id = chat_id

    def notify(self, title: str, body: str) -> bool:
        if not self._token or not self._chat_id:
            return False
        text = f"*{title}*\n\n{body}" if title else body
        url = f"https://api.telegram.org/bot{self._token}/sendMessage"
        data = urllib.parse.urlencode({
            "chat_id": self._chat_id,
            "text": text,
            "parse_mode": "Markdown",
        }).encode("utf-8")
        try:
            with urllib.request.urlopen(url, data=data, timeout=8) as resp:
                ok = (resp.status == 200)
                if not ok:
                    logger.warning("telegram notify status=%s", resp.status)
                return ok
        except Exception as e:
            logger.warning("telegram notify failed: %s", e)
            return False


def get_notifier(settings: Optional[QSettings] = None):
    """Return the active notifier; falls back to a no-op when nothing's
    configured. Always cheap to call."""
    s = settings or QSettings()
    backend = (s.value(KEY_BACKEND, "") or "").strip()
    if backend == "telegram":
        token = (s.value(KEY_TG_TOKEN, "") or "").strip()
        chat = (s.value(KEY_TG_CHAT_ID, "") or "").strip()
        if token and chat:
            return _TelegramNotifier(str(token), str(chat))
    return _NoopNotifier()


def notify_async(title: str, body: str) -> None:
    """Fire-and-forget on a daemon thread. Errors are swallowed —
    notification failure must never propagate into the agent loop."""
    n = get_notifier()
    if isinstance(n, _NoopNotifier):
        return

    def _go():
        try:
            n.notify(title, body)
        except Exception:
            logger.exception("notifier raised unexpectedly")

    threading.Thread(target=_go, name="owllm-notify", daemon=True).start()
