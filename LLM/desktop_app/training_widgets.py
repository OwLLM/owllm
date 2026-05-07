"""Training metrics and visualization widgets"""
from __future__ import annotations
from pathlib import Path
from typing import Callable, Optional

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QFrame, QPushButton,
    QSpinBox, QComboBox, QGraphicsDropShadowEffect, QSizePolicy,
)
from PySide6.QtCore import (
    Qt, Signal, QPropertyAnimation, QEasingCurve, QTimer, Property,
)
from PySide6.QtGui import QFont, QColor, QPainter, QBrush, QPen


class MetricCard(QFrame):
    """Card widget for displaying training metrics"""
    
    def __init__(self, title: str, icon: str, value: str = "--", parent=None):
        super().__init__(parent)
        self.is_dark = True
        self.value_label = None
        
        self.setMinimumHeight(160)
        # Remove setMaximumHeight to allow automatic sizing
        self.setFrameShape(QFrame.Box)
        
        layout = QVBoxLayout(self)
        layout.setContentsMargins(15, 12, 15, 12)  # Increased vertical margins
        layout.setSpacing(8)  # Increased spacing
        
        # Title with icon
        title_layout = QHBoxLayout()
        icon_label = QLabel(icon)
        icon_font = QFont()
        icon_font.setPointSize(14)
        icon_label.setFont(icon_font)
        title_layout.addWidget(icon_label)
        
        title_label = QLabel(title)
        title_font = QFont()
        title_font.setPointSize(11)
        title_font.setBold(True)
        title_label.setFont(title_font)
        title_layout.addWidget(title_label)
        title_layout.addStretch(1)
        layout.addLayout(title_layout)
        
        layout.addStretch(1)
        
        # Value
        self.value_label = QLabel(value)
        value_font = QFont()
        value_font.setPointSize(26)
        value_font.setBold(True)
        self.value_label.setFont(value_font)
        self.value_label.setAlignment(Qt.AlignCenter)
        layout.addWidget(self.value_label)
        
        layout.addStretch(1)
        
        self._apply_style()
    
    def set_value(self, value: str):
        """Update the metric value"""
        self.value_label.setText(value)
    
    def _apply_style(self):
        if self.is_dark:
            self.setStyleSheet("""
                MetricCard {
                    background: qlineargradient(x1:0, y1:0, x2:0, y2:1, 
                                                stop:0 #1e2936, stop:1 #16213e);
                    border: 1px solid #3a4a5a;
                    border-radius: 8px;
                }
                QLabel {
                    background: transparent;
                    color: #fafafa;
                    border: none;
                }
            """)
        else:
            self.setStyleSheet("""
                MetricCard {
                    background: white;
                    border: 1px solid #e0e0e0;
                    border-radius: 8px;
                }
                QLabel {
                    background: transparent;
                    color: #262730;
                    border: none;
                }
            """)
    
    def set_theme(self, dark_mode: bool):
        self.is_dark = dark_mode
        self._apply_style()


# =============================================================================
# Run mode selector
# =============================================================================

# Three modes a user can launch into. Strings match what main.py/finetune.py
# expect — keep them as constants so a typo in either side gets caught early.
RUN_MODE_NEW = "new"
RUN_MODE_RESUME = "resume"
RUN_MODE_CONTINUE = "continue"


