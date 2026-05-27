"""Notify-channel settings dialog — pick + configure the external
notifier used by :class:`UserCard` events."""
from __future__ import annotations

from typing import Optional

from PySide6.QtCore import QSettings, Qt
from PySide6.QtWidgets import (
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QVBoxLayout,
    QWidget,
)

from core.notify import (
    KEY_BACKEND,
    KEY_TG_CHAT_ID,
    KEY_TG_TOKEN,
    get_notifier,
)


_QSS = """
QDialog#NotifySettingsDialog { background-color: #0a0d14; }
QLabel { color: #c4d0e8; }
QLabel#hint { color: #7888a8; font-size: 10px; }
QLineEdit, QComboBox {
    background-color: #12161f; color: #c4d0e8;
    border: 1px solid #2a3148; border-radius: 4px; padding: 4px 6px;
}
QPushButton {
    color: #e6f0ff; background-color: #1a2030;
    border: 1px solid #2a3148; border-radius: 6px;
    padding: 5px 12px; font-size: 11px;
}
QPushButton:hover { background-color: #232a40; border-color: #5cf0ff; }
QPushButton#primaryButton {
    color: #0a0d14; background-color: #5cf0ff; border-color: #5cf0ff;
}
"""


class NotifySettingsDialog(QDialog):
    """Configures which channel (if any) receives external pings when
    the User card is alerting. Writes to QSettings; takes effect on the
    next ``notify_async`` call (no restart needed)."""

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setObjectName("NotifySettingsDialog")
        self.setStyleSheet(_QSS)
        self.setWindowTitle("User notifications")
        self.setMinimumWidth(440)
        self.setModal(False)
        self.setAttribute(Qt.WA_DeleteOnClose)

        s = QSettings()
        outer = QVBoxLayout(self)
        outer.setContentsMargins(16, 14, 16, 14)
        outer.setSpacing(10)

        form = QFormLayout()

        self._backend = QComboBox()
        self._backend.addItem("Off (no external notification)", "")
        self._backend.addItem("Telegram", "telegram")
        cur = s.value(KEY_BACKEND, "") or ""
        idx = self._backend.findData(cur)
        if idx >= 0:
            self._backend.setCurrentIndex(idx)
        form.addRow("Channel", self._backend)

        self._tg_token = QLineEdit(s.value(KEY_TG_TOKEN, "") or "")
        self._tg_token.setEchoMode(QLineEdit.Password)
        self._tg_token.setPlaceholderText("123456:ABC-...")
        form.addRow("Telegram bot token", self._tg_token)

        self._tg_chat = QLineEdit(s.value(KEY_TG_CHAT_ID, "") or "")
        self._tg_chat.setPlaceholderText("12345678 (chat or user id)")
        form.addRow("Telegram chat id", self._tg_chat)

        outer.addLayout(form)

        hint = QLabel(
            "Create a bot via @BotFather. Get your chat id by messaging "
            "the bot once and visiting "
            "<code>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code>."
        )
        hint.setObjectName("hint")
        hint.setWordWrap(True)
        outer.addWidget(hint)

        buttons = QDialogButtonBox(
            QDialogButtonBox.Ok | QDialogButtonBox.Cancel
        )
        ok = buttons.button(QDialogButtonBox.Ok)
        ok.setText("Save")
        ok.setObjectName("primaryButton")
        test = buttons.addButton("Test", QDialogButtonBox.ActionRole)
        buttons.accepted.connect(self._save)
        buttons.rejected.connect(self.close)
        test.clicked.connect(self._test)
        outer.addWidget(buttons)

    def _persist(self) -> None:
        s = QSettings()
        s.setValue(KEY_BACKEND, self._backend.currentData() or "")
        s.setValue(KEY_TG_TOKEN, self._tg_token.text().strip())
        s.setValue(KEY_TG_CHAT_ID, self._tg_chat.text().strip())
        s.sync()

    def _save(self) -> None:
        self._persist()
        self.close()

    def _test(self) -> None:
        # Save first so get_notifier sees the current values.
        self._persist()
        n = get_notifier()
        ok = False
        try:
            ok = bool(n.notify("OWLLM", "Test message from the agents page."))
        except Exception:
            ok = False
        if ok:
            QMessageBox.information(self, "OWLLM", "Sent ✓")
        else:
            QMessageBox.warning(
                self, "OWLLM",
                "Test failed. Check the bot token, the chat id, and your "
                "network connection.",
            )
