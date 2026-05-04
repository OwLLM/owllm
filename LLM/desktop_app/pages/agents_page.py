"""Agents tab — multi-agent OWLLM runtime UI.

Layout (all cards, no scroll, no list widgets):

    ┌─ accounts strip — read-only summary ─────────────────────────┐
    │ ● Claude  ● Codex  ● Anthropic  ● OpenAI                     │
    ├──────────────────────────────────────────────────────────────┤
    │ [ goal ]                                  [ Run ] [ Cancel ] │
    ├─────────────── 2-col splitter ───────────────────────────────┤
    │ AGENT CARDS (gradient + shadow)  │  live message stream      │
    │  ┌─ orchestrator (full-width) ─┐ │                           │
    │  └─────────────────────────────┘ │                           │
    │  ┌ res ┐ ┌ code ┐                │                           │
    │  ┌ op  ┐ ┌ crit ┐                │                           │
    ├──────────────────────────────────────────────────────────────┤
    │ pending approvals (vertical card stack, only when filled)    │
    └──────────────────────────────────────────────────────────────┘

Each agent card uses :class:`ModelPickerButton` instead of a QComboBox —
clicking opens a popup with models grouped by provider (Local / Anthropic /
OpenAI). If Local is empty, the popup offers a CTA that switches to the
Models tab.

Account management lives in its own top-level "🔐 Accounts" tab.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Dict, Optional

from PySide6.QtCore import QObject, QSettings, QSize, Qt, QTimer, Signal, Slot
from PySide6.QtGui import QColor, QFont
from PySide6.QtWidgets import (
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFileDialog,
    QFrame,
    QGraphicsDropShadowEffect,
    QGridLayout,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QLineEdit,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QSplitter,
    QStackedWidget,
    QTabWidget,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from core.agents.agent_definitions import AgentDefinition, list_all_definitions
from core.agents.agent_graph import AgentGraph
from core.agents.attachments import (
    Attachment,
    KIND_AUDIO,
    KIND_IMAGE,
    adopt_local_path,
)
from core.agents.bus import get_bus
from core.agents.message import Message, MessageKind
from core.agents.orchestrator import Team, build_team
from core.agents.projects import Project, get_project_store
from core.agents.roles.loader import Role
from core.agents.tools import (
    ApprovalDecision,
    ApprovalRequest,
    builtin_registry,
    register_mcp_tools,
)
from core.agents.backends import dispatch_model_fn
from desktop_app import agent_runtime_manager
from PySide6.QtWidgets import QMenu

from desktop_app.widgets.agent_canvas import (
    AgentCanvas,
    STATUS_ACTIVE as CANVAS_STATUS_ACTIVE,
    STATUS_ERROR as CANVAS_STATUS_ERROR,
    STATUS_IDLE as CANVAS_STATUS_IDLE,
    STATUS_PENDING as CANVAS_STATUS_PENDING,
)
from desktop_app.widgets.agent_canvas_loader import AgentCanvasLoader
from desktop_app.widgets.agent_team_canvas import AgentTeamCanvas
from desktop_app.widgets.model_picker import ModelPickerButton

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Bridge
# ---------------------------------------------------------------------------


class _BusBridge(QObject):
    message = Signal(object)
    approval_requested = Signal(object)


# ---------------------------------------------------------------------------
# Status palette
# ---------------------------------------------------------------------------


_STATUS_IDLE = "idle"
_STATUS_THINKING = "thinking"
_STATUS_WORKING = "working"
_STATUS_ERROR = "error"


# ---------------------------------------------------------------------------
# Goal line edit — accepts file drops so the user can drag images / audio
# straight onto the prompt instead of going through the 📎 picker.
# ---------------------------------------------------------------------------


class _GoalLineEdit(QLineEdit):
    """QLineEdit that forwards dropped file URIs to a callback.

    Plain QLineEdit rejects file drops — its default drag handlers only
    accept text. This subclass overrides drag-enter / drop so the page
    can intercept image and audio files dropped from the OS file
    manager.
    """

    def __init__(self, on_files_dropped, parent=None):
        super().__init__(parent)
        self.setAcceptDrops(True)
        self._on_files_dropped = on_files_dropped

    def dragEnterEvent(self, event):  # noqa: N802
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            super().dragEnterEvent(event)

    def dragMoveEvent(self, event):  # noqa: N802
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            super().dragMoveEvent(event)

    def dropEvent(self, event):  # noqa: N802
        if event.mimeData().hasUrls():
            paths = [u.toLocalFile() for u in event.mimeData().urls() if u.isLocalFile()]
            paths = [p for p in paths if p]
            if paths and self._on_files_dropped:
                try:
                    self._on_files_dropped(paths)
                except Exception:
                    logger.exception("attachment drop handler crashed")
            event.acceptProposedAction()
            return
        super().dropEvent(event)

_STATUS_COLOR = {
    _STATUS_IDLE: "#4caf50",
    _STATUS_THINKING: "#dcb0ff",
    _STATUS_WORKING: "#ffd080",
    _STATUS_ERROR: "#ff8c8c",
}

_STATUS_LABEL = {
    _STATUS_IDLE: "Idle",
    _STATUS_THINKING: "Thinking",
    _STATUS_WORKING: "Working",
    _STATUS_ERROR: "Error",
}


def _add_shadow(widget: QWidget, blur: int = 24, y: int = 4, alpha: int = 132) -> None:
    """Soft drop shadow — used everywhere instead of 1px borders."""
    eff = QGraphicsDropShadowEffect(widget)
    eff.setBlurRadius(blur)
    eff.setOffset(0, y)
    eff.setColor(QColor(0, 0, 0, alpha))
    widget.setGraphicsEffect(eff)


# ---------------------------------------------------------------------------
# Agent card — pretty
# ---------------------------------------------------------------------------


class AgentCard(QFrame):
    """One agent's card — self-contained: header, picker, embedded log.

    The card carries its own message log (inline QTextEdit) so the user can
    read what *this specific agent* is doing without a separate global stream
    panel. When the agent is "talking" (status thinking / working) the entire
    card flips to a green-tinted gradient — visually loud, no question who's
    active. Errors flip to a red gradient.
    """

    # Gradient stops for each status, applied to the card body. The "talking"
    # states share the green gradient; idle has a per-role baseline; error
    # is a deep red. Status dot + badge still render too — gradient is the
    # peripheral-vision signal, dot/badge is the precise one.
    _GRADIENTS_LEADER = {
        _STATUS_IDLE:     ("#2a3252", "#1c2030"),
        _STATUS_THINKING: ("#1d4a36", "#15281e"),
        _STATUS_WORKING:  ("#1d4a36", "#15281e"),
        _STATUS_ERROR:    ("#4a1d22", "#28151a"),
    }
    _GRADIENTS_SPECIALIST = {
        _STATUS_IDLE:     ("#222732", "#191c24"),
        _STATUS_THINKING: ("#1d3a2a", "#13211a"),
        _STATUS_WORKING:  ("#1d3a2a", "#13211a"),
        _STATUS_ERROR:    ("#3a1d22", "#211418"),
    }

    def __init__(
        self,
        role: Role,
        on_install_local,
        parent: Optional[QWidget] = None,
    ) -> None:
        super().__init__(parent)
        self.role = role
        self._status = _STATUS_IDLE

        self.setObjectName("AgentCard")
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.setMinimumSize(QSize(320, 280))

        _add_shadow(self)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(18, 14, 18, 14)
        layout.setSpacing(8)

        # Header — single row with everything that doesn't need to be
        # full-width: avatar, name+tag, model picker, status dot, status
        # badge. Previously the model picker had its own row and ate ~40px
        # of vertical space per card; moving it next to the name reclaims
        # that vertical real estate for the log (the actually useful part).
        header = QHBoxLayout()
        header.setSpacing(12)

        from desktop_app.widgets.agent_icons import apply_to_label as _apply_icon_label
        avatar = QLabel()
        avatar.setFixedSize(52, 52)
        avatar.setAlignment(Qt.AlignCenter)
        af = QFont()
        af.setPointSize(26)
        avatar.setFont(af)
        avatar.setStyleSheet("background:transparent; color:#fff;")
        _apply_icon_label(avatar, role.icon or "🤖", size=48)
        header.addWidget(avatar)

        name_box = QVBoxLayout()
        name_box.setSpacing(0)
        self.name_label = QLabel(role.name.capitalize())
        nf = QFont()
        nf.setPointSize(15)
        nf.setBold(True)
        self.name_label.setFont(nf)
        self.name_label.setStyleSheet("color:#fff; background:transparent;")
        name_box.addWidget(self.name_label)
        tag = QLabel("Leader" if role.can_dispatch else "Specialist")
        tag.setStyleSheet(
            "color:#9aa0a6; background:transparent; font-size:11px; "
            "letter-spacing:0.6px; text-transform:uppercase;"
        )
        name_box.addWidget(tag)
        header.addLayout(name_box, 0)

        # Model picker — inline on the header row, takes the remaining
        # horizontal space.
        self.model_picker = ModelPickerButton(on_install_local=on_install_local)
        self.model_picker.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.model_picker.setMinimumHeight(34)
        header.addWidget(self.model_picker, 1)

        # Status badge + dot at the end of the row.
        self.status_badge = QLabel(_STATUS_LABEL[_STATUS_IDLE])
        self.status_badge.setAlignment(Qt.AlignCenter)
        header.addWidget(self.status_badge, 0, Qt.AlignVCenter)

        self.status_dot = QLabel()
        self.status_dot.setFixedSize(10, 10)
        header.addWidget(self.status_dot, 0, Qt.AlignVCenter)

        layout.addLayout(header)

        # Embedded message log — read-only, bounded height, internally
        # scrollable so the card itself doesn't push the page around.
        # Bounded height + word-wrap keeps the card a predictable size; the
        # internal scroll only kicks in for the rare long output.
        self.log_view = QTextEdit()
        self.log_view.setReadOnly(True)
        self.log_view.setLineWrapMode(QTextEdit.WidgetWidth)
        self.log_view.setMinimumHeight(200)
        self.log_view.setFrameShape(QFrame.NoFrame)
        # The log gets its own subtle inset panel so it reads as a nested
        # surface, not as part of the card's background gradient.
        # Font bumped to 13px — the previous 11px was unreadable on most
        # monitors, especially with long markdown replies.
        self.log_view.setStyleSheet("""
            QTextEdit {
                background: rgba(0,0,0,0.28);
                color: #e6e8eb;
                border: none;
                border-radius: 8px;
                padding: 10px 12px;
                font-size: 13px;
                line-height: 1.5;
            }
        """)
        layout.addWidget(self.log_view, 1)

        self.set_status(_STATUS_IDLE)

    # ------------------------------------------------------------------
    # Status / look
    # ------------------------------------------------------------------

    def set_status(self, status: str) -> None:
        """Update status dot, badge, AND the card body gradient.

        Talking states get the green gradient — the whole card lights up so
        you don't have to find the dot to know who's active.
        """
        self._status = status
        color = _STATUS_COLOR[status]

        # Body gradient.
        gradients = (
            self._GRADIENTS_LEADER if self.role.can_dispatch else self._GRADIENTS_SPECIALIST
        )
        top, bot = gradients[status]
        self.setStyleSheet(f"""
            QFrame#AgentCard {{
                background: qlineargradient(
                    x1:0, y1:0, x2:0, y2:1,
                    stop:0 {top}, stop:1 {bot}
                );
                border: none;
                border-radius: 14px;
            }}
        """)

        # Status dot.
        self.status_dot.setStyleSheet(f"background:{color}; border-radius:5px;")
        # Status badge.
        self.status_badge.setText(_STATUS_LABEL[status])
        self.status_badge.setStyleSheet(f"""
            color:{color};
            background:{color}22;
            border:none;
            border-radius:8px;
            padding:4px 12px;
            font-size:10px;
            font-weight:600;
            letter-spacing:0.6px;
            text-transform:uppercase;
        """)

    # ------------------------------------------------------------------
    # Log
    # ------------------------------------------------------------------

    # Per-kind line color in the embedded log. Same palette the global
    # stream used to use — kept consistent so the eye doesn't have to
    # relearn anything.
    _KIND_COLORS = {
        MessageKind.USER:        "#aaaaaa",
        MessageKind.REQUEST:     "#88c0ff",
        MessageKind.REPLY:       "#a0e0a0",
        MessageKind.THOUGHT:     "#dcb0ff",
        MessageKind.TOOL_CALL:   "#ffd080",
        MessageKind.TOOL_RESULT: "#c0c0c0",
        MessageKind.EVENT:       "#ff9090",
    }

    def append_log(self, msg: Message) -> None:
        """Render one bus message into this card's log.

        Heavy lifting:
        * Markdown -> HTML so `**bold**`, `*italic*`, ``code``, ``` blocks,
          `# headings`, and `- bullets` actually render. Without this the
          orchestrator's structured replies collapse into one run-on
          paragraph (the user-visible bug that drove this method's rewrite).
        * Per-kind framing: USER inputs as a quote-style block, REPLIES in
          a panel, THOUGHTs italicised, TOOL_CALLs as code-style one-liners.
        * Horizontal separator between successive entries so the eye can
          chunk the log into distinct turns.
        """
        color = self._KIND_COLORS.get(msg.kind, "#cccccc")
        tag = msg.kind.value.upper()
        raw = (msg.body or "").strip()

        if msg.kind == MessageKind.TOOL_CALL:
            # Tool calls fit on one line; render as code, no markdown pass.
            inner = _escape_html(raw)
            body_html = (
                f"<code style='color:#e8d29a; background:rgba(255,210,128,0.10); "
                f"border-radius:4px; padding:2px 8px; font-size:13px;'>{inner}</code>"
            )
        elif msg.kind == MessageKind.TOOL_RESULT:
            # Tool output is often multi-line text. Strip blank-line runs so
            # the log stays compact, render as preformatted, no markdown.
            short = "\n".join(line for line in raw.splitlines() if line.strip())
            inner = _escape_html(short)
            body_html = (
                f"<pre style='color:#bdc1c6; background:rgba(0,0,0,0.25); "
                f"border-radius:6px; padding:8px 10px; margin:6px 0; "
                f"font-size:12px; white-space:pre-wrap;'>{inner}</pre>"
            )
        elif msg.kind == MessageKind.USER:
            # User goal — quote-style, prominent.
            html = _markdown_to_html(raw)
            body_html = (
                f"<div style='border-left:3px solid #5a6376; "
                f"padding:4px 10px; margin:4px 0; color:#dadcdf;'>"
                f"<b>{html}</b></div>"
            )
        elif msg.kind == MessageKind.THOUGHT:
            html = _markdown_to_html(raw)
            body_html = (
                f"<div style='color:#cdd0d4; font-style:italic; "
                f"margin:2px 0;'>{html}</div>"
            )
        elif msg.kind == MessageKind.REPLY:
            # The most readable item in the log — give it a proper panel.
            html = _markdown_to_html(raw)
            body_html = (
                f"<div style='color:#e6e8eb; background:rgba(160,224,160,0.05); "
                f"border-left:3px solid #4caf50; padding:6px 10px; margin:4px 0; "
                f"border-radius:0 6px 6px 0;'>{html}</div>"
            )
        else:  # EVENT, REQUEST, etc.
            html = _markdown_to_html(raw)
            body_html = f"<div style='color:#eee; margin:2px 0;'>{html}</div>"

        line = (
            f"<div style='margin:0 0 6px 0;'>"
            f"<div style='color:{color}; font-size:11px; font-weight:600; "
            f"letter-spacing:0.6px; margin-bottom:4px;'>[{tag}]</div>"
            f"{body_html}"
            f"</div>"
            # Subtle separator between successive log entries so the eye
            # can chunk the log into discrete turns.
            f"<div style='border-bottom:1px solid rgba(255,255,255,0.06); "
            f"margin:10px 0;'></div>"
        )
        self.log_view.append(line)
        sb = self.log_view.verticalScrollBar()
        sb.setValue(sb.maximum())

    def clear_log(self) -> None:
        self.log_view.clear()


# ---------------------------------------------------------------------------
# Approval card
# ---------------------------------------------------------------------------


class ApprovalCard(QFrame):
    """Pending approval rendered as its own panel — no shared list."""

    def __init__(self, request: ApprovalRequest, on_resolve, parent=None) -> None:
        super().__init__(parent)
        self.request = request
        self._on_resolve = on_resolve

        self.setObjectName("ApprovalCard")
        self.setStyleSheet("""
            QFrame#ApprovalCard {
                background: qlineargradient(
                    x1:0, y1:0, x2:0, y2:1,
                    stop:0 #2a1d22, stop:1 #1c1418
                );
                border: none;
                border-radius: 12px;
            }
        """)
        _add_shadow(self, blur=18, y=2, alpha=108)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(18, 12, 18, 12)
        layout.setSpacing(12)

        text_box = QVBoxLayout()
        text_box.setSpacing(2)
        title = QLabel(
            f"<b>{request.agent}</b> wants to call <code>{request.tool_name}</code>"
        )
        title.setStyleSheet(
            "color:#ffb0b0; background:transparent; font-size:12px;"
        )
        text_box.addWidget(title)
        args_line = QLabel(_short_args(request.args))
        args_line.setStyleSheet(
            "color:#9aa0a6; background:transparent; font-size:11px;"
        )
        args_line.setWordWrap(True)
        text_box.addWidget(args_line)
        layout.addLayout(text_box, 1)

        approve = QPushButton("✓ Approve")
        approve.setMinimumHeight(32)
        approve.setStyleSheet("""
            QPushButton {
                background:#4caf50; color:white;
                border:none; border-radius:8px;
                padding:0 16px; font-weight:600;
            }
            QPushButton:hover { background:#5cbf60; }
        """)
        approve.clicked.connect(
            lambda: self._on_resolve(self.request, ApprovalDecision.APPROVE)
        )
        reject = QPushButton("✗ Reject")
        reject.setMinimumHeight(32)
        reject.setStyleSheet("""
            QPushButton {
                background:rgba(255,140,140,0.12); color:#ff8c8c;
                border:none; border-radius:8px;
                padding:0 16px; font-weight:600;
            }
            QPushButton:hover { background:rgba(255,140,140,0.24); }
        """)
        reject.clicked.connect(
            lambda: self._on_resolve(self.request, ApprovalDecision.REJECT)
        )
        layout.addWidget(approve)
        layout.addWidget(reject)


# ---------------------------------------------------------------------------
# Page
# ---------------------------------------------------------------------------


class AgentsPage(QWidget):
    # Per-agent model selection persists in QSettings under this prefix —
    # one key per role name (kept for legacy / global default). Per-project
    # overrides live in ``Project.model_overrides`` so each project can
    # pick its own models without touching the user's global default.
    _SETTINGS_VENDOR = "LocaLLM"
    _SETTINGS_APP = "OWLLM"
    _SETTINGS_PREFIX = "agents/model_for/"
    _SETTINGS_ACTIVE_PROJECT = "agents/active_project_id"

    def __init__(self, main_window=None, parent=None) -> None:
        super().__init__(parent)
        self.main_window = main_window
        self._bus = get_bus()
        self._registry = builtin_registry()
        self._team: Optional[Team] = None
        self._current_goal_id: Optional[str] = None
        self._cards: Dict[str, AgentCard] = {}
        self._approval_cards: Dict[str, ApprovalCard] = {}

        self._settings = QSettings(self._SETTINGS_VENDOR, self._SETTINGS_APP)
        self._project_store = get_project_store()
        self._active_project: Optional[Project] = None

        self._bridge = _BusBridge()
        self._bridge.message.connect(self._on_bus_message)
        self._bridge.approval_requested.connect(self._on_approval_requested)

        self._ensure_default_project()
        self._build_ui()
        self._wire_bus()
        self._kick_off_bootstrap()
        # Restore active project from settings (or pick first), populate the
        # team grid + selectors. Selection persistence is wired AFTER the
        # initial pickers populate.
        self._load_active_project()
        self._wire_selection_persistence()
        # Fast critical-deps probe — fires on page open in <100 ms. If
        # anything's missing in the OWLLM Python, surface a "Repair?" dialog
        # IMMEDIATELY rather than waiting 2-3 minutes for the slow
        # `pip list` Requirements scan to also figure it out. Deferred to
        # the next event-loop turn so the page is fully laid out first.
        QTimer.singleShot(150, self._fast_critical_deps_probe)

    def _ensure_default_project(self) -> None:
        """First-run convenience — if no projects exist, seed one with the
        full built-in team. Without this the workspace would open empty
        and the user would have to create a project before doing anything."""
        if self._project_store.list_projects():
            return
        all_defs = list_all_definitions()
        team = sorted(
            (d.name for d in all_defs.values() if d.built_in),
            key=lambda n: (0 if all_defs[n].can_dispatch else 1, n),
        )
        self._project_store.save_project(
            Project(
                name="My first project",
                description="Default OWLLM team — orchestrator + four specialists.",
                team=team,
            )
        )

    # ------------------------------------------------------------------
    # UI
    # ------------------------------------------------------------------

    def _build_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(18, 16, 18, 16)
        outer.setSpacing(12)

        # Bootstrap progress strip.
        self.bootstrap_frame = QFrame()
        self.bootstrap_frame.setFrameShape(QFrame.NoFrame)
        self.bootstrap_frame.setStyleSheet("""
            QFrame {
                background:#23283a;
                border:none;
                border-radius:10px;
            }
        """)
        bs = QVBoxLayout(self.bootstrap_frame)
        bs.setContentsMargins(14, 10, 14, 10)
        self.bootstrap_label = QLabel("Checking agent runtime dependencies…")
        self.bootstrap_label.setStyleSheet(
            "color:#c9d1ff; background:transparent;"
        )
        self.bootstrap_progress = QProgressBar()
        self.bootstrap_progress.setRange(0, 0)
        self.bootstrap_progress.setTextVisible(False)
        self.bootstrap_progress.setFixedHeight(6)
        bs.addWidget(self.bootstrap_label)
        bs.addWidget(self.bootstrap_progress)
        outer.addWidget(self.bootstrap_frame)
        self.bootstrap_frame.setVisible(False)

        # Project selector + team picker — the only top-of-page strip now.
        # Accounts moved out entirely; their dedicated 🔐 Accounts tab is
        # the place to manage connection state, and the 4-chip summary
        # here was redundant noise.
        outer.addWidget(self._build_project_strip())

        # Goal row + (initially-hidden) attachment chip strip beneath it.
        outer.addLayout(self._build_goal_row())
        outer.addWidget(self._build_attachment_strip())

        # Roster fills the page. The stream panel is gone — each card now
        # carries its own embedded log, so the active agent's output reads
        # in place. The status gradient on the card is the at-a-glance
        # "who's talking" cue; no global timeline needed.
        outer.addWidget(self._build_roster(), 1)

        # Approvals.
        outer.addWidget(self._build_approvals_area())

        # Pull entries into pickers now.
        self._refresh_pickers()

    def _build_accounts_strip(self) -> QWidget:
        frame = QFrame()
        frame.setObjectName("AccountsStrip")
        frame.setStyleSheet("""
            QFrame#AccountsStrip {
                background:#181b22;
                border:none;
                border-radius:10px;
            }
        """)
        row = QHBoxLayout(frame)
        row.setContentsMargins(14, 8, 14, 8)
        row.setSpacing(14)

        title = QLabel("Accounts")
        title.setStyleSheet(
            "color:#aaa; font-size:11px; background:transparent; "
            "letter-spacing:0.6px; text-transform:uppercase;"
        )
        row.addWidget(title)

        self._account_dots: dict[str, QLabel] = {}
        for key, label in (
            ("claude_subscription", "Claude"),
            ("codex_subscription", "Codex"),
            ("anthropic_api", "Anthropic"),
            ("openai_api", "OpenAI"),
        ):
            chip = QHBoxLayout()
            chip.setSpacing(6)
            dot = QLabel()
            dot.setFixedSize(8, 8)
            dot.setStyleSheet("background:#5a6376; border-radius:4px;")
            self._account_dots[key] = dot
            chip.addWidget(dot)
            text = QLabel(label)
            text.setStyleSheet(
                "color:#dadcdf; font-size:11px; background:transparent;"
            )
            chip.addWidget(text)
            host = QWidget()
            host.setLayout(chip)
            row.addWidget(host)

        row.addStretch(1)

        hint = QLabel("Manage in 🔐 Accounts tab")
        hint.setStyleSheet(
            "color:#666; font-size:11px; background:transparent;"
        )
        row.addWidget(hint)

        # Tick to refresh the dots.
        self._account_timer = QTimer(self)
        self._account_timer.setInterval(3000)
        self._account_timer.timeout.connect(self._refresh_account_dots)
        self._account_timer.start()
        self._refresh_account_dots()

        return frame

    def _build_goal_row(self) -> QHBoxLayout:
        top = QHBoxLayout()
        top.setSpacing(10)
        # Pending attachments — picked via the 📎 button or dropped onto
        # the goal input. Cleared after each Run. Stored as raw paths so
        # we only call adopt_local_path() at submit time and don't keep a
        # bunch of half-prepared Attachment objects around.
        self._pending_attachment_paths: List[str] = []

        # 📎 attach button — opens a file picker that filters to audio
        # and image types (no video, the bridges don't accept video either).
        self.attach_btn = QPushButton("📎")
        self.attach_btn.setMinimumHeight(38)
        self.attach_btn.setMinimumWidth(44)
        self.attach_btn.setToolTip("Attach an image or audio file")
        self.attach_btn.setStyleSheet("""
            QPushButton {
                background:#14171d;
                color:#dadcdf;
                border:none;
                border-radius:10px;
                font-size:16px;
            }
            QPushButton:hover { background:#1a1d24; }
        """)
        self.attach_btn.clicked.connect(self._on_attach_clicked)

        self.goal_input = _GoalLineEdit(on_files_dropped=self._add_attachment_paths)
        self.goal_input.setPlaceholderText(
            "Goal — e.g. 'summarise the last commit and propose a follow-up' "
            "(drop an image / audio here)"
        )
        self.goal_input.setMinimumHeight(38)
        self.goal_input.setStyleSheet("""
            QLineEdit {
                background:#14171d;
                color:#fff;
                border:none;
                border-radius:10px;
                padding:0 14px;
                font-size:13px;
            }
            QLineEdit:focus { background:#1a1d24; }
        """)
        self.goal_input.returnPressed.connect(self._run_clicked)

        self.run_btn = QPushButton("Run")
        self.run_btn.setMinimumHeight(38)
        self.run_btn.setStyleSheet("""
            QPushButton {
                background:#4a6cff; color:white;
                border:none; border-radius:10px;
                padding:0 24px; font-weight:600;
            }
            QPushButton:hover { background:#5a7bff; }
            QPushButton:disabled { background:#2c313c; color:#777; }
        """)
        self.run_btn.clicked.connect(self._run_clicked)

        self.cancel_btn = QPushButton("Cancel")
        self.cancel_btn.setMinimumHeight(38)
        self.cancel_btn.setStyleSheet("""
            QPushButton {
                background:rgba(255,140,140,0.10); color:#ff8c8c;
                border:none; border-radius:10px;
                padding:0 18px;
            }
            QPushButton:hover { background:rgba(255,140,140,0.22); }
            QPushButton:disabled { color:#555; background:transparent; }
        """)
        self.cancel_btn.clicked.connect(self._cancel_clicked)
        self.cancel_btn.setEnabled(False)
        top.addWidget(self.attach_btn)
        top.addWidget(self.goal_input, 1)
        top.addWidget(self.run_btn)
        top.addWidget(self.cancel_btn)
        return top

    # ------------------------------------------------------------------
    # Attachment chip strip — appears below the goal row when files
    # are attached, hidden when the queue is empty.
    # ------------------------------------------------------------------

    def _build_attachment_strip(self) -> QWidget:
        self.attachment_strip = QFrame()
        self.attachment_strip.setFrameShape(QFrame.NoFrame)
        self.attachment_strip.setStyleSheet("background:transparent;")
        self.attachment_strip.setVisible(False)
        layout = QHBoxLayout(self.attachment_strip)
        layout.setContentsMargins(46, 0, 0, 0)  # align under the prompt input
        layout.setSpacing(6)
        layout.addStretch(1)
        self._attachment_strip_layout = layout
        return self.attachment_strip

    def _on_attach_clicked(self) -> None:
        """Pop a file picker filtered to the supported audio + image types."""
        filters = (
            "Audio or images (*.png *.jpg *.jpeg *.webp *.gif *.bmp *.heic "
            "*.ogg *.oga *.opus *.mp3 *.wav *.m4a *.aac *.flac *.mp4)"
            ";;All files (*)"
        )
        paths, _ = QFileDialog.getOpenFileNames(self, "Attach files", "", filters)
        if paths:
            self._add_attachment_paths(paths)

    def _add_attachment_paths(self, paths: List[str]) -> None:
        """Append paths to the pending queue, dropping unsupported files."""
        added = 0
        for p in paths or []:
            if not p or p in self._pending_attachment_paths:
                continue
            # We can't fully validate without reading bytes; do the
            # cheap MIME guess up-front so a stray .pdf doesn't sit in
            # the strip pretending it'll be sent.
            from core.agents.attachments import classify_mime
            guess = classify_mime("", p)
            if guess is None:
                logger.info("ignoring unsupported attachment: %s", p)
                continue
            self._pending_attachment_paths.append(p)
            added += 1
        if added:
            self._refresh_attachment_strip()

    def _remove_attachment_path(self, path: str) -> None:
        try:
            self._pending_attachment_paths.remove(path)
        except ValueError:
            return
        self._refresh_attachment_strip()

    def _refresh_attachment_strip(self) -> None:
        # Wipe existing chips, keeping the trailing stretch.
        layout = self._attachment_strip_layout
        while layout.count() > 1:
            item = layout.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()
        for path in self._pending_attachment_paths:
            chip = self._make_attachment_chip(path)
            layout.insertWidget(layout.count() - 1, chip)
        self.attachment_strip.setVisible(bool(self._pending_attachment_paths))

    def _make_attachment_chip(self, path: str) -> QWidget:
        from core.agents.attachments import classify_mime
        kind = classify_mime("", path) or KIND_AUDIO
        glyph = "🖼️" if kind == KIND_IMAGE else "🎵"
        name = os.path.basename(path)

        chip = QFrame()
        chip.setStyleSheet("""
            QFrame {
                background:#1a1f2c;
                border:1px solid #2a3142;
                border-radius:14px;
            }
            QLabel { background:transparent; color:#dadcdf; }
            QPushButton {
                background:transparent;
                color:#9aa3b2;
                border:none;
                font-size:14px;
                padding:0 4px;
            }
            QPushButton:hover { color:#ff7777; }
        """)
        chip_layout = QHBoxLayout(chip)
        chip_layout.setContentsMargins(10, 4, 6, 4)
        chip_layout.setSpacing(6)
        chip_layout.addWidget(QLabel(glyph))
        label = QLabel(name)
        label.setMaximumWidth(220)
        chip_layout.addWidget(label)
        remove = QPushButton("×")
        remove.setCursor(Qt.PointingHandCursor)
        remove.setToolTip(f"Remove {name}")
        remove.clicked.connect(lambda _=False, p=path: self._remove_attachment_path(p))
        chip_layout.addWidget(remove)
        return chip

    def _consume_pending_attachments(self) -> List[Attachment]:
        """Move pending paths into ``Attachment`` objects + reset the strip.

        Called at submit time. Files that fail validation (oversized,
        wrong mime after a closer look, unreadable) are silently dropped.
        Returns an empty list when nothing is queued.
        """
        out: List[Attachment] = []
        # The real goal id is created inside ``team.run_goal``; we don't
        # know it yet, so save under the "chat-pending" slot. The runtime
        # cleanup script can sweep that dir on app start later.
        for path in list(self._pending_attachment_paths):
            att = adopt_local_path(
                "chat-pending",
                path,
                source="chat",
            )
            if att is not None:
                out.append(att)
        self._pending_attachment_paths.clear()
        self._refresh_attachment_strip()
        return out

    def _build_roster(self) -> QWidget:
        """Two-pane workspace: canvas (left) + per-agent log (right).

        The canvas hosts draggable agent nodes connected by directional
        arrows. The right pane shows the log of whichever agent is
        currently selected; if none is selected, it shows the orchestrator's
        view (the broadest stream).

        While a goal runs, the active agent's node turns green via
        :py:meth:`AgentCanvas.set_node_status`. Clicking another node
        re-points the log pane at THAT agent's history without affecting
        the run.
        """
        # Per-agent message buffers, keyed by agent name. Each agent's log
        # is the union of (a) messages it sent, (b) messages addressed
        # to it. We store messages and re-render the right pane whenever
        # the selection changes or a new message arrives for the selected
        # agent. Cleared on team rebuild.
        self._agent_logs: Dict[str, list] = {}
        self._selected_agent: Optional[str] = None
        # Per-card model pickers used to live on AgentCard. With the canvas
        # they live in a row inside the right pane (compact strip).
        self._cards = {}  # legacy attribute kept for `_render_team` clear
        self._model_picker_buttons: Dict[str, ModelPickerButton] = {}

        splitter = QSplitter(Qt.Horizontal)
        splitter.setHandleWidth(8)
        splitter.setStyleSheet("""
            QSplitter::handle {
                background:#1a1f2c;
                border-radius:3px;
            }
        """)

        # ---------------------------- LEFT: canvas ----------------------------
        left = QFrame()
        left.setFrameShape(QFrame.NoFrame)
        lv = QVBoxLayout(left)
        lv.setContentsMargins(0, 0, 0, 0)
        lv.setSpacing(8)

        canvas_header = QHBoxLayout()
        title = QLabel("Flow")
        tf = QFont()
        tf.setPointSize(12)
        tf.setBold(True)
        title.setFont(tf)
        title.setStyleSheet("color:#fff; background:transparent;")
        canvas_header.addWidget(title)
        hint = QLabel("· Drag from the cyan dot on a node to another node to connect them. Right-click a node for settings.")
        hint.setStyleSheet("color:#7888a8; font-size:10pt; background:transparent;")
        canvas_header.addWidget(hint)
        canvas_header.addStretch(1)

        delete_edge_btn = QPushButton("✕ Edge")
        delete_edge_btn.setToolTip("Delete the selected edge (or press Delete)")
        delete_edge_btn.setStyleSheet(_GHOST_BTN_STYLE_SMALL)
        delete_edge_btn.clicked.connect(self._on_delete_selected_edge)
        canvas_header.addWidget(delete_edge_btn)

        reverse_edge_btn = QPushButton("⇄ Reverse")
        reverse_edge_btn.setToolTip("Reverse the direction of the selected edge")
        reverse_edge_btn.setStyleSheet(_GHOST_BTN_STYLE_SMALL)
        reverse_edge_btn.clicked.connect(self._on_reverse_selected_edge)
        canvas_header.addWidget(reverse_edge_btn)

        layout_btn = QPushButton("⟲ Layout")
        layout_btn.setToolTip("Auto-arrange agents in a grid")
        layout_btn.setStyleSheet(_GHOST_BTN_STYLE_SMALL)
        layout_btn.clicked.connect(self._on_reset_layout)
        canvas_header.addWidget(layout_btn)

        refresh = QPushButton("⟳")
        refresh.setFixedSize(30, 28)
        refresh.setToolTip("Refresh model lists in every picker")
        refresh.setStyleSheet(_GHOST_BTN_STYLE_SMALL)
        refresh.clicked.connect(self._refresh_pickers)
        canvas_header.addWidget(refresh)

        # Diagram-vs-Graph toggle. Orbital diagram is the default — it
        # carries the live activity animation (agents glow green when
        # working, click an agent to see its skill card). The graph
        # editor stays one click away for users who want to rewire
        # edges manually.
        self._view_toggle_btn = QPushButton("◐ Graph view")
        self._view_toggle_btn.setToolTip("Switch between the live diagram and the editable graph")
        self._view_toggle_btn.setStyleSheet(_GHOST_BTN_STYLE_SMALL)
        self._view_toggle_btn.setCheckable(True)
        self._view_toggle_btn.clicked.connect(self._on_view_toggle_clicked)
        canvas_header.addWidget(self._view_toggle_btn)
        lv.addLayout(canvas_header)

        # Live orbital diagram — the new default visual.
        self.team_canvas = AgentTeamCanvas()
        self.team_canvas.node_selected.connect(self._on_canvas_node_selected)

        # Editable graph canvas — kept for power-user workflows.
        self.canvas = AgentCanvas()
        self.canvas.node_selected.connect(self._on_canvas_node_selected)
        self.canvas.graph_changed.connect(self._on_graph_changed)
        self.canvas.node_context_menu_requested.connect(self._on_canvas_node_context_menu)

        # Stack the two visuals so we can flip between them with the
        # toggle button. Orbital lives at index 0 (default).
        # IMPORTANT: explicitly hide the non-current widget — relying on
        # setCurrentIndex alone has caused the AgentCanvas to bleed
        # through on some Qt versions, leaving the user staring at an
        # almost-empty graph editor instead of the orbital diagram.
        self._canvas_stack = QStackedWidget()
        self._canvas_stack.addWidget(self.team_canvas)  # 0
        self._canvas_stack.addWidget(self.canvas)        # 1
        self._canvas_stack.setCurrentIndex(0)
        self.team_canvas.setVisible(True)
        self.canvas.setVisible(False)
        lv.addWidget(self._canvas_stack, 1)

        self.status_label = QLabel("Idle.")
        self.status_label.setStyleSheet(
            "color:#888; font-size:11px; background:transparent;"
        )
        lv.addWidget(self.status_label)

        splitter.addWidget(left)

        # ---------------------------- RIGHT: log ----------------------------
        right = QFrame()
        right.setFrameShape(QFrame.NoFrame)
        rv = QVBoxLayout(right)
        rv.setContentsMargins(0, 0, 0, 0)
        rv.setSpacing(8)

        # Header that names the currently-selected agent.
        self.log_header = QLabel("Click an agent on the canvas to view its log.")
        lf = QFont()
        lf.setPointSize(12)
        lf.setBold(True)
        self.log_header.setFont(lf)
        self.log_header.setStyleSheet("color:#fff; background:transparent;")
        rv.addWidget(self.log_header)

        # Compact model picker for the SELECTED agent only — clicking a
        # different node swaps which picker is shown. Stored in a stack-y
        # host so we can show/hide them cheaply.
        self.picker_host = QFrame()
        self.picker_host.setStyleSheet("background:transparent;")
        ph = QHBoxLayout(self.picker_host)
        ph.setContentsMargins(0, 0, 0, 4)
        ph.setSpacing(8)
        self._picker_label = QLabel("Model")
        self._picker_label.setStyleSheet(
            "color:#aaa; font-size:11px; background:transparent; "
            "letter-spacing:0.6px; text-transform:uppercase;"
        )
        ph.addWidget(self._picker_label)
        self._picker_slot = QWidget()
        self._picker_slot_layout = QHBoxLayout(self._picker_slot)
        self._picker_slot_layout.setContentsMargins(0, 0, 0, 0)
        self._picker_slot_layout.setSpacing(0)
        ph.addWidget(self._picker_slot, 1)
        rv.addWidget(self.picker_host)
        self.picker_host.setVisible(False)

        # Two-tab log surface: Reply (filtered, default) + Thought (raw
        # chain-of-thought stripped from model output). Selecting an agent
        # reopens the Reply tab so users see the answer first.
        log_view_css = """
            QTextEdit {
                background:#0f1218;
                color:#cbd2e0;
                border:none; border-radius:8px;
                padding:10px;
                font-family: Consolas, 'JetBrains Mono', monospace;
                font-size:12px;
            }
        """
        self._chat_view = QTextEdit()
        self._chat_view.setReadOnly(True)
        self._chat_view.setStyleSheet(log_view_css)

        self._thought_view = QTextEdit()
        self._thought_view.setReadOnly(True)
        self._thought_view.setStyleSheet(log_view_css)

        self._log_tabs = QTabWidget()
        self._log_tabs.addTab(self._chat_view, "💬 Reply")
        self._log_tabs.addTab(self._thought_view, "🧠 Thought")
        self._log_tabs.setCurrentIndex(0)
        rv.addWidget(self._log_tabs, 1)
        # Back-compat alias — older code paths (clear, render) still call
        # self.log_view.clear(); the alias keeps them working but writes
        # only to the Reply tab. Thought clearing is handled explicitly.
        self.log_view = self._chat_view

        splitter.addWidget(right)
        splitter.setStretchFactor(0, 2)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([800, 420])

        # Wrap the splitter in a QStackedWidget so we can show an animated
        # loader on top while the requirements scan + agent runtime
        # bootstrap are still resolving (1-2 min on a fresh start). Once
        # both are done we flip to the splitter and the user sees the
        # canvas + log workspace.
        self._workspace_stack = QStackedWidget()
        # IMPORTANT: add the loader FIRST so it becomes the default visible
        # page — Qt's QStackedWidget shows the first inserted widget when
        # ``setCurrentIndex`` hasn't yet had a layout pass. The earlier
        # ordering (splitter then loader) caused the splitter to flash on
        # screen for a frame before the index was forced to 1, which
        # together with the "instant flip" bug below made the loader
        # invisible.
        self._canvas_loader = AgentCanvasLoader()
        self._workspace_stack.addWidget(self._canvas_loader)  # index 0 — loader
        self._workspace_stack.addWidget(splitter)             # index 1 — real workspace
        self._workspace_stack.setCurrentIndex(0)
        self._loading_done = False
        self._loading_finish_timer: Optional[QTimer] = None
        # When the loader was constructed — used to enforce a MINIMUM
        # display time so the animation is always visible even on fast
        # boots where everything reports ready in <1s. Without this,
        # `_poll_loading_state` flips to the workspace in ~500 ms and
        # the user sees a black flash instead of the constellation.
        import time as _time_module
        self._loader_started_at = _time_module.monotonic()
        # Minimum 4 s. Long enough to read the status text, short enough
        # not to feel like a chore on a healthy install.
        self._loader_min_seconds = 4.0

        # Periodically poll the main window's requirements thread state.
        # When that thread reports done AND the agent runtime bootstrap is
        # also done, flip the stack to the workspace.
        self._loading_poll_timer = QTimer(self)
        self._loading_poll_timer.setInterval(500)
        self._loading_poll_timer.timeout.connect(self._poll_loading_state)
        self._loading_poll_timer.start()

        return self._workspace_stack

    # ------------------------------------------------------------------
    # Project strip + team rendering
    # ------------------------------------------------------------------

    def _build_project_strip(self) -> QWidget:
        frame = QFrame()
        frame.setObjectName("ProjectStrip")
        frame.setStyleSheet("""
            QFrame#ProjectStrip {
                background: qlineargradient(
                    x1:0, y1:0, x2:0, y2:1,
                    stop:0 #1f2632, stop:1 #181b22
                );
                border:none; border-radius:10px;
            }
        """)
        row = QHBoxLayout(frame)
        row.setContentsMargins(14, 10, 14, 10)
        row.setSpacing(10)

        # Location FIRST, on the same row as the project picker. Free-form
        # text — folder path, server alias, GitHub URL, anything that
        # answers "where does this project live?". Saved on the project
        # whenever the field loses focus.
        loc_label = QLabel("Location")
        loc_label.setStyleSheet(
            "color:#aaa; font-size:11px; background:transparent; "
            "letter-spacing:0.6px; text-transform:uppercase;"
        )
        row.addWidget(loc_label)

        self._location_input = QLineEdit()
        self._location_input.setMinimumHeight(32)
        self._location_input.setPlaceholderText(
            "/path/to/repo · esp-flash · github.com/me/x"
        )
        self._location_input.setStyleSheet("""
            QLineEdit {
                background:#14171d; color:#fff; border:none;
                border-radius:8px; padding:0 12px; font-size:13px;
            }
            QLineEdit:focus { background:#1a1d24; }
        """)
        # Persist whenever the user finishes typing (focus-out or Enter).
        self._location_input.editingFinished.connect(self._on_location_changed)
        row.addWidget(self._location_input, 2)

        label = QLabel("Project")
        label.setStyleSheet(
            "color:#aaa; font-size:11px; background:transparent; "
            "letter-spacing:0.6px; text-transform:uppercase;"
        )
        row.addWidget(label)

        self._project_combo = QComboBox()
        self._project_combo.setMinimumHeight(32)
        self._project_combo.setMinimumWidth(200)
        self._project_combo.setStyleSheet("""
            QComboBox {
                background:#14171d; color:#fff; border:none;
                border-radius:8px; padding:0 12px; font-size:13px;
            }
        """)
        self._project_combo.currentIndexChanged.connect(self._on_project_combo_changed)
        row.addWidget(self._project_combo, 2)

        # Edit team button — opens a dialog with checkboxes for every
        # AgentDefinition (built-in + custom).
        edit_team_btn = QPushButton("Team…")
        edit_team_btn.setMinimumHeight(32)
        edit_team_btn.setStyleSheet(_GHOST_BTN_STYLE)
        edit_team_btn.clicked.connect(self._open_team_picker)
        row.addWidget(edit_team_btn)

        new_btn = QPushButton("+ New")
        new_btn.setMinimumHeight(32)
        new_btn.setStyleSheet(_GHOST_BTN_STYLE)
        new_btn.clicked.connect(self._on_new_project)
        row.addWidget(new_btn)

        rename_btn = QPushButton("Rename")
        rename_btn.setMinimumHeight(32)
        rename_btn.setStyleSheet(_GHOST_BTN_STYLE)
        rename_btn.clicked.connect(self._on_rename_project)
        row.addWidget(rename_btn)

        delete_btn = QPushButton("Delete")
        delete_btn.setMinimumHeight(32)
        delete_btn.setStyleSheet(_DESTRUCTIVE_GHOST_STYLE)
        delete_btn.clicked.connect(self._on_delete_project)
        row.addWidget(delete_btn)

        return frame

    def _populate_project_combo(self) -> None:
        self._project_combo.blockSignals(True)
        self._project_combo.clear()
        for p in self._project_store.list_projects():
            self._project_combo.addItem(p.name, p.id)
        if self._active_project is not None:
            idx = self._project_combo.findData(self._active_project.id)
            if idx >= 0:
                self._project_combo.setCurrentIndex(idx)
        self._project_combo.blockSignals(False)
        # Keep the location field in lockstep with whichever project is now
        # active.
        self._sync_location_input()

    def _sync_location_input(self) -> None:
        """Mirror the active project's location into the input (sans signal)."""
        if not hasattr(self, "_location_input"):
            return
        self._location_input.blockSignals(True)
        self._location_input.setText(
            self._active_project.location if self._active_project else ""
        )
        self._location_input.blockSignals(False)

    def _on_location_changed(self) -> None:
        """Persist edits to the location field on focus-out / Enter."""
        if self._active_project is None:
            return
        new_loc = self._location_input.text().strip()
        if new_loc == (self._active_project.location or ""):
            return
        self._active_project.location = new_loc
        try:
            self._project_store.save_project(self._active_project)
        except Exception:
            logger.exception("could not save project location")

    def _load_active_project(self) -> None:
        """Resolve the active project from settings (or first available)
        and render its team."""
        saved = self._settings.value(self._SETTINGS_ACTIVE_PROJECT, "")
        target: Optional[Project] = None
        if isinstance(saved, str) and saved:
            target = self._project_store.get_project(saved)
        if target is None:
            projs = self._project_store.list_projects()
            target = projs[0] if projs else None
        self._active_project = target
        self._populate_project_combo()
        self._render_team()

    def _switch_project(self, project_id: str) -> None:
        proj = self._project_store.get_project(project_id)
        if proj is None:
            return
        self._active_project = proj
        self._settings.setValue(self._SETTINGS_ACTIVE_PROJECT, proj.id)
        # Drop the cached Team — its agents are bound to the previous
        # project's selection. Next Run rebuilds.
        self._team = None
        # Reset UI to a neutral idle baseline. _replay_active_project (called
        # at the end of _render_team) will restore live "Running…" state if
        # the new project's latest goal is still in flight.
        self._reset_ui_to_idle()
        # Keep the location input in step with the new project's saved
        # location.
        self._sync_location_input()
        self._render_team()

    def _reset_ui_to_idle(self) -> None:
        """Idle the run controls without writing the "Done in" summary text.

        Used on project-switch so the new project starts neutral rather
        than inheriting the previous project's run state.
        """
        if hasattr(self, "_elapsed_timer"):
            self._elapsed_timer.stop()
        self._run_started_at = None
        self._current_goal_id = None
        self.goal_input.setEnabled(True)
        self.run_btn.setEnabled(True)
        self.cancel_btn.setEnabled(False)
        self.status_label.setText("Idle.")

    def _on_project_combo_changed(self, idx: int) -> None:
        if idx < 0:
            return
        pid = self._project_combo.itemData(idx)
        if isinstance(pid, str) and (
            self._active_project is None or self._active_project.id != pid
        ):
            self._switch_project(pid)

    def _on_new_project(self) -> None:
        name, ok = QInputDialog.getText(self, "New project", "Project name:")
        if not ok or not name.strip():
            return
        # New project starts with NO team — user picks via [Team…] next.
        proj = self._project_store.save_project(
            Project(name=name.strip(), description="", team=[])
        )
        self._active_project = proj
        self._settings.setValue(self._SETTINGS_ACTIVE_PROJECT, proj.id)
        self._populate_project_combo()
        self._render_team()
        # Open the team picker so the user immediately picks members.
        self._open_team_picker()

    def _on_rename_project(self) -> None:
        if self._active_project is None:
            return
        name, ok = QInputDialog.getText(
            self, "Rename project", "New name:",
            text=self._active_project.name,
        )
        if not ok or not name.strip():
            return
        self._active_project.name = name.strip()
        self._project_store.save_project(self._active_project)
        self._populate_project_combo()

    def _on_delete_project(self) -> None:
        if self._active_project is None:
            return
        if len(self._project_store.list_projects()) <= 1:
            QMessageBox.information(
                self, "Delete project",
                "Can't delete the last project. Create a new one first.",
            )
            return
        if QMessageBox.question(
            self, "Delete project",
            f"Delete '{self._active_project.name}'? Goal history stays in the DB."
        ) != QMessageBox.Yes:
            return
        self._project_store.delete_project(self._active_project.id)
        self._active_project = None
        self._settings.remove(self._SETTINGS_ACTIVE_PROJECT)
        self._load_active_project()

    def _open_team_picker(self) -> None:
        if self._active_project is None:
            return
        defs = list_all_definitions()
        dlg = _TeamPickerDialog(
            available=defs,
            selected=set(self._active_project.team),
            parent=self,
        )
        if dlg.exec() == QDialog.Accepted:
            self._active_project.team = dlg.selected_names()
            self._project_store.save_project(self._active_project)
            self._team = None  # rebuild on next Run
            self._render_team()

    # ------------------------------------------------------------------
    # Team rendering
    # ------------------------------------------------------------------

    def refresh_after_definitions_changed(self) -> None:
        """Re-render the team using the latest agent definitions on disk.

        Called by the host after the Studio saves/deletes an agent so
        cards, the graph editor, and the orbital diagram pick up the
        new icon / description / tools without needing a project switch.
        """
        self._team = None  # force a rebuild from the persisted defs
        self._render_team()

    def _render_team(self) -> None:
        """(Re)populate the canvas + per-agent log buffers for the active project.

        Called on init, on project switch, and on team-edit. Loads any
        saved graph (positions + edges) from ``project.graph_json`` and
        adds/removes nodes so the canvas matches the current ``team``
        list. Edges referencing removed agents drop automatically.
        """
        # Clear caches that pertain to the previous team.
        self._agent_logs = {}
        self._selected_agent = None
        for btn in list(self._model_picker_buttons.values()):
            btn.setParent(None)
            btn.deleteLater()
        self._model_picker_buttons.clear()
        self.log_view.clear()
        self.log_header.setText("Click an agent on the canvas to view its log.")
        self.picker_host.setVisible(False)

        if self._active_project is None or not self._active_project.team:
            self.canvas.load_graph(AgentGraph(), orchestrator=None)
            self.status_label.setText(
                "No agents on this team yet — click Team… to add some."
            )
            return

        defs = list_all_definitions()
        team_defs: List[AgentDefinition] = [
            defs[name] for name in self._active_project.team if name in defs
        ]
        leader = next((d for d in team_defs if d.can_dispatch), None)
        leader_name = leader.name if leader is not None else None

        # Load saved graph; reconcile with current team membership.
        saved = AgentGraph.from_json_string(self._active_project.graph_json or "")
        present_names = {d.name for d in team_defs}
        # Drop nodes/edges that reference agents no longer on the team.
        saved.nodes = [n for n in saved.nodes if n.name in present_names]
        saved.edges = [e for e in saved.edges
                       if e.source in present_names and e.target in present_names]
        # Add any newly-added team members (not yet in graph). When a
        # member is added to an EXISTING graph (some nodes already
        # have positions), the default (0, 0) would pile the new
        # node on top of the orchestrator and make the graph look
        # like it didn't update. Instead, drop new nodes to the
        # right of the rightmost positioned node, on a fresh row,
        # so they're immediately visible.
        saved_names = {n.name for n in saved.nodes}
        existing_positioned = [
            n for n in saved.nodes if not (n.pos_x == 0.0 and n.pos_y == 0.0)
        ]
        max_x = max((n.pos_x for n in existing_positioned), default=60.0)
        min_y = min((n.pos_y for n in existing_positioned), default=60.0)
        max_y = max((n.pos_y for n in existing_positioned), default=60.0)
        col_w, row_h = 240.0, 150.0
        next_x = max_x + col_w
        next_y = min_y
        for d in team_defs:
            if d.name not in saved_names:
                saved.add_node(d.name)
                if existing_positioned:
                    # Pin the new node to a fresh slot to the right
                    # of everything else, stepping DOWN one row per
                    # extra newcomer so multiple additions don't
                    # overlap each other either.
                    new_node = saved.nodes[-1]
                    new_node.pos_x = next_x
                    new_node.pos_y = next_y
                    next_y += row_h
                    if next_y > max_y + row_h * 3:
                        next_y = min_y
                        next_x += col_w
        # First-load auto-layout: if every node is at (0,0), space them out.
        if saved.nodes and all(n.pos_x == 0.0 and n.pos_y == 0.0 for n in saved.nodes):
            saved.autolayout_grid()

        self.canvas.load_graph(saved, orchestrator=leader_name)
        # Push each agent's icon + meta (description, skills) onto its
        # canvas node so the graph view's info-card overlay can show
        # the same fields the orbital diagram does.
        for d in team_defs:
            try:
                self.canvas.set_node_icon(d.name, d.icon or "🤖")
            except Exception:
                pass
            try:
                if hasattr(self, "team_canvas") and self.team_canvas is not None:
                    self.team_canvas.set_node_icon(d.name, d.icon or "🤖")
            except Exception:
                pass
            try:
                graph_skills = list(d.tool_allowlist or [])
                if d.can_dispatch and "dispatch" not in graph_skills:
                    graph_skills = ["dispatch"] + graph_skills
                self.canvas.set_node_meta(
                    d.name, d.description or "", graph_skills,
                )
            except Exception:
                pass

        # Mirror the team into the live orbital diagram. The diagram
        # gets the rich AgentDefinition fields (description, skills,
        # icon) so its top-left info card is populated when an agent
        # is clicked.
        try:
            team_payload = []
            for d in team_defs:
                # Skills come from the tool allowlist (built-in tools the
                # agent is permitted to use) — falls back to a sensible
                # default summary if the role doesn't list any.
                skills = list(d.tool_allowlist or [])
                if d.can_dispatch and "dispatch" not in skills:
                    skills = ["dispatch"] + skills
                team_payload.append({
                    "name": d.name,
                    "icon": d.icon or "🤖",
                    "description": d.description or "",
                    "skills": skills,
                })
            self.team_canvas.set_agents(team_payload, orchestrator=leader_name)

            # Push edges so the orbital diagram renders directed
            # arrows for the saved AgentGraph connections. Layout is
            # NOT affected by edges — agents stay on the single ring.
            edge_pairs: List[Tuple[str, str]] = []
            try:
                for e in (saved.edges or []):
                    src = getattr(e, "source", None)
                    dst = getattr(e, "target", None)
                    if src and dst:
                        edge_pairs.append((str(src), str(dst)))
            except Exception:
                edge_pairs = []
            self.team_canvas.set_edges(edge_pairs)

            # Team metadata for the default info card shown when no
            # agent is selected. Pushed into BOTH canvases so the
            # graph view also shows the team card when no node is
            # selected.
            proj = self._active_project
            team_name_value = getattr(proj, "name", "") or "Untitled team"
            team_desc_value = (
                getattr(proj, "description", "")
                or f"{len(team_defs)} agents · "
                   f"{len(edge_pairs)} connections · "
                   f"orchestrator: {leader_name or '—'}"
            )
            self.team_canvas.set_team_info(
                name=team_name_value,
                description=team_desc_value,
            )
            try:
                self.canvas.set_team_info(
                    name=team_name_value,
                    description=team_desc_value,
                )
            except Exception:
                pass
        except Exception:
            pass

        # Sync the loading-screen constellation to the real team so the
        # placeholder ("orchestrator/researcher/...") doesn't show during
        # the wait.
        try:
            self._canvas_loader.set_agent_names([d.name for d in team_defs])
        except Exception:
            pass

        # Per-agent message buffers — pre-create empty lists so a node click
        # never crashes on a missing key.
        for d in team_defs:
            self._agent_logs[d.name] = []

        # Build a hidden pool of model pickers, one per agent. Show the
        # one whose agent is currently selected. Persist selection to
        # both QSettings (legacy global) and Project.model_overrides
        # (per-project).
        for d in team_defs:
            picker = ModelPickerButton(
                on_install_local=self._open_models_tab,
                parent=self.picker_host,
            )
            picker.setVisible(False)
            self._picker_slot_layout.addWidget(picker)
            self._model_picker_buttons[d.name] = picker

        # Push entries to pickers + restore each agent's saved or default model.
        self._refresh_pickers()
        self._restore_saved_selections()
        # Mirror each agent's current picker selection onto its canvas node.
        for role_name in self._model_picker_buttons.keys():
            try:
                self._update_canvas_model_label(role_name)
            except Exception:
                pass

        # If the leader exists, default-select it so the right pane shows
        # something the moment the user lands on the page.
        if leader_name is not None:
            self.canvas.select_agent(leader_name)
            self._on_canvas_node_selected(leader_name)

        # Replay history into the per-agent buffers so switching projects
        # (even mid-run) doesn't wipe what the user was looking at.
        self._replay_active_project()

    # ------------------------------------------------------------------
    # Replay
    # ------------------------------------------------------------------

    def _replay_active_project(self) -> None:
        """Re-feed the active project's most recent goal messages into the
        freshly-built cards.

        Why we do this on every team render:

        * Switching projects rebuilds the cards (different teams, different
          subset of agents). The new cards start empty; the bus has the
          history persisted but the widgets don't see it until we route
          it through ``_on_bus_message``.
        * For a project whose goal is *still running*, the live bus
          subscription will pick up new messages from here on, so replay
          + live = full continuity.

        Limit: replay only the LATEST goal. Going back further is a future
        UI affordance (a "history" dropdown could let the user pick).
        """
        if self._active_project is None:
            return
        try:
            goal_ids = self._project_store.list_goal_ids(self._active_project.id)
        except Exception:
            logger.exception("could not list project goals")
            return
        if not goal_ids:
            return

        latest = goal_ids[0]
        try:
            messages = self._bus.replay(goal_id=latest)
        except Exception:
            logger.exception("could not replay messages for goal %s", latest)
            return

        # If the goal is still running, restore the in-progress UI state
        # too — Cancel button enabled, run timer ticking, status_label
        # showing "Resuming…". Otherwise the page will look idle even
        # though the run is mid-flight in the background.
        try:
            goal = self._bus.get_goal(latest)
            from core.agents.message import GoalStatus
            if goal is not None and goal.status == GoalStatus.RUNNING:
                self._current_goal_id = latest
                self.cancel_btn.setEnabled(True)
                self.run_btn.setEnabled(False)
                self.goal_input.setEnabled(False)
                self.status_label.setText("Resuming live run…")
                # Re-attach the elapsed timer to the goal's original start
                # time so the user sees a continuous counter.
                from datetime import datetime, timezone
                import time as _time
                try:
                    started = datetime.strptime(
                        goal.created_at.rstrip("Z"),
                        "%Y-%m-%dT%H:%M:%S.%f"
                        if "." in goal.created_at
                        else "%Y-%m-%dT%H:%M:%S",
                    ).replace(tzinfo=timezone.utc).timestamp()
                    # Convert wall-clock epoch to monotonic-equivalent so
                    # _tick_elapsed's math still works.
                    self._run_started_at = _time.monotonic() - (
                        _time.time() - started
                    )
                    if not hasattr(self, "_elapsed_timer"):
                        self._elapsed_timer = QTimer(self)
                        self._elapsed_timer.setInterval(1000)
                        self._elapsed_timer.timeout.connect(self._tick_elapsed)
                    self._elapsed_timer.start()
                except Exception:
                    logger.exception("could not restore elapsed timer")
        except Exception:
            logger.exception("could not check goal status during replay")

        # Replay messages oldest-first into the current cards via the
        # same routing _on_bus_message uses live. Cards stay in sync even
        # for mid-stream resume because the latest message dictates each
        # card's terminal status.
        for msg in messages:
            self._on_bus_message(msg)

    def _build_approvals_area(self) -> QWidget:
        self.approvals_frame = QFrame()
        self.approvals_frame.setFrameShape(QFrame.NoFrame)
        self.approvals_frame.setStyleSheet("background:transparent;")
        self._approvals_layout = QVBoxLayout(self.approvals_frame)
        self._approvals_layout.setContentsMargins(0, 0, 0, 0)
        self._approvals_layout.setSpacing(8)

        self._approvals_header = QLabel("Pending approvals")
        ah = QFont()
        ah.setPointSize(11)
        ah.setBold(True)
        self._approvals_header.setFont(ah)
        self._approvals_header.setStyleSheet(
            "color:#ffb0b0; padding:2px 4px; background:transparent;"
        )
        self._approvals_layout.addWidget(self._approvals_header)
        self.approvals_frame.setVisible(False)
        return self.approvals_frame

    # ------------------------------------------------------------------
    # Bus
    # ------------------------------------------------------------------

    def _wire_bus(self) -> None:
        self._bus.subscribe(lambda msg: self._bridge.message.emit(msg))
        self._registry.gate.add_listener(
            lambda req: self._bridge.approval_requested.emit(req)
        )

    # ------------------------------------------------------------------
    # Bootstrap
    # ------------------------------------------------------------------

    def _kick_off_bootstrap(self) -> None:
        cur = agent_runtime_manager.status()
        if cur.fully_ready:
            self.bootstrap_frame.setVisible(False)
            return

        self.bootstrap_frame.setVisible(True)
        self.run_btn.setEnabled(False)
        self.bootstrap_label.setText("Setting up agent runtime…")

        import threading

        def progress_cb(msg: str) -> None:
            from PySide6.QtCore import QMetaObject, Q_ARG
            QMetaObject.invokeMethod(
                self, "_on_bootstrap_progress", Qt.QueuedConnection, Q_ARG(str, msg)
            )

        def worker():
            from PySide6.QtCore import QMetaObject, Q_ARG
            try:
                agent_runtime_manager.ensure_ready(progress=progress_cb)
                QMetaObject.invokeMethod(
                    self, "_on_bootstrap_done", Qt.QueuedConnection, Q_ARG(str, "")
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("agent runtime bootstrap failed")
                QMetaObject.invokeMethod(
                    self, "_on_bootstrap_done", Qt.QueuedConnection, Q_ARG(str, str(exc))
                )

        threading.Thread(target=worker, name="agent-bootstrap", daemon=True).start()

    @Slot(str)
    def _on_bootstrap_progress(self, msg: str) -> None:
        self.bootstrap_label.setText(msg)
        # Forward to the canvas loader so the user has a single, prominent
        # place to read what's happening — the small label above the canvas
        # is easy to miss.
        try:
            if hasattr(self, "_canvas_loader"):
                self._canvas_loader.set_sub_status(msg)
        except Exception:
            pass

    @Slot(str)
    def _on_bootstrap_done(self, error: str) -> None:
        if error:
            self.bootstrap_label.setText(f"Setup failed: {error}")
            self.bootstrap_progress.setRange(0, 1)
            self.bootstrap_progress.setValue(0)
            QMessageBox.warning(self, "Agent runtime", error)
        else:
            self.bootstrap_frame.setVisible(False)
            self._refresh_pickers()
        self.run_btn.setEnabled(True)
        # Bootstrap finished — try to flip the loader to the workspace
        # (still gated on the requirements scan; that's checked inside).
        try:
            self._poll_loading_state()
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Loader → workspace flip
    # ------------------------------------------------------------------

    def _poll_loading_state(self) -> None:
        """Decide whether the workspace can be revealed.

        Two gates:

        * Agent runtime (``agent_runtime_manager.status().fully_ready``).
          If we're auto-installing the anthropic / openai / claude-code /
          codex runtime stack, we wait that out.
        * Main-window requirements scan. The scan can take 1-2 min and
          while it's running the home-page popup / repair dialogs may
          interrupt the user. We wait for it to finish so the agents page
          appears AFTER any environment dialog has resolved.

        Polled every 500ms until both gates are satisfied; then we flip
        the QStackedWidget to the workspace and stop polling.
        """
        if self._loading_done:
            return

        # Gate 1 — agent runtime.
        try:
            runtime_ready = bool(agent_runtime_manager.status().fully_ready)
        except Exception:
            runtime_ready = True  # don't get stuck if probing fails

        # Gate 2 — main-window requirements scan, if we can see it. Older
        # setups may not have the thread reachable; treat absence as "ok".
        scan_done = True
        try:
            mw = self.main_window
            t = getattr(mw, "_req_check_thread", None)
            if t is not None:
                # QThread.isRunning is False once the run() loop exits.
                scan_done = not t.isRunning()
        except Exception:
            scan_done = True

        # Update sub-status with an indication of which gate is pending.
        try:
            if not runtime_ready:
                self._canvas_loader.set_status("Installing agent runtime")
                self._canvas_loader.set_sub_status(
                    "Anthropic, OpenAI, Claude-Code and Codex toolchains."
                )
            elif not scan_done:
                self._canvas_loader.set_status("Verifying environment")
                self._canvas_loader.set_sub_status(
                    "pip-listing the cu121 profile env, smoke-testing each critical package."
                )
            else:
                self._canvas_loader.set_status("Ready")
                self._canvas_loader.set_sub_status("Bringing up the canvas…")
        except Exception:
            pass

        # Push the live team into the loader's constellation so the user
        # sees the agents they configured rather than the placeholder set.
        try:
            if self._active_project and self._active_project.team:
                self._canvas_loader.set_agent_names(list(self._active_project.team))
        except Exception:
            pass

        # Minimum display time — see _build_roster for why. Even on a
        # fast boot we hold the loader for a few seconds so the user
        # actually sees the animation rather than a 200 ms flash.
        import time as _t
        elapsed = _t.monotonic() - getattr(self, "_loader_started_at", 0.0)
        if elapsed < getattr(self, "_loader_min_seconds", 0.0):
            return

        if runtime_ready and scan_done:
            self._maybe_finish_loading()

    def _maybe_finish_loading(self) -> None:
        """Flip the stack to the workspace once. Guarded against double-firing."""
        if self._loading_done:
            return
        self._loading_done = True
        # Brief 600ms tail so the "Ready" frame is visible — abrupt swap
        # feels like a flash.
        self._loading_finish_timer = QTimer(self)
        self._loading_finish_timer.setSingleShot(True)
        self._loading_finish_timer.setInterval(600)
        self._loading_finish_timer.timeout.connect(self._reveal_workspace)
        self._loading_finish_timer.start()

    def _reveal_workspace(self) -> None:
        try:
            # Loader is at index 0, splitter at index 1 (see _build_roster).
            self._workspace_stack.setCurrentIndex(1)
        except Exception:
            pass
        try:
            self._canvas_loader.stop()
        except Exception:
            pass
        try:
            self._loading_poll_timer.stop()
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Fast critical-deps probe (Agents page open path)
    # ------------------------------------------------------------------

    def _fast_critical_deps_probe(self) -> None:
        """Subprocess-probe the canonical OWLLM Python in <2 s for critical deps.

        The slow path is the main-window Requirements scan that does a full
        ``pip list`` plus per-package smoke-tests — that's where the 2–3
        minute lag came from. This fast probe runs ``importlib.util.find_spec``
        for the same set of critical packages the home page checks, gives a
        result in well under a second, and pops a SYNCHRONOUS Repair? dialog
        the moment something's missing. The user gets to act immediately
        instead of staring at the loader for two minutes.

        We probe via a SUBPROCESS into the canonical OWLLM Python so the
        result reflects THAT env even if the running process is the wrong
        one (e.g. someone double-clicked an old launcher).
        """
        try:
            from core.runtime.owllm_python import get_owllm_python, OwllmEnvNotInstalled
            from pathlib import Path
            import subprocess
            import sys as _sys

            llm_root = Path(__file__).resolve().parent.parent.parent
            try:
                py = get_owllm_python(llm_root)
            except OwllmEnvNotInstalled as exc:
                self._show_repair_dialog(
                    title="Profile environment not installed",
                    summary=(
                        f"OWLLM's profile environment '{exc.env_key}' isn't on disk.\n\n"
                        "Open the installer and click Install/Repair All to create it."
                    ),
                    missing=[],
                )
                return

            critical = [
                "torch", "transformers", "tokenizers",
                "datasets", "accelerate", "peft", "numpy",
                "requests", "yaml",
            ]
            probe = (
                "import importlib.util, json, sys\n"
                "out=[]\n"
                "for p in " + repr(critical) + ":\n"
                "    spec=importlib.util.find_spec(p)\n"
                "    out.append((p, bool(spec)))\n"
                "sys.stdout.write(json.dumps(out))\n"
            )
            try:
                proc = subprocess.run(
                    [str(py), "-c", probe],
                    capture_output=True, text=True, timeout=10,
                    creationflags=(0x08000000 if _sys.platform == "win32" else 0),
                )
            except Exception as e:
                logger.warning("fast deps probe failed: %s", e)
                return
            if proc.returncode != 0 or not proc.stdout.strip():
                return
            try:
                import json
                results = json.loads(proc.stdout.strip())
            except Exception:
                return
            missing = [name for name, ok in results if not ok]
            if not missing:
                return
            self._show_repair_dialog(
                title="Critical dependencies missing",
                summary=(
                    "OWLLM is missing the following critical packages in its "
                    "profile environment:\n\n"
                    "  · " + "\n  · ".join(missing) + "\n\n"
                    "Without these the agents runtime can't run. Repair will "
                    "install them via pip into the cu121 profile env."
                ),
                missing=missing,
            )
        except Exception:
            logger.exception("fast critical deps probe crashed")

    def _show_repair_dialog(self, *, title: str, summary: str, missing: list) -> None:
        """Modal Repair? dialog. Synchronous so the user can't ignore it."""
        # Idempotent — don't stack multiple dialogs if probe runs twice.
        if getattr(self, "_repair_dialog_shown", False):
            return
        self._repair_dialog_shown = True

        box = QMessageBox(self)
        box.setWindowTitle(title)
        box.setIcon(QMessageBox.Warning)
        box.setText(summary)
        repair_btn = box.addButton("🔧 Repair Now", QMessageBox.AcceptRole)
        skip_btn = box.addButton("Skip for now", QMessageBox.RejectRole)
        box.setDefaultButton(repair_btn)
        box.exec()
        if box.clickedButton() is repair_btn and missing:
            self._run_repair_install(missing)
        # Allow the dialog to fire again later if the env is still broken
        # after a Skip → user clicks somewhere else → comes back.
        self._repair_dialog_shown = False

    def _run_repair_install(self, missing: list) -> None:
        """Install missing critical packages into the canonical OWLLM Python."""
        try:
            from core.runtime.owllm_python import get_owllm_python
            from pathlib import Path
            import subprocess
            import sys as _sys

            llm_root = Path(__file__).resolve().parent.parent.parent
            py = get_owllm_python(llm_root)
            cmd = [str(py), "-m", "pip", "install",
                   "--upgrade-strategy", "only-if-needed",
                   "--prefer-binary",
                   "--no-warn-script-location",
                   *missing]
            self.status_label.setText("Repairing environment — pip install running…")
            try:
                self._canvas_loader.set_status("Repairing environment")
                self._canvas_loader.set_sub_status(
                    "pip install: " + " ".join(missing[:5])
                    + ("…" if len(missing) > 5 else "")
                )
            except Exception:
                pass
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=600,
                creationflags=(0x08000000 if _sys.platform == "win32" else 0),
            )
            if proc.returncode == 0:
                QMessageBox.information(
                    self, "Repair complete",
                    "Missing packages installed. The Agents page is ready to use.",
                )
                self.status_label.setText("Idle.")
            else:
                tail = (proc.stderr or proc.stdout or "")[-1500:]
                QMessageBox.warning(
                    self, "Repair failed",
                    f"pip exited with code {proc.returncode}.\n\n{tail}",
                )
                self.status_label.setText("Repair failed.")
        except Exception as e:
            QMessageBox.critical(self, "Repair error", f"{e}")

    # ------------------------------------------------------------------
    # Account dots / pickers refresh
    # ------------------------------------------------------------------

    def _refresh_account_dots(self) -> None:
        st = agent_runtime_manager.status()
        flags = {
            "claude_subscription": st.claude_subscription_connected,
            "codex_subscription": st.codex_subscription_connected,
            "anthropic_api": st.anthropic_api_key_set,
            "openai_api": st.openai_api_key_set,
        }
        for key, connected in flags.items():
            dot = self._account_dots[key]
            color = "#4caf50" if connected else "#5a6376"
            dot.setStyleSheet(f"background:{color}; border-radius:4px;")

    def _refresh_pickers(self) -> None:
        for picker in self._model_picker_buttons.values():
            picker.refresh_entries()

    def _model_id_for(self, role_name: str) -> str:
        picker = self._model_picker_buttons.get(role_name)
        if picker is None:
            return ""
        return picker.current_id()

    # ------------------------------------------------------------------
    # Per-agent model persistence (across app restarts)
    # ------------------------------------------------------------------

    def _settings_key(self, role_name: str) -> str:
        return f"{self._SETTINGS_PREFIX}{role_name}"

    def _restore_saved_selections(self) -> None:
        """Apply each role's saved composite model id, if one exists.

        Read order:
          1. ``Project.model_overrides[role_name]`` — per-project pin
             (authoritative; what the bridges read too).
          2. QSettings under ``agents/model_for/<role>`` — legacy global
             default, used as a fallback when the project has no override
             for this role yet.

        Called after the pickers have been populated so ``set_current_id``
        can find the entry. If the saved id is no longer available (model
        uninstalled, account disconnected) the picker quietly drops it on
        the next refresh — no error, just falls back to the default.
        """
        overrides = (
            self._active_project.model_overrides
            if self._active_project is not None
            else {}
        )
        for role_name, picker in self._model_picker_buttons.items():
            saved = overrides.get(role_name) or self._settings.value(
                self._settings_key(role_name), ""
            )
            if isinstance(saved, str) and saved:
                picker.set_current_id(saved)

    def _wire_selection_persistence(self) -> None:
        """Persist every selection change to the active project.

        Two stores in lockstep:
          * ``Project.model_overrides`` — what the bridges (Telegram /
            WhatsApp) read at goal time. Without this, bridges had no way
            to see what the user picked on the desktop and fell back to
            the empty default_model_id, breaking remote runs.
          * QSettings — kept as a global fallback for new projects that
            don't have an override yet.

        Connected only after ``_restore_saved_selections`` so the bulk
        restore doesn't immediately re-write the same values back to disk.
        """
        for role_name, picker in self._model_picker_buttons.items():
            picker.selection_changed.connect(
                lambda composite_id, rn=role_name: self._on_picker_changed(
                    rn, composite_id
                )
            )

    def _on_picker_changed(self, role_name: str, composite_id: str) -> None:
        """Persist a per-agent model selection to project + QSettings.

        Also push the (short) model label to the canvas node so the agent
        boxes aren't empty — the user reported that with the picker moved
        to a side panel, the canvas felt empty. Showing the model name
        directly on the node is the at-a-glance answer to "which agent
        runs which model".
        """
        # Global fallback (legacy).
        try:
            self._settings.setValue(self._settings_key(role_name), composite_id)
        except Exception:
            pass
        # Per-project authoritative store. This is what bridges read at
        # goal-dispatch time, so writing here is what makes Telegram /
        # WhatsApp use the same model the desktop picker shows.
        if self._active_project is None:
            return
        self._active_project.model_overrides[role_name] = composite_id
        try:
            self._project_store.save_project(self._active_project)
        except Exception:
            logger.exception("could not persist model_overrides for %s", role_name)
        # Reflect the new pick on the canvas node.
        try:
            self._update_canvas_model_label(role_name)
        except Exception:
            pass

    def _update_canvas_model_label(self, role_name: str) -> None:
        """Mirror the picker's current selection under the agent's
        canvas node title. Reads ``current_label()`` directly so we don't
        scrape the button text (which carries the ``▾`` glyph) and so a
        not-yet-selected picker doesn't show a placeholder on the node.
        """
        picker = self._model_picker_buttons.get(role_name)
        if picker is None:
            return
        label = ""
        try:
            label = picker.current_label() or ""
        except Exception:
            label = ""
        # Trim provider prefix when present so the node line stays compact.
        if "·" in label:
            label = label.split("·", 1)[1].strip()
        if not label:
            try:
                label = picker.current_id() or ""
            except Exception:
                pass
        # Last resort: read straight from the project override so we never
        # show "no model" when the user has actually picked one but the
        # picker entry-list hasn't caught up yet.
        if not label and self._active_project is not None:
            saved = self._active_project.model_overrides.get(role_name) or ""
            if saved:
                label = saved.split("/", 1)[-1] if "/" in saved else saved
        self.canvas.set_node_model_label(role_name, label)
        try:
            if hasattr(self, "team_canvas") and self.team_canvas is not None:
                self.team_canvas.set_node_model_label(role_name, label)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Tab navigation hook
    # ------------------------------------------------------------------

    def _open_models_tab(self) -> None:
        """Switch to the Models tab — used by the picker's empty-Local CTA."""
        if self.main_window is None:
            return
        try:
            switcher = getattr(self.main_window, "_switch_tab", None)
            tabs = getattr(self.main_window, "tabs", None)
            if switcher and tabs:
                switcher(tabs, "models")
        except Exception:
            logger.exception("could not switch to Models tab")

    # ------------------------------------------------------------------
    # Run / cancel
    # ------------------------------------------------------------------

    def _run_clicked(self) -> None:
        goal = self.goal_input.text().strip()
        # Snapshot pending attachments now so removing the last
        # in-flight attachment doesn't race with submit.
        attachments = self._consume_pending_attachments()
        # Allow submit when there is media even with no typed goal —
        # a voice-only message is a perfectly valid request.
        if not goal and not attachments:
            return
        if self._team is None:
            try:
                self._team = self._build_team()
            except Exception as exc:  # noqa: BLE001
                QMessageBox.critical(self, "Agents", f"Team build failed: {exc}")
                return

        self.goal_input.setEnabled(False)
        self.run_btn.setEnabled(False)
        self.cancel_btn.setEnabled(True)

        # Only the orchestrator starts in 'thinking' — it's the only agent
        # actively working at goal start. Specialists stay idle until they
        # actually receive a dispatch. Pre-greening all cards was misleading.
        for card in self._cards.values():
            card.set_status(_STATUS_IDLE)
        orch_name = next(
            (n for n, c in self._cards.items() if c.role.can_dispatch),
            None,
        )
        if orch_name:
            self._cards[orch_name].set_status(_STATUS_THINKING)

        # Elapsed-time indicator — shows on the page so the user can see at
        # a glance that work *is* happening even when the model is taking
        # 30-60s per turn (Claude CLI subscription is slow on first call).
        import time
        self._run_started_at = time.monotonic()
        self.status_label.setText("Running… 0s elapsed")
        if not hasattr(self, "_elapsed_timer"):
            self._elapsed_timer = QTimer(self)
            self._elapsed_timer.setInterval(1000)
            self._elapsed_timer.timeout.connect(self._tick_elapsed)
        self._elapsed_timer.start()

        import threading
        import time

        # Snapshot the project so the watchdog/runner threads use the project
        # that was active *at run start*, not whatever the user switched to
        # mid-run. The goal belongs to the project that owned it.
        run_project_id = self._active_project.id if self._active_project else None

        # Watchdog: as soon as ``team.run_goal`` enters and creates the
        # underlying Goal record (it sets ``team.active_goal_id`` on its
        # second line), tag it with the project. This is what lets the
        # user switch projects mid-run and still find the in-flight goal
        # when they switch back. Without this, project_id is NULL until
        # the goal completes, and ``list_goal_ids`` misses it.
        self._run_active = True

        def watch():
            while getattr(self, "_run_active", False):
                gid = self._team.active_goal_id if self._team else None
                if gid:
                    if run_project_id:
                        try:
                            self._project_store.tag_goal(gid, run_project_id)
                        except Exception:
                            logger.exception("could not tag in-flight goal")
                    return
                time.sleep(0.05)

        threading.Thread(target=watch, name="agent-run-tag", daemon=True).start()

        def runner():
            try:
                team = self._team
                reply = team.run_goal(goal, attachments=attachments or None)
                self._current_goal_id = reply.goal_id
                # Belt-and-suspenders: the watchdog already tagged in flight,
                # but re-tag at completion in case the watchdog missed (e.g.
                # the goal completed before the watchdog tick fired).
                if run_project_id:
                    try:
                        self._project_store.tag_goal(reply.goal_id, run_project_id)
                    except Exception:
                        logger.exception("could not tag goal with project_id")
            except Exception as exc:  # noqa: BLE001
                logger.exception("agent run failed")
                # Surface the failure on the orchestrator's card too — the
                # page-level event used to be the only visible signal, but
                # with the per-card logs that's where the user is looking.
                err_msg = Message(
                    from_agent=orch_name or "orchestrator",
                    to_agent="user",
                    kind=MessageKind.EVENT,
                    body=f"run failed: {exc}",
                    goal_id=self._current_goal_id or "",
                )
                self._bridge.message.emit(err_msg)
            finally:
                self._run_active = False
                from PySide6.QtCore import QMetaObject
                QMetaObject.invokeMethod(self, "_set_idle", Qt.QueuedConnection)

        threading.Thread(target=runner, name="agent-run", daemon=True).start()

    def _tick_elapsed(self) -> None:
        """Update the running-elapsed label once a second."""
        import time
        started = getattr(self, "_run_started_at", None)
        if started is None:
            return
        secs = int(time.monotonic() - started)
        if secs < 60:
            text = f"Running… {secs}s elapsed"
        else:
            text = f"Running… {secs // 60}m {secs % 60}s elapsed"
        self.status_label.setText(text)

    def _build_team(self) -> Team:
        # MCP tools first — same rationale as before: pulls every connected
        # server's tools into the agent registry so the team picks them up.
        try:
            from desktop_app.mcp.connection_manager import MCPConnectionManager
            cm = MCPConnectionManager()
            count = register_mcp_tools(self._registry, cm)
            if count:
                logger.info("workspace loaded %d MCP tools from connected servers", count)
        except Exception:
            logger.exception("could not load MCP tools into agent registry")

        if self._active_project is None or not self._active_project.team:
            raise RuntimeError(
                "no team configured — pick agents via the Team… button"
            )

        # Build a name -> Role map from the active project's team.
        defs = list_all_definitions()
        roles: Dict[str, Role] = {}
        for name in self._active_project.team:
            d = defs.get(name)
            if d is None:
                logger.warning("project references unknown agent '%s' — skipping", name)
                continue
            roles[name] = _role_from_definition(d)

        # Build a graph resolver bound to the project's saved AgentGraph
        # (or to None when the project has no custom routing). Without a
        # graph the orchestrator behaves exactly as before — point-to-point
        # dispatch, reply goes straight back. With a graph, dispatch follows
        # the chain (e.g. orchestrator → coder1 → coder2 → orchestrator).
        graph_resolver = None
        if self._active_project and self._active_project.graph_json:
            graph = AgentGraph.from_json_string(self._active_project.graph_json)
            orchestrator_name = next(
                (name for name in self._active_project.team
                 if name in defs and defs[name].can_dispatch),
                "",
            )
            if graph.edges and orchestrator_name:
                def graph_resolver(from_name: str, _g=graph, _o=orchestrator_name) -> Optional[str]:
                    return _g.next_target(from_name, _o)

        return build_team(
            self._bus,
            roles=roles,
            model_id_for=self._model_id_for,
            model_fn=dispatch_model_fn,
            base_registry=self._registry,
            graph_resolver=graph_resolver,
        )

    def _cancel_clicked(self) -> None:
        if self._current_goal_id is None and self._team is not None:
            self._current_goal_id = self._team.active_goal_id
        if self._current_goal_id is None:
            return
        self._bus.cancel_goal(self._current_goal_id, "user clicked Cancel")
        self.status_label.setText("Cancelling…")

    @Slot()
    def _set_idle(self) -> None:
        self.goal_input.setEnabled(True)
        self.run_btn.setEnabled(True)
        self.cancel_btn.setEnabled(False)
        if hasattr(self, "_elapsed_timer"):
            self._elapsed_timer.stop()
        # Final summary — keep the elapsed total visible after a run so the
        # user sees how long it took.
        import time
        started = getattr(self, "_run_started_at", None)
        if started is not None:
            secs = int(time.monotonic() - started)
            if secs < 60:
                self.status_label.setText(f"Done in {secs}s.")
            else:
                self.status_label.setText(f"Done in {secs // 60}m {secs % 60}s.")
        else:
            self.status_label.setText("Idle.")
        self._run_started_at = None
        # Reset all canvas nodes to idle (the green/yellow/red states clear).
        try:
            self.canvas.reset_all_status()
        except Exception:
            pass
        try:
            if hasattr(self, "team_canvas") and self.team_canvas is not None:
                self.team_canvas.reset_all_status()
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Stream / approvals
    # ------------------------------------------------------------------

    @Slot(object)
    def _on_bus_message(self, msg: Message) -> None:
        """Route every bus message to canvas node statuses + per-agent log buffers.

        Buffer rules (each agent keeps its own log):
          * Append to FROM agent's log (their outgoing activity).
          * Also append to TO agent's log for USER / REQUEST / REPLY so a
            specialist sees the request that triggered it AND the reply
            it issued in the SAME stream.

        Canvas status rules:
          * REQUEST to X → X turns ACTIVE (green) — the dispatch arrived.
          * THOUGHT / TOOL_CALL from X → X stays ACTIVE.
          * REPLY from X → X turns IDLE.
          * EVENT containing "error" → that agent turns red.
        """
        # ---- log buffers ----
        if msg.from_agent in self._agent_logs:
            self._agent_logs[msg.from_agent].append(msg)
            if msg.from_agent == self._selected_agent:
                self._append_log_line(msg)
        if (
            msg.to_agent in self._agent_logs
            and msg.to_agent != msg.from_agent
            and msg.kind in (MessageKind.USER, MessageKind.REQUEST, MessageKind.REPLY)
        ):
            self._agent_logs[msg.to_agent].append(msg)
            if msg.to_agent == self._selected_agent:
                self._append_log_line(msg)

        # ---- canvas status ----
        # Fan out to BOTH the editable graph canvas and the live orbital
        # diagram so they stay in sync regardless of which view the user
        # is currently looking at. AgentTeamCanvas accepts the same
        # CANVAS_STATUS_* string keys as AgentCanvas.
        def _set_status_both(agent: str, status: str) -> None:
            try:
                self.canvas.set_node_status(agent, status)
            except Exception:
                pass
            try:
                if hasattr(self, "team_canvas") and self.team_canvas is not None:
                    self.team_canvas.set_node_status(agent, status)
            except Exception:
                pass

        if msg.kind == MessageKind.REQUEST:
            _set_status_both(msg.to_agent, CANVAS_STATUS_ACTIVE)
        elif msg.kind in (MessageKind.THOUGHT, MessageKind.TOOL_CALL):
            _set_status_both(msg.from_agent, CANVAS_STATUS_ACTIVE)
        elif msg.kind == MessageKind.REPLY:
            _set_status_both(msg.from_agent, CANVAS_STATUS_IDLE)
        elif msg.kind == MessageKind.EVENT and "error" in (msg.body or "").lower():
            target = msg.from_agent if msg.from_agent in self._agent_logs else msg.to_agent
            if target:
                _set_status_both(target, CANVAS_STATUS_ERROR)

    # ------------------------------------------------------------------
    # Canvas / log helpers
    # ------------------------------------------------------------------

    def _on_view_toggle_clicked(self) -> None:
        """Flip between the live orbital diagram and the editable graph."""
        if not hasattr(self, "_canvas_stack"):
            return
        idx = 1 if self._view_toggle_btn.isChecked() else 0
        self._canvas_stack.setCurrentIndex(idx)
        # Force visibility on both children — QStackedWidget alone has
        # been flaky here (the editable graph kept rendering when it
        # should be hidden).
        self.team_canvas.setVisible(idx == 0)
        self.canvas.setVisible(idx == 1)
        # Update the label so the user knows what tapping does next.
        if idx == 0:
            self._view_toggle_btn.setText("◐ Graph view")
            self._view_toggle_btn.setToolTip(
                "Switch to the editable graph (drag nodes, wire edges)"
            )
        else:
            self._view_toggle_btn.setText("◑ Diagram view")
            self._view_toggle_btn.setToolTip(
                "Switch back to the live orbital diagram"
            )

    def _on_canvas_node_selected(self, agent_name: str) -> None:
        """User clicked a node — re-point the right pane at that agent's log."""
        self._selected_agent = agent_name
        self.log_header.setText(f"📜 {agent_name}")
        # Show the picker for the selected agent only.
        for name, picker in self._model_picker_buttons.items():
            picker.setVisible(name == agent_name)
        self.picker_host.setVisible(agent_name in self._model_picker_buttons)
        self._render_log_for_agent(agent_name)
        # Default to the Reply tab whenever a new agent is selected.
        if hasattr(self, "_log_tabs"):
            self._log_tabs.setCurrentIndex(0)

    def _render_log_for_agent(self, agent_name: str) -> None:
        self._chat_view.clear()
        self._thought_view.clear()
        for msg in self._agent_logs.get(agent_name, []):
            self._append_log_line(msg)

    # Strip reasoning-model chain-of-thought wrappers from a body.
    # Returns ``(thought_text, clean_reply)``. Handles the common families:
    #   * gpt-oss / harmony "channel" markers (both well-formed and the
    #     mangled <|channel>thought…<channel|> seen in the wild)
    #   * <think>…</think>           (DeepSeek-R1, Qwen reasoning)
    #   * <thinking>…</thinking>     (Claude-style)
    #   * <reasoning>…</reasoning>   (generic)
    _THOUGHT_PATTERNS = [
        re.compile(
            r'<\|channel\|?>\s*(?:thought|analysis|reasoning)\b'
            r'(?:\s*<\|message\|>)?(.*?)<\|?(?:end|return|channel)\|?>',
            re.DOTALL | re.IGNORECASE,
        ),
        re.compile(r'<think>(.*?)</think>', re.DOTALL | re.IGNORECASE),
        re.compile(r'<thinking>(.*?)</thinking>', re.DOTALL | re.IGNORECASE),
        re.compile(r'<reasoning>(.*?)</reasoning>', re.DOTALL | re.IGNORECASE),
    ]

    @classmethod
    def _split_thought(cls, body: str) -> tuple[str, str]:
        thought_parts: list[str] = []
        clean = body
        for pat in cls._THOUGHT_PATTERNS:
            def _capture(m):
                grp = m.group(1) if m.lastindex else ""
                if grp.strip():
                    thought_parts.append(grp.strip())
                return ""
            clean = pat.sub(_capture, clean)
        return ("\n\n".join(thought_parts).strip(), clean.strip())

    def _append_log_line(self, msg: Message) -> None:
        kind = msg.kind.value if hasattr(msg.kind, "value") else str(msg.kind)
        body = (msg.body or "").strip()
        if not body:
            return
        prefix_color = {
            "user":        "#9ad9ff",
            "request":     "#ffd080",
            "reply":       "#a8e7a0",
            "thought":     "#dcb0ff",
            "tool_call":   "#ffb380",
            "tool_result": "#a0c8e0",
            "event":       "#e8e8e8",
        }.get(kind.lower(), "#cccccc")
        sub = f"<span style='color:#888;'> · {msg.from_agent} → {msg.to_agent}</span>"

        # Mechanical / internal traffic — THOUGHT, TOOL_CALL, TOOL_RESULT,
        # plus EVENT — always go to the Thought tab. The clean Reply tab
        # is reserved for human-readable chat between agents and the user.
        if kind.lower() in ("thought", "tool_call", "tool_result", "event"):
            text = body[:4000] + "… (truncated)" if len(body) > 4000 else body
            html = _escape_html(text).replace("\n", "<br/>")
            t_header = f"<span style='color:{prefix_color}; font-weight:bold;'>{kind.upper()}</span>"
            self._thought_view.append(f"{t_header}{sub}<br/>{html}<br/>")
            return

        # USER / REQUEST / REPLY: split inline reasoning wrappers off to
        # the Thought tab, render the cleaned text in the Reply tab.
        thought, clean = self._split_thought(body)
        if thought:
            t = thought[:4000] + "… (truncated)" if len(thought) > 4000 else thought
            t_html = _escape_html(t).replace("\n", "<br/>")
            t_header = f"<span style='color:#dcb0ff; font-weight:bold;'>THOUGHT (from {kind.upper()})</span>"
            self._thought_view.append(f"{t_header}{sub}<br/>{t_html}<br/>")
        if clean:
            c = clean[:4000] + "… (truncated)" if len(clean) > 4000 else clean
            c_html = _escape_html(c).replace("\n", "<br/>")
            # Speaker label: for REPLY/REQUEST use the FROM agent's name
            # ("Orchi: …"); for USER use a fixed "You: …". This replaces
            # the old uppercase REPLY / USER / REQUEST tags so the chat
            # actually reads like a conversation.
            kl = kind.lower()
            if kl == "user":
                speaker = "You"
            else:
                speaker = msg.from_agent or kind.upper()
            speaker_html = (
                f"<span style='color:{prefix_color}; font-weight:bold;'>{_escape_html(speaker)}:</span>"
            )
            target_note = ""
            if kl == "request" and msg.to_agent and msg.to_agent != msg.from_agent:
                target_note = f" <span style='color:#888;'>→ {_escape_html(msg.to_agent)}</span>"
            self._chat_view.append(f"{speaker_html}{target_note} {c_html}<br/>")

    def _on_graph_changed(self) -> None:
        """Persist the canvas's current node positions + edges to the project."""
        if self._active_project is None:
            return
        try:
            graph = self.canvas.export_graph()
            self._active_project.graph_json = graph.to_json_string()
            self._project_store.save_project(self._active_project)
        except Exception:
            logger.exception("could not persist agent graph")

    def _on_delete_selected_edge(self) -> None:
        self.canvas.remove_selected_edge()

    def _on_reverse_selected_edge(self) -> None:
        self.canvas.reverse_selected_edge()

    def _on_canvas_node_context_menu(self, agent_name: str, screen_pos) -> None:
        """Right-click on a canvas node — surface per-agent settings.

        The previous canvas had no per-agent affordances (the user
        complained the agents looked empty / settings vanished). This
        menu re-attaches all the previous AgentCard actions to the node:
        pick a model, view this agent's log, and remove from team.
        """
        menu = QMenu(self)
        pick_model_act = menu.addAction("🧠 Pick model…")
        view_log_act = menu.addAction("📜 View log on the right pane")
        menu.addSeparator()
        remove_act = menu.addAction("🗑 Remove from team")
        chosen = menu.exec(screen_pos)
        if chosen is None:
            return
        if chosen is pick_model_act:
            picker = self._model_picker_buttons.get(agent_name)
            if picker is not None:
                # Selecting on the canvas pre-shows the picker in the side
                # panel, but the menu is the FAST path: just open the popup.
                self.canvas.select_agent(agent_name)
                self._on_canvas_node_selected(agent_name)
                try:
                    picker.click()  # opens the popup
                except Exception:
                    pass
        elif chosen is view_log_act:
            self.canvas.select_agent(agent_name)
            self._on_canvas_node_selected(agent_name)
        elif chosen is remove_act:
            self._remove_agent_from_team(agent_name)

    def _remove_agent_from_team(self, agent_name: str) -> None:
        if self._active_project is None:
            return
        if QMessageBox.question(
            self, "Remove agent",
            f"Remove '{agent_name}' from the project team?\n"
            "(This only edits the team list — the agent definition is preserved.)",
        ) != QMessageBox.Yes:
            return
        try:
            self._active_project.team = [
                n for n in (self._active_project.team or []) if n != agent_name
            ]
            self._project_store.save_project(self._active_project)
        except Exception:
            logger.exception("could not persist team after remove")
            return
        # Drop from canvas and rebuild so layout/edges stay consistent.
        try:
            self.canvas.remove_agent_node(agent_name)
        except Exception:
            pass
        self._team = None  # force rebuild on next Run
        self._render_team()

    def _on_reset_layout(self) -> None:
        graph = self.canvas.export_graph()
        defs = list_all_definitions()
        leader_name = None
        for name in (self._active_project.team if self._active_project else []):
            d = defs.get(name)
            if d is not None and d.can_dispatch:
                leader_name = name
                break
        # Layered: orchestrator at column 0, others by BFS distance from it.
        graph.autolayout_layered(leader_name)
        self.canvas.load_graph(graph, orchestrator=leader_name)
        # Persist new positions.
        self._on_graph_changed()

    @Slot(object)
    def _on_approval_requested(self, req: ApprovalRequest) -> None:
        card = ApprovalCard(req, on_resolve=self._resolve_approval)
        self._approval_cards[req.id] = card
        self._approvals_layout.addWidget(card)
        self.approvals_frame.setVisible(True)

    def _resolve_approval(self, request: ApprovalRequest, decision: ApprovalDecision) -> None:
        self._registry.gate.resolve(request.id, decision)
        card = self._approval_cards.pop(request.id, None)
        if card is not None:
            card.setParent(None)
            card.deleteLater()
        if not self._approval_cards:
            self.approvals_frame.setVisible(False)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Markdown → HTML (compact, no external dep)
# ---------------------------------------------------------------------------


import re as _re


_RE_INLINE_CODE = _re.compile(r"`([^`\n]+)`")
_RE_BOLD = _re.compile(r"\*\*(.+?)\*\*", _re.DOTALL)
_RE_ITALIC_STAR = _re.compile(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", _re.DOTALL)
_RE_HEADING = _re.compile(r"^(#{1,4})\s+(.+)$")
_RE_BULLET = _re.compile(r"^\s*[-*]\s+(.+)$")
_RE_NUMBERED = _re.compile(r"^\s*(\d+)\.\s+(.+)$")
_RE_CODE_FENCE = _re.compile(r"^```(\w*)$")


def _escape_html(text: str) -> str:
    """HTML-escape (and only HTML-escape) a string."""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _apply_inline(text: str) -> str:
    """Apply inline markdown -> HTML on already-escaped text.

    Order matters: code first (so its content doesn't get bold-mangled),
    then bold, then italic.
    """
    # Inline code — re-escape in case the model put angle brackets inside
    # backticks; keep the backtick body literal.
    def code_sub(m):
        return (
            f"<code style='background:rgba(255,255,255,0.08); "
            f"border-radius:3px; padding:0 4px; "
            f"font-family:Consolas,Menlo,monospace;'>{m.group(1)}</code>"
        )

    text = _RE_INLINE_CODE.sub(code_sub, text)
    text = _RE_BOLD.sub(r"<b>\1</b>", text)
    text = _RE_ITALIC_STAR.sub(r"<i>\1</i>", text)
    return text


def _markdown_to_html(raw: str) -> str:
    r"""Convert a small but useful subset of markdown to HTML.

    Supports: ``**bold**``, ``*italic*``, `` `code` ``, fenced code blocks
    (```` ``` ````), ATX headings (``# h1`` … ``#### h4``), unordered lists
    (``-`` / ``*``), ordered lists (``1.``), paragraph breaks (blank lines),
    and soft line breaks within a paragraph.

    Intentionally not a full markdown engine — just enough that orchestrator
    replies and tool outputs render as structured HTML inside a QTextEdit
    instead of one wall of run-on text.
    """
    if not raw:
        return ""

    lines = raw.splitlines()
    out: list[str] = []
    in_code = False
    list_kind: Optional[str] = None  # "ul" or "ol" while open, else None
    para_buf: list[str] = []

    def flush_para():
        if para_buf:
            joined = "<br>".join(_apply_inline(_escape_html(line)) for line in para_buf)
            out.append(f"<p style='margin:4px 0;'>{joined}</p>")
            para_buf.clear()

    def flush_list():
        nonlocal list_kind
        if list_kind:
            out.append(f"</{list_kind}>")
            list_kind = None

    for line in lines:
        # Code-fence boundary.
        m = _RE_CODE_FENCE.match(line.strip())
        if m:
            flush_para()
            flush_list()
            if not in_code:
                in_code = True
                out.append(
                    "<pre style='background:rgba(0,0,0,0.30); border-radius:6px; "
                    "padding:8px 10px; margin:6px 0; font-size:12px; "
                    "font-family:Consolas,Menlo,monospace; white-space:pre-wrap;'>"
                )
            else:
                in_code = False
                out.append("</pre>")
            continue

        if in_code:
            out.append(_escape_html(line))
            continue

        stripped = line.strip()

        # Blank line — paragraph break.
        if not stripped:
            flush_para()
            flush_list()
            continue

        # Heading.
        m = _RE_HEADING.match(stripped)
        if m:
            flush_para()
            flush_list()
            level = len(m.group(1))
            tag = {1: "h2", 2: "h3", 3: "h4", 4: "h5"}.get(level, "h5")
            content = _apply_inline(_escape_html(m.group(2)))
            size = {1: "17px", 2: "15px", 3: "14px", 4: "13px"}.get(level, "13px")
            out.append(
                f"<{tag} style='margin:8px 0 4px 0; font-size:{size}; "
                f"color:#fff;'>{content}</{tag}>"
            )
            continue

        # Bullet.
        m = _RE_BULLET.match(stripped)
        if m:
            flush_para()
            if list_kind != "ul":
                flush_list()
                list_kind = "ul"
                out.append("<ul style='margin:2px 0; padding-left:18px;'>")
            content = _apply_inline(_escape_html(m.group(1)))
            out.append(f"<li>{content}</li>")
            continue

        # Numbered.
        m = _RE_NUMBERED.match(stripped)
        if m:
            flush_para()
            if list_kind != "ol":
                flush_list()
                list_kind = "ol"
                out.append("<ol style='margin:2px 0; padding-left:22px;'>")
            content = _apply_inline(_escape_html(m.group(2)))
            out.append(f"<li>{content}</li>")
            continue

        # Plain paragraph line.
        flush_list()
        para_buf.append(line)

    # Drain.
    flush_para()
    flush_list()
    if in_code:
        out.append("</pre>")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Role <-> AgentDefinition bridge
# ---------------------------------------------------------------------------


def _role_from_definition(d: AgentDefinition) -> Role:
    """Construct a runtime ``Role`` from an editable ``AgentDefinition``.

    The runtime team-builder still consumes Role objects; AgentDefinition
    is the user-facing superset. This bridge keeps the runtime untouched
    and lets the Studio evolve independently.
    """
    return Role(
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


# ---------------------------------------------------------------------------
# Team picker dialog
# ---------------------------------------------------------------------------


class _TeamPickerDialog(QDialog):
    """Modal: tick the agent definitions to include in this project's team."""

    def __init__(
        self,
        *,
        available: Dict[str, AgentDefinition],
        selected: set,
        parent=None,
    ) -> None:
        super().__init__(parent)
        self.setWindowTitle("Edit team")
        self.setModal(True)
        self.setMinimumWidth(520)

        self._checks: Dict[str, "QCheckBox"] = {}

        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(12)

        prose = QLabel(
            "Pick the agents that work on this project. Need a custom one? "
            "Design it in the 🎭 Studio tab and it'll appear here."
        )
        prose.setWordWrap(True)
        prose.setStyleSheet("color:#bbb; font-size:11px;")
        layout.addWidget(prose)

        from PySide6.QtWidgets import QCheckBox  # local import — only place we need it
        ordered = sorted(
            available.values(),
            key=lambda d: (0 if d.built_in else 1, 0 if d.can_dispatch else 1, d.name.lower()),
        )
        for d in ordered:
            row = QHBoxLayout()
            cb = QCheckBox()
            cb.setChecked(d.name in selected)
            self._checks[d.name] = cb
            row.addWidget(cb)
            from desktop_app.widgets.agent_icons import apply_to_label
            avatar = QLabel()
            avatar.setFixedSize(36, 36)
            avatar.setAlignment(Qt.AlignCenter)
            af = QFont()
            af.setPointSize(16)
            avatar.setFont(af)
            avatar.setStyleSheet("color:#fff;")
            apply_to_label(avatar, d.icon or "🤖", size=32)
            row.addWidget(avatar)

            text = QVBoxLayout()
            text.setSpacing(0)
            tag_bits = []
            if d.can_dispatch:
                tag_bits.append("LEADER")
            if d.built_in:
                tag_bits.append("BUILT-IN")
            tag_str = ("  ·  ".join(tag_bits) + "  ·  ") if tag_bits else ""
            name_label = QLabel(f"<b>{d.name}</b>")
            name_label.setStyleSheet("color:#fff;")
            text.addWidget(name_label)
            sub_label = QLabel(f"{tag_str}{d.description}")
            sub_label.setStyleSheet("color:#9aa0a6; font-size:11px;")
            text.addWidget(sub_label)
            row.addLayout(text, 1)
            layout.addLayout(row)

        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def selected_names(self) -> List[str]:
        return [name for name, cb in self._checks.items() if cb.isChecked()]


# ---------------------------------------------------------------------------
# Style snippets
# ---------------------------------------------------------------------------


_GHOST_BTN_STYLE = """
    QPushButton {
        background:rgba(255,255,255,0.04);
        color:#dadcdf;
        border:none; border-radius:8px;
        padding:0 14px; font-size:12px;
    }
    QPushButton:hover { background:rgba(255,255,255,0.10); color:#fff; }
"""

_GHOST_BTN_STYLE_SMALL = """
    QPushButton {
        background:rgba(255,255,255,0.04);
        color:#cbd2e0;
        border:none; border-radius:7px;
        padding:0 10px; font-size:11px;
        min-height:28px;
    }
    QPushButton:hover { background:rgba(255,255,255,0.10); color:#fff; }
    QPushButton:checked { background:#3a4a78; color:#fff; }
"""

_DESTRUCTIVE_GHOST_STYLE = """
    QPushButton {
        background:transparent;
        color:#ff8c8c;
        border:none; border-radius:8px;
        padding:0 14px; font-size:12px;
    }
    QPushButton:hover { background:rgba(255,140,140,0.12); }
"""


def _short_args(args, limit: int = 100) -> str:
    parts = []
    for k, v in args.items():
        s = str(v)
        if len(s) > 40:
            s = s[:37] + "..."
        parts.append(f"{k}={s!r}")
    line = ", ".join(parts)
    if len(line) > limit:
        line = line[: limit - 3] + "..."
    return line
