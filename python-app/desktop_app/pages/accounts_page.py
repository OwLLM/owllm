"""Accounts top-level tab — connect, disconnect, test the four cloud routes.

Four brand cards in a 2×2 grid, each rendered as a soft, shadow-lifted
panel with a subtle brand-tinted gradient background. No visible 1px
borders, no scroll areas, no list widgets.

Lives as its own top-level navbar tab — it's not a dialog and not a
subpage swap. Reach it from the 🔐 Accounts button.
"""
from __future__ import annotations

import logging
import threading
from typing import Callable, Optional

from PySide6.QtCore import Qt, QObject, QTimer, Signal, Slot
from PySide6.QtGui import QColor, QFont
from PySide6.QtWidgets import (
    QDialog,
    QDialogButtonBox,
    QFrame,
    QGraphicsDropShadowEffect,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

from core.agents.backends import quick_test
from desktop_app import agent_runtime_manager

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Brand definitions
# ---------------------------------------------------------------------------

# accent_top / accent_bottom drive the card's gradient — slightly brighter
# at the top, fading into the panel background at the bottom. Pixel-tested
# to look like the brand without overpowering the rest of the UI.
BRAND_CARDS = (
    {
        "key": "claude_subscription",
        "name": "Claude",
        "tagline": "Subscription · Claude Code CLI",
        "icon": "🅰️",
        "accent": "#cc785c",
        "accent_top": "#3a2620",
        "accent_bottom": "palette(base)",
        "kind": "subscription",
        "backend": "claude_cli",
    },
    {
        "key": "codex_subscription",
        "name": "Codex",
        "tagline": "Subscription · OpenAI Codex CLI",
        "icon": "🟢",
        "accent": "#10a37f",
        "accent_top": "#16322a",
        "accent_bottom": "palette(base)",
        "kind": "subscription",
        "backend": "codex_cli",
    },
    {
        "key": "anthropic_api",
        "name": "Anthropic API",
        "tagline": "ANTHROPIC_API_KEY · billed per call",
        "icon": "⚡",
        "accent": "#cc785c",
        "accent_top": "#2e2420",
        "accent_bottom": "palette(base)",
        "kind": "api",
        "env_name": "ANTHROPIC_API_KEY",
        "backend": "claude_api",
    },
    {
        "key": "openai_api",
        "name": "OpenAI API",
        "tagline": "OPENAI_API_KEY · billed per call",
        "icon": "⚡",
        "accent": "#10a37f",
        "accent_top": "#172a26",
        "accent_bottom": "palette(base)",
        "kind": "api",
        "env_name": "OPENAI_API_KEY",
        "backend": "openai_api",
    },
)


# ---------------------------------------------------------------------------
# Worker bridge
# ---------------------------------------------------------------------------


class _TestResultBridge(QObject):
    result = Signal(str, bool, str, int)  # key, ok, detail, elapsed_ms


# ---------------------------------------------------------------------------
# Small utility — drop shadow on any frame
# ---------------------------------------------------------------------------


def _add_shadow(widget: QWidget, blur: int = 24, y: int = 4, alpha: int = 120) -> None:
    """Lift a widget visually with a soft drop shadow.

    Used instead of 1px borders for the new card aesthetic. Subtle, no
    hard edges, plays nicely with the dark theme.
    """
    eff = QGraphicsDropShadowEffect(widget)
    eff.setBlurRadius(blur)
    eff.setOffset(0, y)
    eff.setColor(QColor(0, 0, 0, alpha))
    widget.setGraphicsEffect(eff)


# ---------------------------------------------------------------------------
# Brand card
# ---------------------------------------------------------------------------


class BrandCard(QFrame):
    """Pretty brand card.

    Visual: soft drop shadow, top-tinted gradient in the brand accent fading
    into the page background, generous padding, no visible 1px borders.
    """

    def __init__(
        self,
        spec: dict,
        on_action: Callable[[], None],
        on_secondary: Callable[[], None],
        on_test: Callable[[], None],
        parent: Optional[QWidget] = None,
    ) -> None:
        super().__init__(parent)
        self.spec = spec
        self._on_action = on_action
        self._on_secondary = on_secondary
        self._on_test = on_test
        self._connected: Optional[bool] = None
        self._testing = False

        self.setObjectName("BrandCard")
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.setMinimumHeight(220)

        self.setStyleSheet(f"""
            QFrame#BrandCard {{
                background: qlineargradient(
                    x1:0, y1:0, x2:0, y2:1,
                    stop:0 {spec['accent_top']},
                    stop:0.6 {spec['accent_bottom']},
                    stop:1 {spec['accent_bottom']}
                );
                border: none;
                border-radius: 16px;
            }}
        """)
        _add_shadow(self)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(22, 20, 22, 20)
        layout.setSpacing(10)

        # Header.
        header = QHBoxLayout()
        header.setSpacing(14)
        icon = QLabel(spec["icon"])
        f = QFont()
        f.setPointSize(28)
        icon.setFont(f)
        icon.setStyleSheet("background:transparent;")
        header.addWidget(icon)

        text_box = QVBoxLayout()
        text_box.setSpacing(2)
        self.name_label = QLabel(spec["name"])
        nf = QFont()
        nf.setPointSize(15)
        nf.setBold(True)
        self.name_label.setFont(nf)
        self.name_label.setStyleSheet(f"color:{spec['accent']}; background:transparent;")
        text_box.addWidget(self.name_label)
        self.tagline_label = QLabel(spec["tagline"])
        self.tagline_label.setStyleSheet("color:#9aa0a6; font-size:11px; background:transparent;")
        text_box.addWidget(self.tagline_label)
        header.addLayout(text_box, 1)

        self.status_dot = QLabel()
        self.status_dot.setFixedSize(10, 10)
        header.addWidget(self.status_dot, 0, Qt.AlignTop)
        layout.addLayout(header)

        # Status line.
        self.status_label = QLabel("Not connected")
        self.status_label.setStyleSheet("color:#bbb; font-size:11px; background:transparent;")
        layout.addWidget(self.status_label)

        layout.addStretch(1)

        # Test result line.
        self.test_label = QLabel("")
        self.test_label.setWordWrap(True)
        self.test_label.setStyleSheet("color:#9aa0a6; font-size:11px; background:transparent;")
        self.test_label.setVisible(False)
        layout.addWidget(self.test_label)

        # Action buttons.
        btn_row = QHBoxLayout()
        btn_row.setSpacing(8)

        self.action_btn = QPushButton()
        self.action_btn.setMinimumHeight(34)
        self.action_btn.clicked.connect(self._on_action_clicked)
        btn_row.addWidget(self.action_btn, 1)

        self.test_btn = QPushButton("Test")
        self.test_btn.setMinimumHeight(34)
        self.test_btn.setStyleSheet("""
            QPushButton {
                background: rgba(255,255,255,0.06);
                color: #ddd;
                border: none; border-radius: 8px;
                padding: 0 18px; font-weight: 500;
            }
            QPushButton:hover { background: rgba(255,255,255,0.12); }
            QPushButton:disabled { color: #555; background: rgba(255,255,255,0.03); }
        """)
        self.test_btn.clicked.connect(self._on_test_clicked)
        btn_row.addWidget(self.test_btn, 0)
        layout.addLayout(btn_row)

    # ------------------------------------------------------------------
    # State
    # ------------------------------------------------------------------

    def set_connected(self, connected: bool) -> None:
        if connected == self._connected:
            return
        self._connected = connected
        if connected:
            self.status_dot.setStyleSheet("background:#4caf50; border-radius:5px;")
            self.status_label.setText("Connected")
            self.action_btn.setText("Disconnect")
            self.action_btn.setStyleSheet("""
                QPushButton {
                    background: rgba(255,110,110,0.12);
                    color: #ff8c8c;
                    border: none; border-radius: 8px;
                    padding: 0 18px; font-weight: 600;
                }
                QPushButton:hover { background: rgba(255,110,110,0.24); }
            """)
            self.test_btn.setEnabled(True)
        else:
            self.status_dot.setStyleSheet("background:#5a6376; border-radius:5px;")
            self.status_label.setText("Not connected")
            self.action_btn.setText("Set key" if self.spec["kind"] == "api" else "Connect")
            accent = self.spec["accent"]
            self.action_btn.setStyleSheet(f"""
                QPushButton {{
                    background: {accent};
                    color: white;
                    border: none; border-radius: 8px;
                    padding: 0 18px; font-weight: 600;
                }}
                QPushButton:hover {{ background: {accent}cc; }}
            """)
            self.test_btn.setEnabled(False)
            self.test_label.setVisible(False)

    def set_testing(self, testing: bool) -> None:
        self._testing = testing
        if testing:
            self.test_btn.setText("Testing…")
            self.test_btn.setEnabled(False)
            self.test_label.setText("Running probe…")
            self.test_label.setStyleSheet("color:#dcb0ff; font-size:11px; background:transparent;")
            self.test_label.setVisible(True)
        else:
            self.test_btn.setText("Test")
            self.test_btn.setEnabled(self._connected is True)

    def set_test_result(self, ok: bool, detail: str, elapsed_ms: int) -> None:
        self.set_testing(False)
        prefix = "✓" if ok else "✗"
        color = "#4caf50" if ok else "#ff8c8c"
        self.test_label.setText(f"{prefix}  {detail}  ·  {elapsed_ms} ms")
        self.test_label.setStyleSheet(f"color:{color}; font-size:11px; background:transparent;")
        self.test_label.setVisible(True)

    # --- click handlers ----------------------------------------------

    def _on_action_clicked(self) -> None:
        if self._connected:
            self._on_secondary()
        else:
            self._on_action()

    def _on_test_clicked(self) -> None:
        if not self._testing and self._connected:
            self._on_test()


# ---------------------------------------------------------------------------
# API key dialog
# ---------------------------------------------------------------------------


class _ApiKeyDialog(QDialog):
    def __init__(self, env_name: str, parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle(f"Set {env_name}")
        self.setModal(True)
        self.setMinimumWidth(440)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(12)

        prose = QLabel(
            f"Paste your <b>{env_name}</b> below. It will be stored in "
            f"<code>LLM/data/owllm_agent_secrets.json</code> on this machine "
            f"and applied to <code>os.environ</code> at startup. "
            f"Shell-exported env vars take precedence."
        )
        prose.setWordWrap(True)
        prose.setStyleSheet("color:#bbb; font-size:11px;")
        layout.addWidget(prose)

        self._input = QLineEdit()
        self._input.setEchoMode(QLineEdit.Password)
        self._input.setPlaceholderText(env_name)
        self._input.setMinimumHeight(34)
        layout.addWidget(self._input)

        toggle = QPushButton("Show")
        toggle.setCheckable(True)
        toggle.setStyleSheet(
            "background:transparent; color:#aaa; border:none; "
            "text-decoration:underline;"
        )
        toggle.toggled.connect(
            lambda c: (
                self._input.setEchoMode(QLineEdit.Normal if c else QLineEdit.Password),
                toggle.setText("Hide" if c else "Show"),
            )
        )
        layout.addWidget(toggle)

        buttons = QDialogButtonBox(QDialogButtonBox.Save | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def value(self) -> str:
        return self._input.text().strip()


# ---------------------------------------------------------------------------
# Page
# ---------------------------------------------------------------------------


class AccountsPage(QWidget):
    """Top-level Accounts tab. Four brand cards, no scroll, no list."""

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self._cards: dict[str, BrandCard] = {}
        self._bridge = _TestResultBridge()
        self._bridge.result.connect(self._on_test_finished)

        self._build_ui()
        self._refresh()

        self._timer = QTimer(self)
        self._timer.setInterval(3000)
        self._timer.timeout.connect(self._refresh)
        # showEvent starts it. Polling off-tab wastes CPU and risks
        # touching widgets after the page is hidden (idle Qt crashes).

    def showEvent(self, ev):
        super().showEvent(ev)
        if not self._timer.isActive():
            self._refresh()
            self._timer.start()

    def hideEvent(self, ev):
        super().hideEvent(ev)
        if self._timer.isActive():
            self._timer.stop()

    def _build_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(28, 24, 28, 24)
        outer.setSpacing(18)

        # Header.
        title = QLabel("Accounts")
        tf = QFont()
        tf.setPointSize(22)
        tf.setBold(True)
        title.setFont(tf)
        title.setStyleSheet("color:#fff; background:transparent;")
        outer.addWidget(title)

        sub = QLabel(
            "Connect each provider once. Test verifies credentials end-to-end."
        )
        sub.setStyleSheet("color:#9aa0a6; font-size:12px;")
        outer.addWidget(sub)

        # 2×2 grid — no scroll.
        grid = QGridLayout()
        grid.setHorizontalSpacing(18)
        grid.setVerticalSpacing(18)
        for i, spec in enumerate(BRAND_CARDS):
            card = BrandCard(
                spec,
                on_action=lambda s=spec: self._connect(s),
                on_secondary=lambda s=spec: self._disconnect(s),
                on_test=lambda s=spec: self._test(s),
            )
            self._cards[spec["key"]] = card
            grid.addWidget(card, i // 2, i % 2)
        grid.setColumnStretch(0, 1)
        grid.setColumnStretch(1, 1)
        outer.addLayout(grid, 1)

    # ------------------------------------------------------------------
    # State
    # ------------------------------------------------------------------

    def _refresh(self) -> None:
        st = agent_runtime_manager.status()
        self._cards["claude_subscription"].set_connected(st.claude_subscription_connected)
        self._cards["codex_subscription"].set_connected(st.codex_subscription_connected)
        self._cards["anthropic_api"].set_connected(st.anthropic_api_key_set)
        self._cards["openai_api"].set_connected(st.openai_api_key_set)

    # ------------------------------------------------------------------
    # Connect / disconnect / test
    # ------------------------------------------------------------------

    def _connect(self, spec: dict) -> None:
        if spec["kind"] == "subscription":
            try:
                if spec["key"] == "claude_subscription":
                    agent_runtime_manager.launch_claude_login()
                else:
                    agent_runtime_manager.launch_codex_login()
            except Exception as exc:  # noqa: BLE001
                QMessageBox.warning(self, "Connect", f"Could not launch login:\n{exc}")
                return
            QMessageBox.information(
                self,
                f"Connect {spec['name']}",
                f"A console window opened for {spec['name']}'s OAuth flow.\n"
                f"Complete it in your browser. The card flips to green once "
                f"the credentials file appears.",
            )
        else:
            dlg = _ApiKeyDialog(spec["env_name"], self)
            if dlg.exec() == QDialog.Accepted and dlg.value():
                agent_runtime_manager.save_stored_secret(spec["env_name"], dlg.value())
                self._refresh()

    def _disconnect(self, spec: dict) -> None:
        if QMessageBox.question(
            self,
            f"Disconnect {spec['name']}",
            f"Remove the local {spec['name']} credentials?",
        ) != QMessageBox.Yes:
            return
        if spec["kind"] == "subscription":
            if spec["key"] == "claude_subscription":
                agent_runtime_manager.claude_logout()
            else:
                agent_runtime_manager.codex_logout()
        else:
            agent_runtime_manager.delete_stored_secret(spec["env_name"])
        self._refresh()

    def _test(self, spec: dict) -> None:
        card = self._cards[spec["key"]]
        card.set_testing(True)
        backend_name = spec["backend"]
        key = spec["key"]

        def worker():
            res = quick_test(backend_name)
            self._bridge.result.emit(key, res.ok, res.detail, res.elapsed_ms)

        threading.Thread(target=worker, name=f"test-{backend_name}", daemon=True).start()

    @Slot(str, bool, str, int)
    def _on_test_finished(self, key: str, ok: bool, detail: str, elapsed_ms: int) -> None:
        card = self._cards.get(key)
        if card is None:
            return
        card.set_test_result(ok, detail, elapsed_ms)