class _ModePill(QPushButton):
    """One pill in the run-mode segmented control.

    Drawn with a soft drop-shadow when selected so the active mode pops
    visually without redrawing the rest of the layout. The shadow blur
    is animated when transitioning so mode changes feel intentional.
    """

    def __init__(self, label: str, accent: str, parent=None) -> None:
        super().__init__(label, parent)
        self.accent = accent  # e.g. "#4FC3F7"
        self.setCheckable(True)
        self.setCursor(Qt.PointingHandCursor)
        self.setMinimumHeight(44)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)

        font = QFont()
        font.setPointSize(11)
        font.setBold(True)
        self.setFont(font)

        # Drop-shadow effect on the pill itself. We toggle the blur
        # radius on/off rather than installing/removing the effect, so
        # we can animate it for free.
        self._shadow = QGraphicsDropShadowEffect(self)
        self._shadow.setBlurRadius(0)
        self._shadow.setOffset(0, 0)
        self._shadow.setColor(QColor(self.accent))
        self.setGraphicsEffect(self._shadow)

        self._anim = QPropertyAnimation(self._shadow, b"blurRadius", self)
        self._anim.setDuration(180)
        self._anim.setEasingCurve(QEasingCurve.OutCubic)

        self.toggled.connect(self._on_toggled)
        self._apply_style()

    def _apply_style(self) -> None:
        # Two visual states: checked (filled, accent) and unchecked
        # (transparent fill, muted border). The colors are derived from
        # ``self.accent`` so each pill has its own personality.
        accent = self.accent
        # Mute the unchecked border to roughly 35% of the accent's brightness.
        color = QColor(accent)
        muted = QColor.fromHslF(
            color.hslHueF(),
            max(0.0, color.hslSaturationF() * 0.55),
            min(1.0, color.lightnessF() * 0.55),
        )
        muted_hex = muted.name()
        self.setStyleSheet(f"""
            QPushButton {{
                background: transparent;
                color: #d6dde7;
                border: 1.5px solid {muted_hex};
                border-radius: 22px;
                padding: 0 18px;
            }}
            QPushButton:hover {{
                color: #ffffff;
                border: 1.5px solid {accent};
            }}
            QPushButton:checked {{
                background: qlineargradient(
                    x1:0, y1:0, x2:0, y2:1,
                    stop:0 {accent}, stop:1 {muted_hex}
                );
                color: #0b1220;
                border: 1.5px solid {accent};
            }}
        """)

    def _on_toggled(self, on: bool) -> None:
        self._anim.stop()
        target = 26 if on else 0
        self._anim.setEndValue(target)
        self._anim.start()


class RunModeSelector(QFrame):
    """Three-way selector for: new run / resume / continue adapter.

    Emits ``mode_changed(str)`` whenever the user picks a different mode
    (one of ``RUN_MODE_NEW``, ``RUN_MODE_RESUME``, ``RUN_MODE_CONTINUE``).

    Design choices:
    - Segmented pill control rather than three checkboxes — modes are
      mutually exclusive and segmented controls communicate that
      visually.
    - Each mode owns an accent color. New = sky blue (default/safe),
      Resume = amber (caution: continuing a partial run), Continue =
      mint (action: extend a completed adapter).
    - The right-hand "context" area changes per mode so the user sees
      *only* the inputs that apply to the chosen mode. Less to read,
      less to misuse.
    """

    mode_changed = Signal(str)

    _ACCENTS = {
        RUN_MODE_NEW: "#4FC3F7",       # sky blue
        RUN_MODE_RESUME: "#FFB74D",    # amber
        RUN_MODE_CONTINUE: "#81C784",  # mint
    }
    # Labels read as "kind of run", not as a verb the click triggers.
    # Earlier the New pill was labeled "New Run" which users (correctly)
    # parsed as "start a new run" and clicked expecting training to begin.
    # The pill only SELECTS the mode — Start Training is the action — so
    # the labels are now noun-y and the section header carries a one-line
    # hint clarifying that.
    _LABELS = {
        RUN_MODE_NEW: "🆕  Fresh start",
        RUN_MODE_RESUME: "▶  Resume checkpoint",
        RUN_MODE_CONTINUE: "📈  Continue adapter",
    }

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("RunModeSelector")
        self.setMinimumHeight(64)
        self.setStyleSheet("""
            #RunModeSelector {
                background: qlineargradient(
                    x1:0, y1:0, x2:0, y2:1,
                    stop:0 #1a2332, stop:1 #131c2a
                );
                border: 1px solid #2c3a4f;
                border-radius: 12px;
            }
        """)

        self._mode = RUN_MODE_NEW
        self._pills: dict[str, _ModePill] = {}

        layout = QHBoxLayout(self)
        layout.setContentsMargins(8, 8, 8, 8)
        layout.setSpacing(8)

        for mode in (RUN_MODE_NEW, RUN_MODE_RESUME, RUN_MODE_CONTINUE):
            pill = _ModePill(self._LABELS[mode], self._ACCENTS[mode], self)
            pill.clicked.connect(lambda _checked=False, m=mode: self.set_mode(m))
            layout.addWidget(pill, 1)
            self._pills[mode] = pill

        self._pills[RUN_MODE_NEW].setChecked(True)

    def mode(self) -> str:
        return self._mode

    def set_mode(self, mode: str) -> None:
        if mode not in self._pills or mode == self._mode:
            # Re-check the active pill — Qt unchecks a checked button
            # on second click otherwise, leaving the group with no
            # selection (= invalid state).
            self._pills[self._mode].setChecked(True)
            return
        self._mode = mode
        for m, pill in self._pills.items():
            pill.setChecked(m == mode)
        self.mode_changed.emit(mode)


