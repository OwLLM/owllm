"""'Apply fix?' confirmation toast for supervisor-proposed actions.

When the supervisor decides to act on a failure, the proposed action is
not silently executed -- it surfaces here as a non-modal toast at the
bottom-right of the main window. The user clicks Apply / Skip / Always
within `timeout_s` (default 30); on timeout we treat as Skip so we never
block on absent users.

Why a non-modal toast and not a modal dialog:
  - The user may be mid-training. A modal stops their workflow.
  - Multiple proposals can stack vertically; modals can't.
  - Auto-timeout-skip is simpler than figuring out "did the modal ever
    grab focus" semantics.

Three trust tiers (matched to TOOLS.md):
  - safe    : currently still confirms by default (until shadow data
              proves the supervisor is right). When the user flips
              `supervisor.auto_apply_safe`, safe-tier proposals bypass
              this toast entirely -- they're applied immediately and a
              passive notification is posted instead.
  - confirm : always requires a click. No auto-apply path.
  - danger  : always requires a click AND prefixes the toast with a
              high-contrast warning band.

Public API:

    propose(parent, proposal, on_decision, *, timeout_s=30) -> Toast

A `Proposal` is a dataclass-shaped dict:

    { "action": "install_pkg",
      "args":   {"name": "bitsandbytes", "version": "0.44.1"},
      "reason": "torch 2.5 ABI requires bnb >= 0.44",
      "trust":  "confirm",
      "fallback": {...} | None }

The decision callback receives one of:
    "apply" | "skip" | "always_apply" | "never_apply" | "timeout"

Pure data helpers live as module-level functions (`format_proposal`,
`trust_color`, `decision_for_timeout`) so they unit-test without Qt.
"""
from __future__ import annotations

from typing import Any, Callable, Mapping

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QFrame, QHBoxLayout, QLabel, QPushButton, QVBoxLayout, QWidget,
)


DEFAULT_TIMEOUT_S = 30
TRUST_SAFE = "safe"
TRUST_CONFIRM = "confirm"
TRUST_DANGER = "danger"
VALID_TRUST = frozenset({TRUST_SAFE, TRUST_CONFIRM, TRUST_DANGER})

DECISION_APPLY = "apply"
DECISION_SKIP = "skip"
DECISION_ALWAYS = "always_apply"
DECISION_NEVER = "never_apply"
DECISION_TIMEOUT = "timeout"
VALID_DECISIONS = frozenset({
    DECISION_APPLY, DECISION_SKIP, DECISION_ALWAYS,
    DECISION_NEVER, DECISION_TIMEOUT,
})


# ---------------------------------------------------------------------------
# Pure helpers (Qt-free, unit-testable)
# ---------------------------------------------------------------------------


def format_proposal(p: Mapping[str, Any]) -> tuple[str, str, str]:
    """Return (title, body, reason) strings for the toast.

    Title:  one-line summary -- "Apply install_pkg bitsandbytes==0.44.1?"
    Body:   args formatted as key: value lines (caps at 6 lines).
    Reason: the model's one-sentence justification (or empty string).
    """
    action = str(p.get("action", "?"))
    args = p.get("args") or {}
    reason = str(p.get("reason") or "")

    summary = action
    name = args.get("name") if isinstance(args, Mapping) else None
    version = args.get("version") if isinstance(args, Mapping) else None
    if name:
        summary = f"{action} {name}"
        if version:
            summary = f"{summary}=={version}"

    title = f"Apply {summary}?"

    body_lines: list[str] = []
    if isinstance(args, Mapping):
        for k, v in list(args.items())[:6]:
            body_lines.append(f"{k}: {v}")
        if len(args) > 6:
            body_lines.append(f"... +{len(args) - 6} more")
    body = "\n".join(body_lines)

    return title, body, reason


def trust_color(trust: str) -> str:
    """Return a hex color for the trust-tier accent stripe."""
    if trust == TRUST_DANGER:
        return "#c0392b"   # red
    if trust == TRUST_CONFIRM:
        return "#e67e22"   # orange
    return "#27ae60"        # green


def decision_for_timeout(trust: str) -> str:
    """What does timeout map to for each trust tier?

    For all tiers we treat a timeout as Skip -- never silently apply.
    The user must explicitly opt in. Returning a constant keeps the
    contract simple and easy to reason about; we accept `trust` so the
    rule can evolve without changing call sites.
    """
    return DECISION_SKIP


# ---------------------------------------------------------------------------
# Qt widget
# ---------------------------------------------------------------------------


