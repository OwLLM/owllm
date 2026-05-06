"""📱 Bridges — control panel for the Telegram + WhatsApp bridges.

Two cards, one per bridge. Each card has the inputs the bridge needs
(token / API id / verify token / allow-list / project / auto-approve),
plus a Start / Stop button and live status text. Configs persist via
:mod:`bridge_config_store`.

Style mirrors the Accounts brand cards so the page reads as the same
family of "external connection management" surface.
"""
from __future__ import annotations

import logging
from typing import Optional

from PySide6.QtCore import Qt, QObject, QTimer, Signal, Slot
from PySide6.QtGui import QColor, QFont
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFrame,
    QGraphicsDropShadowEffect,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QSizePolicy,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from core.agents.projects import get_project_store
from desktop_app.messaging import (
    TelegramConfig,
    WhatsAppConfig,
    get_telegram_bridge,
    get_whatsapp_bridge,
    load_bridge_configs,
    save_telegram_config,
    save_whatsapp_config,
)

logger = logging.getLogger(__name__)


def _add_shadow(widget: QWidget, blur: int = 24, y: int = 4, alpha: int = 110) -> None:
    eff = QGraphicsDropShadowEffect(widget)
    eff.setBlurRadius(blur)
    eff.setOffset(0, y)
    eff.setColor(QColor(0, 0, 0, alpha))
    widget.setGraphicsEffect(eff)


_INPUT_STYLE = """
    QLineEdit, QSpinBox {
        border-radius:8px; padding:0 12px; font-size:13px;
        min-height: 30px;
    }
"""


def _section_label(text: str) -> QLabel:
    lbl = QLabel(text)
    lbl.setStyleSheet(
        "color:#9aa0a6; font-size:11px; font-weight:600; "
        "letter-spacing:0.6px; text-transform:uppercase; "
        "background:transparent; margin-top:4px;"
    )
    return lbl


# ---------------------------------------------------------------------------
# Telegram card
# ---------------------------------------------------------------------------