# =============================================================================
# Save-checkpoints toggle
# =============================================================================


class CheckpointToggle(QFrame):
    """A single-row "save every N steps" control with an animated toggle.

    Why a custom widget rather than a plain QCheckBox + QSpinBox:
    - Checkpoint saving is what makes Resume *possible*; we want this
      surface to read as one decision ("am I making this run resumable
      yes/no, and how often") rather than two unrelated controls.
    - The integer matters only when the toggle is on, so we dim it
      when off and leave it interactive (so the user can pre-set the
      cadence before flipping the switch).
    """

    changed = Signal(bool, int)  # (enabled, save_steps)

    def __init__(self, default_steps: int = 25, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("CheckpointToggle")
        self.setMinimumHeight(56)
        # No content-based minimum width — the children below all
        # have wordWrap / Ignored width policies, so the toggle row
        # follows whatever width the parent column gives it instead
        # of pinning the column open at the long sub-caption width.
        self.setMinimumWidth(0)
        self.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Fixed)
        self.setStyleSheet("""
            #CheckpointToggle {
                background: rgba(20, 28, 42, 0.55);
                border: 1px solid #2c3a4f;
                border-radius: 10px;
            }
            QLabel { background: transparent; }
        """)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(14, 8, 14, 8)
        layout.setSpacing(12)

        # Left: icon + caption + sub-caption.
        icon = QLabel("💾")
        f = QFont(); f.setPointSize(18); icon.setFont(f)
        layout.addWidget(icon)

        text_col = QVBoxLayout()
        text_col.setSpacing(0)
        title = QLabel("Save checkpoints")
        tf = QFont(); tf.setPointSize(11); tf.setBold(True)
        title.setFont(tf)
        title.setStyleSheet("color: #e8eef7;")
        # Both labels wrap and refuse to push their parent wider so
        # they shrink with the column. Without wordWrap, the long
        # "Required for Resume to pick up after Stop / crash."
        # sub-caption was the dominant column-width pin.
        title.setWordWrap(True)
        title.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)
        title.setMinimumWidth(0)
        sub = QLabel("Required for Resume to pick up after Stop / crash.")
        sf = QFont(); sf.setPointSize(8)
        sub.setFont(sf)
        sub.setStyleSheet("color: #8595ad;")
        sub.setWordWrap(True)
        sub.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)
        sub.setMinimumWidth(0)
        text_col.addWidget(title)
        text_col.addWidget(sub)
        layout.addLayout(text_col, 1)

        # Cadence input. Spinbox's content width is small ("99999
        # steps" ≈ 90px) so we drop the explicit 140-px minimum that
        # was being inherited up to the column's width contract.
        layout.addWidget(QLabel("every"))
        self._steps = QSpinBox()
        self._steps.setRange(5, 100000)
        self._steps.setValue(default_steps)
        self._steps.setSingleStep(5)
        self._steps.setSuffix(" steps")
        self._steps.setMinimumWidth(0)
        self._steps.setMinimumHeight(36)
        self._steps.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Fixed)
        self._steps.valueChanged.connect(self._emit)
        layout.addWidget(self._steps)

        # Toggle switch (custom-drawn). Default ON — checkpointing is the
        # only thing that makes a long run recoverable from a crash/OOM.
        self._toggle = _AnimatedSwitch(self)
        self._toggle.setChecked(True)
        self._toggle.toggled.connect(self._on_toggled)
        layout.addWidget(self._toggle)

        self._on_toggled(self._toggle.isChecked())

    def _on_toggled(self, on: bool) -> None:
        self._steps.setEnabled(on)
        self._steps.setStyleSheet(
            "" if on else "color: #5d6c80; background: rgba(20,28,42,0.4);"
        )
        self._emit()

    def _emit(self, *_: object) -> None:
        self.changed.emit(self.is_enabled(), self.save_steps())

    def is_enabled(self) -> bool:
        return self._toggle.isChecked()

    def save_steps(self) -> int:
        return int(self._steps.value())

    def set_state(self, enabled: bool, save_steps: Optional[int] = None) -> None:
        if save_steps is not None:
            self._steps.setValue(int(save_steps))
        self._toggle.setChecked(enabled)