class SupervisorToast(QFrame):
    """Non-modal 'Apply fix?' confirmation panel.

    The widget owns its lifetime: on any decision (button or timeout)
    it emits `decided(str)` with one of the DECISION_* constants and
    schedules itself for deletion. Callers should connect to `decided`
    and not touch the widget afterwards.
    """

    decided = Signal(str)

    def __init__(
        self,
        proposal: Mapping[str, Any],
        parent: QWidget | None = None,
        *,
        timeout_s: int = DEFAULT_TIMEOUT_S,
    ) -> None:
        super().__init__(parent)
        self._proposal = proposal
        self._trust = str(proposal.get("trust") or TRUST_CONFIRM)
        if self._trust not in VALID_TRUST:
            self._trust = TRUST_CONFIRM
        self._decided_emitted = False
        self._timeout_s = max(5, int(timeout_s))
        self._build_ui()
        self._start_countdown()

    # ------------------------------------------------------------------
    # UI
    # ------------------------------------------------------------------

    def _build_ui(self) -> None:
        self.setObjectName("SupervisorToast")
        self.setFrameShape(QFrame.StyledPanel)
        self.setMinimumWidth(360)
        self.setMaximumWidth(440)
        accent = trust_color(self._trust)
        self.setStyleSheet(f"""
            QFrame#SupervisorToast {{
                background: #2b2b2b;
                color: #eee;
                border-left: 4px solid {accent};
                border-radius: 6px;
            }}
            QLabel#title {{ font-weight: 600; font-size: 13px; }}
            QLabel#reason {{ color: #bbb; font-style: italic; }}
            QLabel#body {{ font-family: Consolas, monospace; color: #ccc; }}
            QLabel#countdown {{ color: #888; font-size: 11px; }}
            QPushButton {{ padding: 4px 10px; }}
        """)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(12, 10, 12, 10)
        outer.setSpacing(6)

        title, body, reason = format_proposal(self._proposal)

        if self._trust == TRUST_DANGER:
            warn = QLabel("DANGER ACTION -- read carefully before applying")
            warn.setStyleSheet(
                "background: #c0392b; color: white; padding: 4px 8px; "
                "border-radius: 3px; font-weight: 700;"
            )
            outer.addWidget(warn)

        title_lbl = QLabel(title)
        title_lbl.setObjectName("title")
        title_lbl.setWordWrap(True)
        outer.addWidget(title_lbl)

        if body:
            body_lbl = QLabel(body)
            body_lbl.setObjectName("body")
            body_lbl.setWordWrap(True)
            outer.addWidget(body_lbl)

        if reason:
            reason_lbl = QLabel(reason)
            reason_lbl.setObjectName("reason")
            reason_lbl.setWordWrap(True)
            outer.addWidget(reason_lbl)

        # Buttons row
        btn_row = QHBoxLayout()
        btn_row.setSpacing(6)

        self._apply_btn = QPushButton("Apply")
        self._apply_btn.setDefault(True)
        self._apply_btn.clicked.connect(lambda: self._decide(DECISION_APPLY))
        btn_row.addWidget(self._apply_btn)

        self._skip_btn = QPushButton("Skip")
        self._skip_btn.clicked.connect(lambda: self._decide(DECISION_SKIP))
        btn_row.addWidget(self._skip_btn)

        # Always/Never only for safe-tier proposals -- danger never gets these.
        if self._trust == TRUST_SAFE:
            always_btn = QPushButton("Always for safe")
            always_btn.setToolTip(
                "Auto-apply all 'safe' proposals from now on without "
                "asking. You can revoke this in feature_flags.json."
            )
            always_btn.clicked.connect(lambda: self._decide(DECISION_ALWAYS))
            btn_row.addWidget(always_btn)

            never_btn = QPushButton("Never")
            never_btn.setToolTip("Refuse all supervisor proposals from now on.")
            never_btn.clicked.connect(lambda: self._decide(DECISION_NEVER))
            btn_row.addWidget(never_btn)

        outer.addLayout(btn_row)

        # Countdown label
        self._countdown_lbl = QLabel("")
        self._countdown_lbl.setObjectName("countdown")
        self._countdown_lbl.setAlignment(Qt.AlignRight)
        outer.addWidget(self._countdown_lbl)

    def _start_countdown(self) -> None:
        self._remaining = self._timeout_s
        self._tick()
        self._timer = QTimer(self)
        self._timer.setInterval(1000)
        self._timer.timeout.connect(self._tick)
        self._timer.start()

    def _tick(self) -> None:
        if self._remaining <= 0:
            self._timer.stop()
            self._decide(decision_for_timeout(self._trust))
            return
        self._countdown_lbl.setText(f"auto-skip in {self._remaining}s")
        self._remaining -= 1

    def _decide(self, decision: str) -> None:
        if self._decided_emitted:
            return
        if decision not in VALID_DECISIONS:
            decision = DECISION_SKIP
        self._decided_emitted = True
        try:
            self._timer.stop()
        except Exception:
            pass
        self.decided.emit(decision)
        self.deleteLater()


# ---------------------------------------------------------------------------
# Public helper
# ---------------------------------------------------------------------------


def propose(
    parent: QWidget | None,
    proposal: Mapping[str, Any],
    on_decision: Callable[[str], None],
    *,
    timeout_s: int = DEFAULT_TIMEOUT_S,
) -> SupervisorToast:
    """Spawn a toast and route its decision to `on_decision`.

    Returns the toast so callers can position/style it. The caller is
    responsible for placing the widget on screen (typically inside a
    QStackedLayout overlay or floating widget at the bottom-right).

    Auto-apply policy is NOT decided here -- if a caller wants to skip
    the toast for safe-tier proposals when `supervisor.auto_apply_safe`
    is on, it should check that flag itself and call on_decision("apply")
    directly without ever building this widget.
    """
    toast = SupervisorToast(proposal, parent=parent, timeout_s=timeout_s)
    toast.decided.connect(on_decision)
    return toast