class _TelegramCard(QFrame):
    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("TelegramCard")
        self.setStyleSheet("""
            QFrame#TelegramCard {
                background: qlineargradient(
                    x1:0, y1:0, x2:0, y2:1,
                    stop:0 #1c2540, stop:0.6 palette(base), stop:1 palette(base)
                );
                border: none;
                border-radius: 16px;
            }
        """)
        _add_shadow(self)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(20, 18, 20, 18)
        outer.setSpacing(10)

        # Header.
        head = QHBoxLayout()
        head.setSpacing(12)
        icon = QLabel("✈")
        f = QFont(); f.setPointSize(26)
        icon.setFont(f)
        icon.setStyleSheet("color:#52b4ff; background:transparent;")
        head.addWidget(icon)
        title_box = QVBoxLayout(); title_box.setSpacing(2)
        t = QLabel("Telegram")
        tf = QFont(); tf.setPointSize(15); tf.setBold(True)
        t.setFont(tf)
        t.setStyleSheet("color:#52b4ff; background:transparent;")
        title_box.addWidget(t)
        sub = QLabel("Bot token from @BotFather · long-poll · no public URL needed")
        sub.setStyleSheet("color:#9aa0a6; background:transparent; font-size:11px;")
        title_box.addWidget(sub)
        head.addLayout(title_box, 1)
        self.status_dot = QLabel()
        self.status_dot.setFixedSize(10, 10)
        head.addWidget(self.status_dot, 0, Qt.AlignTop)
        outer.addLayout(head)

        # Inputs.
        outer.addWidget(_section_label("Bot token"))
        self.token_input = QLineEdit()
        self.token_input.setEchoMode(QLineEdit.Password)
        self.token_input.setPlaceholderText("123456:ABCdefGhi…")
        self.token_input.setStyleSheet(_INPUT_STYLE)
        outer.addWidget(self.token_input)

        # Allowed chat IDs — explicitly OPTIONAL with a clear hint about
        # what happens when the field is empty (open) vs filled (allow-list).
        outer.addWidget(_section_label("Allowed chat IDs (optional)"))
        self.chat_ids_input = QLineEdit()
        self.chat_ids_input.setPlaceholderText(
            "(leave empty = any chat allowed) · 123456789, 987654321"
        )
        self.chat_ids_input.setStyleSheet(_INPUT_STYLE)
        outer.addWidget(self.chat_ids_input)

        # Discovery affordance: shows chat IDs that have actually messaged
        # the bot since startup, with a one-click "add to allow-list"
        # button next to each. Hidden until at least one ID is discovered.
        self.seen_ids_row = QHBoxLayout()
        self.seen_ids_row.setSpacing(6)
        self._seen_ids_label = QLabel("Seen chats:")
        self._seen_ids_label.setStyleSheet(
            "color:#9aa0a6; font-size:11px; background:transparent;"
        )
        self.seen_ids_row.addWidget(self._seen_ids_label)
        self.seen_ids_row.addStretch(1)
        self._seen_ids_widgets: list[QPushButton] = []
        self._seen_ids_label.setVisible(False)
        outer.addLayout(self.seen_ids_row)

        outer.addWidget(_section_label("Project"))
        self.project_combo = QComboBox()
        self.project_combo.setMinimumHeight(32)
        self.project_combo.setStyleSheet(
            "QComboBox { background:palette(base); color:#fff; border:none; "
            "border-radius:8px; padding:0 12px; font-size:13px; }"
        )
        outer.addWidget(self.project_combo)

        self.auto_approve_cb = QCheckBox(
            "Auto-approve every tool call (only for personal bots)"
        )
        self.auto_approve_cb.setStyleSheet("color:#dadcdf; font-size:12px;")
        outer.addWidget(self.auto_approve_cb)

        outer.addStretch(1)

        # Status text.
        self.status_text = QLabel("Stopped.")
        self.status_text.setWordWrap(True)
        self.status_text.setStyleSheet(
            "color:#9aa0a6; background:transparent; font-size:11px;"
        )
        outer.addWidget(self.status_text)

        # Buttons.
        btns = QHBoxLayout()
        btns.setSpacing(8)
        self.start_btn = QPushButton("Start")
        self.start_btn.setMinimumHeight(34)
        self.start_btn.setStyleSheet(
            "QPushButton { background:#52b4ff; color:white; border:none; "
            "border-radius:8px; padding:0 18px; font-weight:600; }"
            "QPushButton:hover { background:#62c4ff; }"
            "QPushButton:disabled { background:#2c313c; color:#777; }"
        )
        self.stop_btn = QPushButton("Stop")
        self.stop_btn.setMinimumHeight(34)
        self.stop_btn.setStyleSheet(
            "QPushButton { background:rgba(255,140,140,0.12); color:#ff8c8c; "
            "border:none; border-radius:8px; padding:0 18px; font-weight:600; }"
            "QPushButton:hover { background:rgba(255,140,140,0.24); }"
            "QPushButton:disabled { color:#555; background:transparent; }"
        )
        btns.addWidget(self.start_btn, 1)
        btns.addWidget(self.stop_btn)
        outer.addLayout(btns)

        self.start_btn.clicked.connect(self._on_start)
        self.stop_btn.clicked.connect(self._on_stop)

        self._set_dot(False)
        self.refresh_status()

    # --- IO ----------------------------------------------------------

    def populate(self, cfg: TelegramConfig) -> None:
        self.token_input.setText(cfg.bot_token)
        self.chat_ids_input.setText(", ".join(str(x) for x in cfg.allowed_chat_ids))
        self.auto_approve_cb.setChecked(cfg.auto_approve)
        # project_combo populated externally via populate_projects.
        idx = self.project_combo.findData(cfg.project_id)
        if idx >= 0:
            self.project_combo.setCurrentIndex(idx)

    def populate_projects(self) -> None:
        self.project_combo.blockSignals(True)
        previous = self.project_combo.currentData()
        self.project_combo.clear()
        for p in get_project_store().list_projects():
            self.project_combo.addItem(p.name, p.id)
        if previous:
            idx = self.project_combo.findData(previous)
            if idx >= 0:
                self.project_combo.setCurrentIndex(idx)
        self.project_combo.blockSignals(False)

    def collect(self) -> TelegramConfig:
        ids: list[int] = []
        for raw in self.chat_ids_input.text().split(","):
            raw = raw.strip()
            if raw:
                try:
                    ids.append(int(raw))
                except ValueError:
                    pass
        return TelegramConfig(
            bot_token=self.token_input.text().strip(),
            allowed_chat_ids=ids,
            project_id=str(self.project_combo.currentData() or ""),
            auto_approve=self.auto_approve_cb.isChecked(),
        )

    # --- actions -----------------------------------------------------

    def _on_start(self) -> None:
        cfg = self.collect()
        try:
            save_telegram_config(cfg)
            get_telegram_bridge().start(cfg)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "Telegram", f"Could not start: {exc}")
            return
        self.refresh_status()

    def _on_stop(self) -> None:
        try:
            get_telegram_bridge().stop()
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "Telegram", f"Could not stop: {exc}")
        self.refresh_status()

    # --- status ------------------------------------------------------

    def refresh_status(self) -> None:
        bridge = get_telegram_bridge()
        st = bridge.status()
        self._set_dot(st.running)
        if st.running:
            cfg_open = not (self._config_chat_ids())
            extra = " · open (any chat)" if cfg_open else " · allow-list active"
            self.status_text.setText(
                f"Running — last update_id {st.last_update_id}.{extra}"
            )
            self.start_btn.setEnabled(False)
            self.stop_btn.setEnabled(True)
        else:
            base = "Stopped."
            if st.last_error:
                base = f"Stopped — last error: {st.last_error}"
            self.status_text.setText(base)
            self.start_btn.setEnabled(True)
            self.stop_btn.setEnabled(False)

        # Update discovered chat-ID chips.
        try:
            self._refresh_seen_ids(bridge.seen_chat_ids())
        except Exception:
            pass

    def _config_chat_ids(self) -> list[int]:
        ids: list[int] = []
        for raw in self.chat_ids_input.text().split(","):
            raw = raw.strip()
            if raw:
                try:
                    ids.append(int(raw))
                except ValueError:
                    pass
        return ids

    def _refresh_seen_ids(self, seen: list[int]) -> None:
        # Tear down existing chips.
        for w in self._seen_ids_widgets:
            w.setParent(None)
            w.deleteLater()
        self._seen_ids_widgets.clear()

        if not seen:
            self._seen_ids_label.setVisible(False)
            return
        self._seen_ids_label.setVisible(True)

        existing = set(self._config_chat_ids())
        for cid in seen[:5]:
            label = f"{cid}" + ("  ✓" if cid in existing else "  + add")
            btn = QPushButton(label)
            btn.setStyleSheet(
                "QPushButton { background:rgba(82,180,255,0.15); color:#52b4ff; "
                "border:none; border-radius:10px; padding:2px 8px; font-size:10px; }"
                "QPushButton:hover { background:rgba(82,180,255,0.30); }"
            )
            if cid not in existing:
                btn.clicked.connect(lambda _checked=False, c=cid: self._add_seen_id(c))
            else:
                btn.setEnabled(False)
            self._seen_ids_widgets.append(btn)
            self.seen_ids_row.insertWidget(
                self.seen_ids_row.count() - 1, btn  # before the stretch
            )

    def _add_seen_id(self, chat_id: int) -> None:
        existing = self._config_chat_ids()
        if chat_id in existing:
            return
        existing.append(chat_id)
        self.chat_ids_input.setText(", ".join(str(x) for x in existing))
        # Persist immediately so it survives a restart even without a Stop/Start.
        try:
            save_telegram_config(self.collect())
        except Exception:
            pass
        self.refresh_status()

    def _set_dot(self, running: bool) -> None:
        color = "#4caf50" if running else "#5a6376"
        self.status_dot.setStyleSheet(f"background:{color}; border-radius:5px;")


