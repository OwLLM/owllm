"""Fleet — kanban-style page for parallel agent claims.

Slice 2a is a single-column stack of :class:`FleetAgentCard` s in a
scroll area, fed by a :class:`FleetService`. Auto-refresh every
``REFRESH_MS`` ms keeps the cards in sync with the broker without
spamming spawn/heartbeat traffic.

This page is **standalone** in slice 2a: nothing wires it into the
main app's tab bar yet (slice 2b). You can preview it by running

    python -m desktop_app.run_fleet_page

which boots a QApplication and shows the page in a top-level window
with a scratch fleet root under tempdir, so it doesn't touch your
real ``~/.owllm/fleet`` state.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

from core.fleet.profiles import ProfileStore
from desktop_app.fleet_service import FleetService
from desktop_app.widgets.fleet_agent_card import (
    FleetAgentCard,
    _open_in_default_app,
)
from desktop_app.widgets.fleet_history_dialog import FleetHistoryDialog
from desktop_app.widgets.fleet_log_viewer import FleetLogViewer
from desktop_app.widgets.fleet_outputs_dialog import FleetOutputsDialog
from desktop_app.widgets.fleet_profile_editor import FleetProfileEditor
from desktop_app.widgets.fleet_runtime_settings_dialog import (
    FleetRuntimeSettingsDialog,
)
from desktop_app.widgets.fleet_spawn_dialog import FleetSpawnDialog

logger = logging.getLogger(__name__)


REFRESH_MS = 3000
STATUS_FADE_MS = 5000


_PAGE_QSS = """
QWidget#FleetPage {
    background-color: #0a0d14;
}
QLabel#title {
    color: #e6f0ff;
    font-size: 18px;
    font-weight: 600;
}
QLabel#countText {
    color: #7888a8;
    font-size: 12px;
}
QLabel#statusBar {
    color: #c4d0e8;
    font-size: 11px;
    padding: 4px 8px;
    background: #12161f;
    border: 1px solid #2a3148;
    border-radius: 6px;
}
QLabel#statusBar[level="error"] {
    color: #ff7878;
    border-color: #ff7878;
}
QLabel#statusBar[level="ok"] {
    color: #3cf26b;
    border-color: #3cf26b;
}
QLabel#emptyState {
    color: #7888a8;
    font-size: 13px;
}
QPushButton {
    color: #e6f0ff;
    background-color: #1a2030;
    border: 1px solid #2a3148;
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 12px;
}
QPushButton:hover {
    background-color: #232a40;
    border-color: #5cf0ff;
}
QPushButton#primaryButton {
    color: #0a0d14;
    background-color: #5cf0ff;
    border-color: #5cf0ff;
}
QPushButton#primaryButton:hover {
    background-color: #74f4ff;
}
QScrollArea {
    background: transparent;
    border: none;
}
QScrollArea > QWidget > QWidget {
    background: transparent;
}
"""


class FleetPage(QWidget):
    """Kanban-style page over a :class:`FleetService`."""

    def __init__(
        self,
        service: FleetService,
        parent: Optional[QWidget] = None,
    ):
        super().__init__(parent)
        self.setObjectName("FleetPage")
        self.setStyleSheet(_PAGE_QSS)
        self._service = service
        self._cards: Dict[str, FleetAgentCard] = {}

        self._build_ui()
        self._wire_signals()

        self._refresh_timer = QTimer(self)
        self._refresh_timer.setInterval(REFRESH_MS)
        self._refresh_timer.timeout.connect(self._tick)
        # showEvent starts it — no point polling the ProcessRegistry while
        # the Fleet tab is hidden.

        self._tick()  # populate immediately so the page isn't empty
                      # the first time the user opens it

    def showEvent(self, ev):
        super().showEvent(ev)
        if not self._refresh_timer.isActive():
            self._tick()
            self._refresh_timer.start()

    def hideEvent(self, ev):
        super().hideEvent(ev)
        if self._refresh_timer.isActive():
            self._refresh_timer.stop()

    # ------------------------------------------------------------------
    # Build
    # ------------------------------------------------------------------

    def _build_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(20, 16, 20, 16)
        outer.setSpacing(12)

        # Header
        header = QHBoxLayout()
        header.setSpacing(10)
        title = QLabel("Fleet")
        title.setObjectName("title")
        header.addWidget(title)
        self._lbl_count = QLabel("0 agents")
        self._lbl_count.setObjectName("countText")
        header.addWidget(self._lbl_count)
        header.addStretch(1)

        self._btn_refresh = QPushButton("Refresh")
        self._btn_refresh.clicked.connect(self._tick)
        header.addWidget(self._btn_refresh)

        self._btn_reap = QPushButton("Reap stale")
        self._btn_reap.clicked.connect(self._on_reap_clicked)
        header.addWidget(self._btn_reap)

        self._btn_history = QPushButton("History")
        self._btn_history.clicked.connect(self._on_history_clicked)
        header.addWidget(self._btn_history)

        self._btn_profiles = QPushButton("Profiles")
        self._btn_profiles.clicked.connect(self._on_profiles_clicked)
        header.addWidget(self._btn_profiles)

        self._btn_outputs = QPushButton("Outputs")
        self._btn_outputs.clicked.connect(self._on_outputs_clicked)
        header.addWidget(self._btn_outputs)

        self._btn_settings = QPushButton("Settings")
        self._btn_settings.clicked.connect(self._on_settings_clicked)
        header.addWidget(self._btn_settings)

        self._btn_spawn = QPushButton("Spawn agent")
        self._btn_spawn.setObjectName("primaryButton")
        self._btn_spawn.clicked.connect(self._on_spawn_clicked)
        header.addWidget(self._btn_spawn)
        outer.addLayout(header)

        # Cards scroll area
        self._scroll = QScrollArea()
        self._scroll.setWidgetResizable(True)
        self._scroll_inner = QWidget()
        self._scroll_inner.setSizePolicy(
            QSizePolicy.Expanding, QSizePolicy.Expanding,
        )
        self._cards_layout = QVBoxLayout(self._scroll_inner)
        self._cards_layout.setContentsMargins(0, 0, 0, 0)
        self._cards_layout.setSpacing(10)
        self._cards_layout.addStretch(1)

        self._scroll.setWidget(self._scroll_inner)
        outer.addWidget(self._scroll, 1)

        # Empty-state label (shown when no agents)
        self._lbl_empty = QLabel(
            "No active agents. Click “Spawn agent” to start one."
        )
        self._lbl_empty.setObjectName("emptyState")
        self._lbl_empty.setAlignment(Qt.AlignCenter)
        outer.addWidget(self._lbl_empty)

        # Status strip
        self._lbl_status = QLabel("")
        self._lbl_status.setObjectName("statusBar")
        self._lbl_status.hide()
        outer.addWidget(self._lbl_status)

        self._status_timer = QTimer(self)
        self._status_timer.setSingleShot(True)
        self._status_timer.timeout.connect(self._lbl_status.hide)

    def _wire_signals(self) -> None:
        self._service.claims_changed.connect(self._on_claims_changed)
        self._service.spawn_succeeded.connect(self._on_spawn_succeeded)
        self._service.spawn_failed.connect(self._on_spawn_failed)
        self._service.finish_succeeded.connect(self._on_finish_succeeded)
        self._service.finish_failed.connect(self._on_finish_failed)

    # ------------------------------------------------------------------
    # Tick / refresh
    # ------------------------------------------------------------------

    def _tick(self) -> None:
        # Reap-then-list ensures users see a stale claim disappear
        # without an extra UI refresh round-trip.
        self._service.reap_stale()
        self._service.refresh()

    def _on_claims_changed(self, claims: list) -> None:
        seen = set()
        for claim in claims:
            agent_id = str(claim.get("agent_id", ""))
            if not agent_id:
                continue
            seen.add(agent_id)
            card = self._cards.get(agent_id)
            if card is None:
                card = FleetAgentCard(claim, self._scroll_inner)
                card.finish_requested.connect(self._on_card_finish)
                card.heartbeat_requested.connect(self._on_card_heartbeat)
                card.log_view_requested.connect(self._on_card_log_view)
                # Insert before the trailing stretch so cards stack at top.
                self._cards_layout.insertWidget(
                    self._cards_layout.count() - 1, card,
                )
                self._cards[agent_id] = card
            else:
                card.refresh_from(claim)

        # Drop cards for agents no longer active.
        stale_ids = [aid for aid in self._cards if aid not in seen]
        for aid in stale_ids:
            card = self._cards.pop(aid)
            self._cards_layout.removeWidget(card)
            card.deleteLater()

        n = len(seen)
        self._lbl_count.setText(f"{n} agent{'s' if n != 1 else ''}")
        self._lbl_empty.setVisible(n == 0)

    # ------------------------------------------------------------------
    # Header actions
    # ------------------------------------------------------------------

    def _on_spawn_clicked(self) -> None:
        dlg = FleetSpawnDialog(self)
        if dlg.exec() != dlg.DialogCode.Accepted:
            return
        kwargs = dlg.spawn_kwargs()
        try:
            self._service.spawn_async(**kwargs)
        except Exception as e:
            self._show_status(f"could not start spawn: {e}", level="error")
            return
        self._show_status(
            f"spawning agent on {kwargs['target_repo']} → {kwargs['branch']}…",
            level="ok",
        )

    def _on_reap_clicked(self) -> None:
        reaped = self._service.reap_stale()
        if not reaped:
            self._show_status("no stale claims to reap", level="ok")
            return
        names = ", ".join(c.get("agent_id", "?") for c in reaped)
        self._show_status(f"reaped: {names}", level="ok")

    def _on_history_clicked(self) -> None:
        dlg = FleetHistoryDialog(self._service.list_audit_events, parent=self)
        dlg.show()

    def _on_profiles_clicked(self) -> None:
        dlg = FleetProfileEditor(ProfileStore(), parent=self)
        dlg.show()

    def _on_outputs_clicked(self) -> None:
        dlg = FleetOutputsDialog(self._service.list_outputs, parent=self)
        dlg.show()

    def _on_settings_clicked(self) -> None:
        dlg = FleetRuntimeSettingsDialog(
            loader=self._service.load_runtime_config,
            apply=self._service.apply_runtime_config,
            parent=self,
        )
        dlg.config_applied.connect(
            lambda: self._show_status("runtime updated", level="ok")
        )
        dlg.show()

    # ------------------------------------------------------------------
    # Card actions
    # ------------------------------------------------------------------

    def _on_card_heartbeat(self, agent_id: str) -> None:
        ok = self._service.heartbeat(agent_id)
        if ok:
            self._show_status(f"{agent_id}: heartbeat refreshed", level="ok")
        else:
            self._show_status(
                f"{agent_id}: no active claim to heartbeat", level="error",
            )

    def _on_card_log_view(self, agent_id: str, log_path: str) -> None:
        viewer = FleetLogViewer(agent_id, log_path, parent=self)
        viewer.open_in_editor_requested.connect(_open_in_default_app)
        viewer.show()

    def _on_card_finish(self, agent_id: str) -> None:
        confirm = QMessageBox.question(
            self,
            "Finish agent?",
            f"Push the agent's branch and remove its workspace?\n\n"
            f"Agent: {agent_id}",
            QMessageBox.Ok | QMessageBox.Cancel,
            QMessageBox.Ok,
        )
        if confirm != QMessageBox.Ok:
            return
        try:
            self._service.finish_async(agent_id)
        except Exception as e:
            self._show_status(f"could not start finish: {e}", level="error")
            return
        self._show_status(f"{agent_id}: finishing…", level="ok")

    # ------------------------------------------------------------------
    # Service signal handlers
    # ------------------------------------------------------------------

    def _on_spawn_succeeded(self, claim: dict) -> None:
        agent_id = claim.get("agent_id", "?")
        self._show_status(f"{agent_id}: spawned", level="ok")

    def _on_spawn_failed(self, agent_id: str, msg: str) -> None:
        self._show_status(f"{agent_id}: spawn failed — {msg}", level="error")

    def _on_finish_succeeded(self, agent_id: str, pr_url: object) -> None:
        if pr_url:
            self._show_status(
                f"{agent_id}: finished, PR: {pr_url}", level="ok",
            )
        else:
            self._show_status(f"{agent_id}: finished", level="ok")

    def _on_finish_failed(self, agent_id: str, msg: str) -> None:
        self._show_status(f"{agent_id}: finish failed — {msg}", level="error")

    # ------------------------------------------------------------------
    # Status strip
    # ------------------------------------------------------------------

    def _show_status(self, text: str, *, level: str = "ok") -> None:
        self._lbl_status.setText(text)
        self._lbl_status.setProperty("level", level)
        # Stylesheet property changes need a re-polish to take effect.
        self._lbl_status.style().unpolish(self._lbl_status)
        self._lbl_status.style().polish(self._lbl_status)
        self._lbl_status.show()
        self._status_timer.start(STATUS_FADE_MS)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def closeEvent(self, event) -> None:  # noqa: N802 (Qt)
        self._refresh_timer.stop()
        self._status_timer.stop()
        super().closeEvent(event)