class _AnimatedSwitch(QPushButton):
    """iOS-style animated toggle switch, ~50×28 px.

    Drawn directly via QPainter so it doesn't depend on the active
    QStyle — looks identical on Windows / Fusion / macOS QStyle.
    """

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setCheckable(True)
        self.setCursor(Qt.PointingHandCursor)
        self.setFixedSize(54, 30)
        # Internal "knob position" (0..1). Animated on toggle.
        self._knob = 0.0
        self._anim = QPropertyAnimation(self, b"knob", self)
        self._anim.setDuration(180)
        self._anim.setEasingCurve(QEasingCurve.OutCubic)
        self.toggled.connect(self._animate)
        self.setStyleSheet("border: none; background: transparent;")

    def _get_knob(self) -> float:
        return self._knob

    def _set_knob(self, v: float) -> None:
        self._knob = float(v)
        self.update()

    knob = Property(float, _get_knob, _set_knob)

    def _animate(self, on: bool) -> None:
        self._anim.stop()
        self._anim.setEndValue(1.0 if on else 0.0)
        self._anim.start()

    def paintEvent(self, _event):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        rect = self.rect().adjusted(1, 1, -1, -1)

        # Background track. Interpolate between off (slate) and on (mint).
        off_col = QColor("#3a4a5e")
        on_col = QColor("#81C784")
        t = self._knob
        track = QColor(
            int(off_col.red()   * (1 - t) + on_col.red()   * t),
            int(off_col.green() * (1 - t) + on_col.green() * t),
            int(off_col.blue()  * (1 - t) + on_col.blue()  * t),
        )
        p.setPen(Qt.NoPen)
        p.setBrush(QBrush(track))
        p.drawRoundedRect(rect, rect.height() / 2, rect.height() / 2)

        # Knob.
        knob_r = rect.height() - 6
        x_min = rect.left() + 3
        x_max = rect.right() - knob_r - 3
        x = x_min + (x_max - x_min) * t
        p.setBrush(QBrush(QColor("#ffffff")))
        # Soft inner shadow under the knob.
        p.setPen(QPen(QColor(0, 0, 0, 30), 1))
        p.drawEllipse(int(x), int(rect.top() + 3), knob_r, knob_r)


# =============================================================================
# Status pill
# =============================================================================


class StatusPill(QFrame):
    """A small banner that shows the current training-process state.

    States:
    - ``idle``      grey, "Ready"
    - ``running``   green, "Training — step X/Y" with a pulsing dot
    - ``stopping``  amber, "Stopping… saving checkpoint"
    - ``stopped``   slate, "Stopped — Resume to continue"
    - ``done``      green, "Completed"
    - ``failed``    red, "Failed — check log"

    The pulsing dot uses a QTimer + animated Property to convey "this is
    a live process" without spamming Qt animation events when idle.
    """

    STATES = {
        "idle":     ("Ready",                                  "#5d6c80", False),
        "running":  ("Training",                                "#4CAF50", True),
        "stopping": ("Stopping… saving checkpoint",             "#FFB74D", True),
        "stopped":  ("Stopped — Resume to continue",            "#90A4AE", False),
        "done":     ("Completed",                                "#4CAF50", False),
        "failed":   ("Failed — check log",                       "#EF5350", False),
    }

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("StatusPill")
        self.setFixedHeight(36)
        self.setMinimumWidth(220)

        self._state = "idle"
        self._extra = ""
        self._pulse = 1.0

        layout = QHBoxLayout(self)
        layout.setContentsMargins(14, 4, 14, 4)
        layout.setSpacing(10)

        self._dot = _PulseDot(self)
        layout.addWidget(self._dot)

        self._label = QLabel("Ready")
        f = QFont()
        f.setPointSize(10)
        f.setBold(True)
        self._label.setFont(f)
        self._label.setStyleSheet("background: transparent; color: #e8eef7;")
        layout.addWidget(self._label, 1)

        self._apply_state()

    def set_state(self, state: str, extra: str = "") -> None:
        if state not in self.STATES:
            state = "idle"
        self._state = state
        self._extra = extra
        self._apply_state()

    def _apply_state(self) -> None:
        label, color, pulse = self.STATES[self._state]
        text = f"{label} — {self._extra}" if self._extra else label
        self._label.setText(text)
        self._dot.set_color(color, pulse)
        # Background tint matches the dot color at low alpha so the pill
        # reads as one coherent state rather than dot-vs-text.
        c = QColor(color)
        c.setAlpha(46)
        bg = c.name(QColor.HexArgb)
        self.setStyleSheet(f"""
            #StatusPill {{
                background: {bg};
                border: 1px solid {color};
                border-radius: 18px;
            }}
            QLabel {{ color: #e8eef7; background: transparent; }}
        """)