# ---------------------------------------------------------------------------
# WhatsApp card
# ---------------------------------------------------------------------------


class _WhatsAppCard(QFrame):
    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("WhatsAppCard")
        self.setStyleSheet("""
            QFrame#WhatsAppCard {
                background: qlineargradient(
                    x1:0, y1:0, x2:0, y2:1,
                    stop:0 #16322a, stop:0.6 palette(base), stop:1 palette(base)
                );
                border: none;
                border-radius: 16px;
            }
        """)
        _add_shadow(self)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(20, 18, 20, 18)
        outer.setSpacing(10)

        head = QHBoxLayout(); head.setSpacing(12)
        icon = QLabel("💬")
        f = QFont(); f.setPointSize(26)
        icon.setFont(f)
        icon.setStyleSheet("background:transparent;")
        head.addWidget(icon)
        title_box = QVBoxLayout(); title_box.setSpacing(2)
        t = QLabel("WhatsApp")
        tf = QFont(); tf.setPointSize(15); tf.setBold(True)
        t.setFont(tf)
        t.setStyleSheet("color:#10a37f; background:transparent;")
        title_box.addWidget(t)
        sub = QLabel("Meta Cloud API · webhook needs a public URL (cloudflared/ngrok)")
        sub.setStyleSheet("color:#9aa0a6; background:transparent; font-size:11px;")
        title_box.addWidget(sub)
        head.addLayout(title_box, 1)
        self.status_dot = QLabel()
        self.status_dot.setFixedSize(10, 10)
        head.addWidget(self.status_dot, 0, Qt.AlignTop)
        outer.addLayout(head)

        # Token + ids.
        grid = QGridLayout()
        grid.setHorizontalSpacing(10)
        grid.setVerticalSpacing(8)

        grid.addWidget(_section_label("Access token"), 0, 0, 1, 2)
        self.token_input = QLineEdit()
        self.token_input.setEchoMode(QLineEdit.Password)
        self.token_input.setStyleSheet(_INPUT_STYLE)
        grid.addWidget(self.token_input, 1, 0, 1, 2)

        grid.addWidget(_section_label("Phone number ID"), 2, 0)
        grid.addWidget(_section_label("Verify token"), 2, 1)
        self.phone_id_input = QLineEdit()
        self.phone_id_input.setStyleSheet(_INPUT_STYLE)
        grid.addWidget(self.phone_id_input, 3, 0)
        self.verify_input = QLineEdit()
        self.verify_input.setStyleSheet(_INPUT_STYLE)
        grid.addWidget(self.verify_input, 3, 1)

        grid.addWidget(_section_label("Allowed senders (comma E.164)"), 4, 0, 1, 2)
        self.senders_input = QLineEdit()
        self.senders_input.setPlaceholderText("393331234567, 14155551234")
        self.senders_input.setStyleSheet(_INPUT_STYLE)
        grid.addWidget(self.senders_input, 5, 0, 1, 2)

        grid.addWidget(_section_label("Webhook port"), 6, 0)
        grid.addWidget(_section_label("Project"), 6, 1)
        self.port_input = QSpinBox()
        self.port_input.setRange(1024, 65535)
        self.port_input.setValue(8911)
        self.port_input.setStyleSheet(_INPUT_STYLE)
        grid.addWidget(self.port_input, 7, 0)
        self.project_combo = QComboBox()
        self.project_combo.setMinimumHeight(32)
        self.project_combo.setStyleSheet(
            "QComboBox { background:palette(base); color:#fff; border:none; "
            "border-radius:8px; padding:0 12px; font-size:13px; }"
        )
        grid.addWidget(self.project_combo, 7, 1)
        outer.addLayout(grid)

        self.auto_approve_cb = QCheckBox("Auto-approve every tool call")
        self.auto_approve_cb.setStyleSheet("color:#dadcdf; font-size:12px;")
        outer.addWidget(self.auto_approve_cb)

        outer.addStretch(1)
        self.status_text = QLabel("Stopped.")
        self.status_text.setWordWrap(True)
        self.status_text.setStyleSheet(
            "color:#9aa0a6; background:transparent; font-size:11px;"
        )
        outer.addWidget(self.status_text)

        btns = QHBoxLayout()
        btns.setSpacing(8)
        self.start_btn = QPushButton("Start")
        self.start_btn.setMinimumHeight(34)
        self.start_btn.setStyleSheet(
            "QPushButton { background:#10a37f; color:white; border:none; "
            "border-radius:8px; padding:0 18px; font-weight:600; }"
            "QPushButton:hover { background:#22b88f; }"
            "QPushButton:disabled { background:#2c313c; color:#777; }"
        )
        self.stop_btn = QPushButton("Stop")
        self.stop_btn.setMinimumHeight(34)
        self.stop_btn.setStyleSheet(
            "QPushButton { background:rgba(255,140,140,0.12); color:#ff8c8c; "
            "border:none; border-radius:8px; padding:0 18px; font-weight:600; }"
            "QPushButton:hover { background:rgba(255,140,140,0.24); }"
            "QPushButton:disabled { color:#555; background:transparent; }"
        )
        btns.addWidget(self.start_btn, 1)
        btns.addWidget(self.stop_btn)
        outer.addLayout(btns)

        self.start_btn.clicked.connect(self._on_start)
        self.stop_btn.clicked.connect(self._on_stop)

        self._set_dot(False)
        self.refresh_status()

    def populate(self, cfg: WhatsAppConfig) -> None:
        self.token_input.setText(cfg.access_token)
        self.phone_id_input.setText(cfg.phone_number_id)
        self.verify_input.setText(cfg.verify_token)
        self.senders_input.setText(", ".join(cfg.allowed_senders))
        self.port_input.setValue(int(cfg.webhook_port or 8911))
        self.auto_approve_cb.setChecked(cfg.auto_approve)
        idx = self.project_combo.findData(cfg.project_id)
        if idx >= 0:
            self.project_combo.setCurrentIndex(idx)

    def populate_projects(self) -> None:
        self.project_combo.blockSignals(True)
        previous = self.project_combo.currentData()
        self.project_combo.clear()
        for p in get_project_store().list_projects():
            self.project_combo.addItem(p.name, p.id)
        if previous:
            idx = self.project_combo.findData(previous)
            if idx >= 0:
                self.project_combo.setCurrentIndex(idx)
        self.project_combo.blockSignals(False)

    def collect(self) -> WhatsAppConfig:
        senders = [s.strip() for s in self.senders_input.text().split(",") if s.strip()]
        return WhatsAppConfig(
            access_token=self.token_input.text().strip(),
            phone_number_id=self.phone_id_input.text().strip(),
            verify_token=self.verify_input.text().strip(),
            webhook_port=int(self.port_input.value()),
            allowed_senders=senders,
            project_id=str(self.project_combo.currentData() or ""),
            auto_approve=self.auto_approve_cb.isChecked(),
        )

    def _on_start(self) -> None:
        cfg = self.collect()
        try:
            save_whatsapp_config(cfg)
            get_whatsapp_bridge().start(cfg)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "WhatsApp", f"Could not start: {exc}")
            return
        self.refresh_status()

    def _on_stop(self) -> None:
        try:
            get_whatsapp_bridge().stop()
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "WhatsApp", f"Could not stop: {exc}")
        self.refresh_status()

    def refresh_status(self) -> None:
        st = get_whatsapp_bridge().status()
        self._set_dot(st.running)
        if st.running:
            self.status_text.setText(
                f"Listening on {st.bind} — point your tunnel at this port "
                f"and use it as the webhook callback URL in Meta."
            )
            self.start_btn.setEnabled(False)
            self.stop_btn.setEnabled(True)
        else:
            base = "Stopped."
            if st.last_error:
                base = f"Stopped — last error: {st.last_error}"
            self.status_text.setText(base)
            self.start_btn.setEnabled(True)
            self.stop_btn.setEnabled(False)

    def _set_dot(self, running: bool) -> None:
        color = "#4caf50" if running else "#5a6376"
        self.status_dot.setStyleSheet(f"background:{color}; border-radius:5px;")