class _PulseDot(QWidget):
    """Small circle that pulses (alpha animation) when ``pulse=True``.

    Stops the timer when not pulsing so the pill costs nothing while
    idle — Qt fires repaint events otherwise.
    """

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setFixedSize(14, 14)
        self._color = QColor("#5d6c80")
        self._alpha = 1.0
        self._direction = -1
        self._pulsing = False
        self._timer = QTimer(self)
        self._timer.setInterval(50)
        self._timer.timeout.connect(self._tick)

    def set_color(self, color_str: str, pulse: bool) -> None:
        self._color = QColor(color_str)
        if pulse and not self._pulsing:
            self._pulsing = True
            self._timer.start()
        elif not pulse and self._pulsing:
            self._pulsing = False
            self._timer.stop()
            self._alpha = 1.0
        self.update()

    def _tick(self) -> None:
        self._alpha += 0.05 * self._direction
        if self._alpha <= 0.35:
            self._alpha = 0.35
            self._direction = 1
        elif self._alpha >= 1.0:
            self._alpha = 1.0
            self._direction = -1
        self.update()

    def paintEvent(self, _event):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        c = QColor(self._color)
        c.setAlphaF(self._alpha)
        p.setPen(Qt.NoPen)
        p.setBrush(QBrush(c))
        r = self.rect().adjusted(2, 2, -2, -2)
        p.drawEllipse(r)


# =============================================================================
# Start Training panel (mode tiles inside one start surface)
# =============================================================================


class _StartTile(QPushButton):
    """A large start-action tile with icon + title + dynamic subtitle.

    Designed to be sized roughly like a credit card. Three of these live
    in StartTrainingPanel side-by-side; one click on a tile both picks
    the run-mode AND fires the start signal — there's no separate
    "pick then start" two-step.
    """

    def __init__(self, icon: str, title: str, accent: str, parent=None) -> None:
        super().__init__(parent)
        self.accent = accent
        self.setCursor(Qt.PointingHandCursor)
        self.setMinimumHeight(96)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 10, 14, 10)
        layout.setSpacing(2)

        top = QHBoxLayout()
        top.setSpacing(8)
        ic = QLabel(icon)
        icf = QFont(); icf.setPointSize(18)
        ic.setFont(icf)
        top.addWidget(ic)
        self._title = QLabel(title)
        tf = QFont(); tf.setPointSize(12); tf.setBold(True)
        self._title.setFont(tf)
        self._title.setWordWrap(True)
        top.addWidget(self._title, 1)
        layout.addLayout(top)

        self._subtitle = QLabel("")
        sf = QFont(); sf.setPointSize(9)
        self._subtitle.setFont(sf)
        self._subtitle.setWordWrap(True)
        layout.addWidget(self._subtitle, 1)

        # Halo glow in the accent color — same effect as the main Start
        # button used to have, scaled to tile size.
        self._glow = QGraphicsDropShadowEffect(self)
        self._glow.setBlurRadius(22)
        self._glow.setOffset(0, 0)
        self._glow.setColor(QColor(accent))
        self.setGraphicsEffect(self._glow)
        self._apply_style()

    def set_subtitle(self, text: str) -> None:
        self._subtitle.setText(text)

    def _apply_style(self) -> None:
        accent = self.accent
        c = QColor(accent)
        muted = QColor.fromHslF(
            c.hslHueF(),
            max(0.0, c.hslSaturationF() * 0.55),
            max(0.0, c.lightnessF() * 0.45),
        ).name()
        # Tile labels are dark on the bright gradient. The disabled
        # state mutes everything so a "checkpoint not available" tile
        # looks visibly out of action.
        self.setStyleSheet(f"""
            QPushButton {{
                background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
                    stop:0 {accent}, stop:1 {muted});
                color: #0b1220;
                border: none;
                border-radius: 12px;
                text-align: left;
            }}
            QPushButton:hover {{
                background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
                    stop:0 #ffffff, stop:0.4 {accent}, stop:1 {muted});
            }}
            QPushButton:pressed {{
                background: {muted};
            }}
            QPushButton:disabled {{
                background: rgba(60, 70, 84, 0.55);
                color: #5d6c80;
            }}
            QLabel {{
                background: transparent;
                color: #0b1220;
            }}
            QPushButton:disabled QLabel {{
                color: #5d6c80;
            }}
        """)


class StartTrainingPanel(QFrame):
    """Single panel that combines mode selection AND start trigger.

    Three tiles, side by side:
      🆕 Fresh start         — always enabled, kicks off a clean run.
      ▶ Resume checkpoint    — disabled when no checkpoint-* exists.
      📈 Continue adapter    — has a dropdown of all saved adapters
                               under the output dir; click the tile to
                               continue with whichever is selected.

    Emits ``start_requested(mode, adapter_path)`` where:
      - mode is one of ``RUN_MODE_NEW`` / ``_RESUME`` / ``_CONTINUE``
      - adapter_path is the chosen adapter for Continue mode, "" otherwise.

    The panel is self-contained — main.py wires its signal to the
    existing training launch path with the mode passed in directly,
    so there's no separate "pick mode then click Start" two-step.
    """

    start_requested = Signal(str, str)  # (mode, adapter_path)
    # Fired whenever the user changes the Continue-mode adapter
    # selection. Listeners use this to slave the base-model picker to
    # the adapter — a Continue run MUST use the same base the adapter
    # was trained on, never whatever happens to be in the base dropdown.
    adapter_selected = Signal(str)  # adapter path

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("StartTrainingPanel")
        self.setStyleSheet("""
            #StartTrainingPanel {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:1,
                    stop:0 rgba(30, 41, 59, 230), stop:1 rgba(22, 33, 62, 230));
                border: 1px solid #2c3a4f;
                border-radius: 14px;
            }
            QLabel { background: transparent; color: #e8eef7; }
        """)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(14, 14, 14, 14)
        outer.setSpacing(10)

        # Header row — title and hint stack vertically so the hint can
        # wrap when the panel is narrow (the third column is only ~30%
        # of the Train tab width, so the single-line hint used to clip).
        head_lbl = QLabel("🚀  Start Training")
        hf = QFont(); hf.setPointSize(15); hf.setBold(True)
        head_lbl.setFont(hf)
        outer.addWidget(head_lbl)
        hint = QLabel("Click a tile — it both picks the mode AND starts.")
        hint.setStyleSheet("color: #8595ad; font-size: 9pt; font-style: italic;")
        hint.setWordWrap(True)
        outer.addWidget(hint)

        # Tiles row
        tiles = QHBoxLayout()
        tiles.setSpacing(10)

        self._fresh = _StartTile("🆕", "Fresh start", "#4FC3F7")
        self._fresh.set_subtitle("Train from step 0 with the current settings.")
        self._fresh.clicked.connect(
            lambda: self.start_requested.emit(RUN_MODE_NEW, "")
        )
        tiles.addWidget(self._fresh, 1)

        self._resume = _StartTile("▶", "Resume checkpoint", "#FFB74D")
        self._resume.set_subtitle("(no checkpoint found in output dir)")
        self._resume.setEnabled(False)
        self._resume.clicked.connect(
            lambda: self.start_requested.emit(RUN_MODE_RESUME, "")
        )
        tiles.addWidget(self._resume, 1)

        # Continue is special — it owns a dropdown so the user can
        # pick which adapter to continue. The DROPDOWN sits under the
        # tile so it doesn't interrupt the row of three same-size tiles.
        continue_col = QVBoxLayout()
        continue_col.setSpacing(4)
        self._continue = _StartTile("📈", "Continue adapter", "#81C784")
        self._continue.set_subtitle("(no adapters in output dir)")
        self._continue.setEnabled(False)
        self._continue.clicked.connect(self._fire_continue)
        continue_col.addWidget(self._continue, 1)

        self._adapter_combo = QComboBox()
        self._adapter_combo.setMinimumHeight(28)
        self._adapter_combo.setEnabled(False)
        self._adapter_combo.setStyleSheet("""
            QComboBox {
                background: rgba(20, 28, 42, 0.7);
                color: #e8eef7;
                border: 1px solid #2c3a4f;
                border-radius: 6px;
                padding: 2px 8px;
                font-size: 9pt;
            }
            QComboBox::drop-down { width: 18px; }
            QComboBox QAbstractItemView {
                background: #1a2332;
                color: #e8eef7;
                selection-background-color: #81C784;
                selection-color: #0b1220;
            }
        """)
        self._adapter_combo.currentTextChanged.connect(self._on_adapter_changed)
        continue_col.addWidget(self._adapter_combo)
        tiles.addLayout(continue_col, 1)

        outer.addLayout(tiles)

    # -- public API ---------------------------------------------------

    def set_resume_state(self, label: Optional[str], enabled: bool) -> None:
        """Update the Resume tile from a checkpoint scan.

        Args:
            label: short subtitle like ``"from step 25"`` (when enabled)
                or ``"(none — enable Save Checkpoints first)"`` (when
                disabled).
            enabled: True when a real checkpoint-* dir was found.
        """
        if label is None:
            label = "(no checkpoint found)"
        self._resume.set_subtitle(label)
        self._resume.setEnabled(bool(enabled))

    def set_adapter_options(self, adapter_paths: list) -> None:
        """Populate the Continue dropdown.

        Newest adapter (first item) becomes the default selection so
        the user's most recent training run is one click away.
        """
        self._adapter_combo.blockSignals(True)
        try:
            self._adapter_combo.clear()
            if not adapter_paths:
                self._adapter_combo.addItem("(no adapters in output dir)", "")
                self._adapter_combo.setEnabled(False)
                self._continue.setEnabled(False)
                self._continue.set_subtitle("(no adapters in output dir)")
                return
            self._adapter_combo.setEnabled(True)
            self._continue.setEnabled(True)
            for p in adapter_paths:
                self._adapter_combo.addItem(Path(str(p)).name, str(p))
            # Reflect the auto-selected adapter in the tile subtitle.
            first = Path(str(adapter_paths[0])).name
            self._continue.set_subtitle(f"continue:  {first}")
        finally:
            self._adapter_combo.blockSignals(False)

    def set_running(self, running: bool) -> None:
        """Disable all tiles while training is running. Re-enables the
        modes that have valid context when training ends.
        """
        if running:
            for t in (self._fresh, self._resume, self._continue):
                t.setEnabled(False)
            self._adapter_combo.setEnabled(False)
        else:
            self._fresh.setEnabled(True)
            # Resume / Continue only re-enable if they have valid state.
            # Caller is expected to call set_resume_state /
            # set_adapter_options after this to refresh.
            self._adapter_combo.setEnabled(self._adapter_combo.count() > 0
                                           and self._adapter_combo.itemData(0) != "")

    # -- internals ----------------------------------------------------

    def _on_adapter_changed(self, _text: str) -> None:
        # Mirror the selected adapter into the tile subtitle AND notify
        # listeners so the base-model picker in main.py can be slaved
        # to the adapter's actual base. A Continue run that uses a base
        # different from what the adapter was trained on produces
        # garbage output — see the very explicit user feedback that
        # prompted this signal.
        idx = self._adapter_combo.currentIndex()
        if idx < 0:
            return
        path = self._adapter_combo.itemData(idx) or ""
        if not path:
            return
        self._continue.set_subtitle(f"continue:  {Path(str(path)).name}")
        self.adapter_selected.emit(str(path))

    def _fire_continue(self) -> None:
        path = self._adapter_combo.currentData() or ""
        if not path:
            return
        self.start_requested.emit(RUN_MODE_CONTINUE, str(path))