# ---------------------------------------------------------------------------
# Page
# ---------------------------------------------------------------------------


class BridgesPage(QWidget):
    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self._build_ui()
        self._load_initial_state()

        # Cheap status poll so the dots stay live without manual refresh.
        self._timer = QTimer(self)
        self._timer.setInterval(3000)
        self._timer.timeout.connect(self._tick)
        self._timer.start()

    def _build_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(28, 24, 28, 24)
        outer.setSpacing(18)

        title = QLabel("Bridges")
        tf = QFont(); tf.setPointSize(22); tf.setBold(True)
        title.setFont(tf)
        title.setStyleSheet("color:#fff; background:transparent;")
        outer.addWidget(title)

        sub = QLabel(
            "Drive your agent team from a phone. Telegram needs only a bot "
            "token; WhatsApp Cloud API needs a public webhook URL — point a "
            "tunnel (cloudflared / ngrok) at the local port and copy that "
            "URL into the Meta App webhook config."
        )
        sub.setWordWrap(True)
        sub.setStyleSheet("color:#9aa0a6; font-size:12px;")
        outer.addWidget(sub)

        cards = QHBoxLayout()
        cards.setSpacing(18)
        self.tg_card = _TelegramCard()
        self.wa_card = _WhatsAppCard()
        cards.addWidget(self.tg_card, 1)
        cards.addWidget(self.wa_card, 1)
        outer.addLayout(cards, 1)

    def _load_initial_state(self) -> None:
        try:
            tg_cfg, wa_cfg = load_bridge_configs()
        except Exception:
            logger.exception("could not load bridge configs")
            return
        # Populate projects FIRST so the combos can find the saved ids.
        self.tg_card.populate_projects()
        self.wa_card.populate_projects()
        self.tg_card.populate(tg_cfg)
        self.wa_card.populate(wa_cfg)

    def _tick(self) -> None:
        # Refresh the status dots + text. Doesn't touch inputs so the user
        # editing fields isn't disturbed.
        try:
            self.tg_card.refresh_status()
            self.wa_card.refresh_status()
        except Exception:
            logger.exception("bridges status refresh failed")
