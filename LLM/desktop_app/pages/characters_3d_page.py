"""3D characters page with real LLM-backed interaction and animated GLTF visuals."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

from PySide6.QtCore import QObject, Qt, QThread, Signal, QTimer, QUrl
from PySide6.QtWidgets import (
    QComboBox,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QSplitter,
    QVBoxLayout,
    QWidget,
)
from PySide6.QtWebEngineCore import QWebEnginePage
from PySide6.QtWebEngineWidgets import QWebEngineView

from core.agents.backends import parse_id
from core.agents.bus import get_bus
from core.agents.message import Message, MessageKind
from core.models import list_local_downloads
from desktop_app.widgets.model_picker import ModelPickerButton


def _truncate_speech(text: str, limit: int = 120) -> str:
    """Cap speech-bubble length — long replies overflow the 3D scene."""
    text = text.replace("\n", " ").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


# Mirror of MODEL_CATALOG in assets/3d/main.js — the JS side is the
# authoritative loader; this list just gives the visual selector a
# labeled, ordered dropdown of available 3D models. Keep grouped by
# theme: humanoids first, then anime, classic, creatures, custom.
VISUAL_CATALOG = (
    ("fantasy_knight",   "🛡️  Fantasy Knight"),
    ("fantasy_mage",     "🧙  Fantasy Mage"),
    ("fantasy_rogue",    "🗡️  Fantasy Rogue"),
    ("anime_blade",      "⚔️  Anime Blade"),
    ("anime_guardian",   "🛡️  Anime Guardian"),
    ("anime_urban",      "🧥  Anime Urban"),
    ("anime_tokyo",      "🏙️  Anime Tokyo"),
    ("anime_android",    "🤖  Anime Android"),
    ("classic_soldier",  "🪖  Classic Soldier"),
    ("classic_xbot",     "👾  Classic XBot"),
    ("classic_cesium",   "🧍  Classic Cesium"),
    ("classic_robot",    "🤖  Classic Robot"),
    ("wild_fox",         "🦊  Wild Fox"),
    ("wild_horse",       "🐴  Wild Horse"),
    ("wild_flamingo",    "🦩  Wild Flamingo"),
    ("wild_parrot",      "🦜  Wild Parrot"),
    ("mystic_brainstem", "🧠  Mystic Brainstem"),
    ("d_rex",            "🦖  D-Rex"),
    ("julio_cesar",      "👑  Julio Cesar"),
    ("napoleon",         "🎖️  Napoleon"),
    ("bonaparte",        "🪖  Bonaparte"),
)


# Map agent roles -> the existing 3D character slots A/B/C. Three slots,
# five roles — operator and critic don't get a character yet (they still
# show up in the Agents tab stream). Adding more slots is a 3D-asset
# question, not a Python question.
AGENT_TO_CHARACTER = {
    "orchestrator": "A",
    "researcher": "B",
    "coder": "C",
}


class _CharacterBusBridge(QObject):
    """Re-emit bus events on the GUI thread for Characters3DPage.

    Same pattern as AgentsPage's bridge — bus callbacks fire on whatever
    worker publishes, and Qt webengine calls must be on the GUI thread.
    """

    message = Signal(object)  # core.agents.message.Message
    speech_started = Signal(str)  # agent name
    speech_ended = Signal(str)    # agent name


class BridgePage(QWebEnginePage):
    """Intercept JSON console messages from JS as a lightweight bridge."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.message_callback = None

    def javaScriptConsoleMessage(self, level, message, lineNumber, sourceID):  # noqa: N802
        try:
            if message.startswith("{") and '"type"' in message:
                payload = json.loads(message)
                if self.message_callback:
                    self.message_callback(payload)
                return
        except Exception:
            pass
        super().javaScriptConsoleMessage(level, message, lineNumber, sourceID)


class InferenceWorker(QThread):
    """Background inference job — routes to whatever backend the picker chose.

    Accepts a *composite backend id* ("backend|model_key") rather than just a
    local model id, so a 3D character can be powered by Claude subscription,
    GPT API, or any local model — same selection surface as the agent cards.
    """

    finished_signal = Signal(str, str, str)  # cid, text, error

    def __init__(self, cid: str, composite_id: str, prompt: str, temperature: float = 0.8, max_tokens: int = 90):
        super().__init__()
        self.cid = cid
        self.composite_id = composite_id
        self.prompt = prompt
        self.temperature = float(temperature)
        self.max_tokens = int(max_tokens)

    def run(self):
        try:
            from core.agents.backends import dispatch_model_fn
            messages = [{"role": "user", "content": self.prompt}]
            text = (dispatch_model_fn(messages, self.composite_id) or "").strip()
            self.finished_signal.emit(self.cid, text or "(no response)", "")
        except Exception as exc:
            self.finished_signal.emit(self.cid, "", str(exc))


class Characters3DPage(QWidget):
    """Interactive 3D character scene with model assignment and real generation."""

    _CHARACTER_META = {
        "A": {
            "title": "Arcblade (Knight)",
            "persona": "You are Arcblade, a brave tiny knight. Reply in one short fantasy line.",
            "visual": "soldier",
        },
        "B": {
            "title": "Mira (Mage)",
            "persona": "You are Mira, a playful mage. Reply in one short witty fantasy line.",
            "visual": "robot",
        },
        "C": {
            "title": "Kite (Scout)",
            "persona": "You are Kite, a rogue scout. Reply in one short sharp fantasy line.",
            "visual": "xbot",
        },
    }

    def __init__(self, parent=None):
        super().__init__(parent)
        self._workers: list[InferenceWorker] = []
        self.char_pickers: dict[str, ModelPickerButton] = {}
        self.status_label: QLabel | None = None
        self._setup_ui()

        self.web_page = BridgePage(self)
        self.web_page.message_callback = self._on_js_message
        self.web_view.setPage(self.web_page)

        base_dir = Path(__file__).parent.parent
        index_path = base_dir / "assets" / "3d" / "index.html"
        if not index_path.exists():
            self._disable_scene_with_error(f"Missing asset: {index_path.name}")
        else:
            self.web_view.setUrl(QUrl.fromLocalFile(str(index_path)))

        QTimer.singleShot(500, self._refresh_models)

        # Subscribe to the agent bus so we can animate / speak when the
        # multi-agent runtime in the Agents tab does work. Bus subscriber
        # callbacks fire on worker threads, so we go through a Qt signal
        # bridge to land everything on the GUI thread before touching JS.
        self._agent_bridge = _CharacterBusBridge()
        self._agent_bridge.message.connect(self._on_agent_bus_message)
        self._agent_bridge.speech_started.connect(self._on_speech_started)
        self._agent_bridge.speech_ended.connect(self._on_speech_ended)
        # Hook the TTS service so the bubble + label pulse while an agent
        # is being spoken aloud. Listener fires on the worker thread, so
        # we hop through the Qt bridge before touching JS.
        try:
            from core.voice import get_tts_service
            tts = get_tts_service()
            tts.add_listener(
                on_start=lambda agent, text: (
                    self._agent_bridge.speech_started.emit(agent) if agent else None
                ),
                on_end=lambda agent, text: (
                    self._agent_bridge.speech_ended.emit(agent) if agent else None
                ),
            )
        except Exception:  # noqa: BLE001 — voice is non-essential here
            pass
        try:
            get_bus().subscribe(lambda m: self._agent_bridge.message.emit(m))
        except Exception:
            # Bus init can fail in environments without a writable data dir
            # (e.g. some test harnesses). Don't take down the 3D page over it.
            pass

    def _disable_scene_with_error(self, msg: str):
        self.web_view.setHtml(
            "<html><body style='background:#15181f;color:#ff9f9f;font-family:sans-serif;padding:20px;'>"
            f"<h3>3D Scene Disabled</h3><p>{msg}</p></body></html>"
        )

    def _setup_ui(self):
        root = QHBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)

        splitter = QSplitter(Qt.Horizontal)
        root.addWidget(splitter)
        # Store on self so the host (MainWindow) can later swap the
        # left-side panel for an Arena-style A/B/C selector column —
        # see ``replace_left_panel`` below.
        self._splitter = splitter

        panel = QWidget()
        self._panel = panel
        panel_layout = QVBoxLayout(panel)
        panel_layout.setContentsMargins(14, 14, 14, 14)

        title = QLabel("3D Character Arena")
        title.setStyleSheet("font-size: 17pt; font-weight: 700; margin-bottom: 8px;")
        panel_layout.addWidget(title)

        subtitle = QLabel(
            "Assign a real local model to each character. Buttons run actual inference, "
            "and characters physically move before interaction."
        )
        subtitle.setWordWrap(True)
        subtitle.setStyleSheet("color:#97a2b7; margin-bottom: 8px;")
        panel_layout.addWidget(subtitle)

        # Use the same provider-grouped picker the agent cards use, so a
        # 3D character's model selection looks and behaves identically:
        # Local / Anthropic / OpenAI groups, "Connect <provider> in
        # Accounts tab" hints, "Install / start →" CTA when Local is
        # empty.
        self.char_pickers: dict[str, ModelPickerButton] = {}
        self.char_visual_combos: dict[str, QComboBox] = {}

        for cid in ("A", "B", "C"):
            meta = self._CHARACTER_META[cid]
            group = QGroupBox(f"{cid}: {meta['title']}")
            g_layout = QVBoxLayout(group)

            # Visual / character-model selector — pick which 3D model
            # represents this slot. Lets the user swap a knight for a
            # mage, fox, robot, etc. on the fly. Pulls from the JS-side
            # MODEL_CATALOG (see assets/3d/main.js).
            visual_row = QHBoxLayout()
            visual_label = QLabel("Visual:")
            visual_label.setStyleSheet("color:#97a2b7; font-size:11px;")
            visual_row.addWidget(visual_label)
            visual_combo = QComboBox()
            for key, label in VISUAL_CATALOG:
                visual_combo.addItem(label, key)
            # Default to the slot's hardcoded persona visual if present
            # in the catalog, else fall back to the first entry.
            default_idx = visual_combo.findData(meta.get("visual", ""))
            if default_idx >= 0:
                visual_combo.setCurrentIndex(default_idx)
            visual_combo.currentIndexChanged.connect(
                lambda _i, k=cid: self._on_visual_changed(k)
            )
            self.char_visual_combos[cid] = visual_combo
            visual_row.addWidget(visual_combo, 1)
            g_layout.addLayout(visual_row)

            # Model (LLM) picker.
            picker = ModelPickerButton(on_install_local=self._open_models_tab)
            picker.refresh_entries()
            picker.selection_changed.connect(
                lambda _composite, k=cid: self._on_model_selection_changed(k)
            )
            self.char_pickers[cid] = picker
            g_layout.addWidget(picker)

            row = QHBoxLayout()
            btn_line = QPushButton("Generate line")
            btn_line.clicked.connect(lambda _checked=False, k=cid: self._generate_line(k))
            btn_poke = QPushButton("Poke next")
            btn_poke.clicked.connect(lambda _checked=False, k=cid: self._poke_next(k))
            row.addWidget(btn_line)
            row.addWidget(btn_poke)
            g_layout.addLayout(row)

            panel_layout.addWidget(group)

        convo_btn = QPushButton("Run 3-way conversation round")
        convo_btn.clicked.connect(self._run_round_robin)
        panel_layout.addWidget(convo_btn)

        refresh_btn = QPushButton("Refresh models")
        refresh_btn.clicked.connect(self._refresh_models)
        panel_layout.addWidget(refresh_btn)

        self.status_label = QLabel("Ready")
        self.status_label.setStyleSheet("color:#8ca0c5;")
        panel_layout.addWidget(self.status_label)
        panel_layout.addStretch(1)

        self.web_view = QWebEngineView()
        splitter.addWidget(panel)
        splitter.addWidget(self.web_view)
        splitter.setSizes([360, 980])

    def replace_left_panel(self, new_panel: QWidget) -> None:
        """Swap the left-side panel inside the splitter.

        MainWindow uses this to plug in the Arena-style model A/B/C
        selector column (Avatar Selection + Instruction Templates +
        System Prompt + Logs/Unfiltered tabs) in place of the legacy
        '3D Character Arena' panel that lived here originally.

        The web view (right side) is left untouched.
        """
        splitter = getattr(self, "_splitter", None)
        old_panel = getattr(self, "_panel", None)
        if splitter is None or old_panel is None:
            return
        idx = splitter.indexOf(old_panel)
        if idx < 0:
            return
        # Insert the new panel where the old one lived, then drop the
        # old one. ``QSplitter`` doesn't have a 'replace' API; this is
        # the canonical 2-step dance.
        splitter.insertWidget(idx, new_panel)
        old_panel.setParent(None)
        old_panel.deleteLater()
        self._panel = new_panel
        # Restore the original-ish split — the panel is roughly the
        # same width as before (~360 px); the web view gets the rest.
        splitter.setSizes([360, max(360, splitter.width() - 360)])

    def _set_status(self, text: str):
        if self.status_label:
            self.status_label.setText(text)

    def _open_models_tab(self) -> None:
        """Picker's empty-Local CTA — bounce to the Models tab."""
        try:
            host = self.parent()
            if host and hasattr(host, "_switch_tab") and hasattr(host, "tabs"):
                host._switch_tab(host.tabs, "models")
        except Exception:
            pass

    def _refresh_models(self):
        # The provider-grouped picker pulls its own entries from the
        # backend registry (local + Claude/Codex CLI + Anthropic/OpenAI
        # API). We just trigger a refresh on each picker.
        for picker in self.char_pickers.values():
            picker.refresh_entries()
        self._set_status("Models refreshed.")

    def _on_model_selection_changed(self, cid: str):
        picker = self.char_pickers.get(cid)
        composite = picker.current_id() if picker else ""
        if not composite:
            label = self._CHARACTER_META[cid]["title"].split(" ")[0]
        else:
            try:
                _backend, model_key = parse_id(composite)
                # For local model_keys (which are paths/canonical ids), show
                # the file stem; for cloud ids ('claude-opus-4-7'), show as-is.
                stem = Path(model_key).stem if "/" in model_key or "\\" in model_key else model_key
                label = stem[:20]
            except Exception:
                label = composite[:20]
        self._call_js("window.updateLabels", cid, label)
        # Updating the model doesn't change the visual — leave the visual
        # alone so the user's picked character model isn't overwritten on
        # every model-dropdown change.

    def _on_visual_changed(self, cid: str) -> None:
        """Swap the 3D model representing this slot."""
        combo = self.char_visual_combos.get(cid)
        if combo is None:
            return
        visual_key = combo.currentData()
        if not visual_key:
            return
        self._call_js("window.assignVisual", cid, visual_key)

    def _call_js(self, fn_name: str, *args):
        js_args = ", ".join(json.dumps(arg) for arg in args)
        self.web_view.page().runJavaScript(f"{fn_name}({js_args});")

    # ------------------------------------------------------------------
    # Agent bus integration
    # ------------------------------------------------------------------

    def _on_agent_bus_message(self, msg: Message) -> None:
        """Render an agent bus event in the 3D scene.

        Mapping (kept conservative — only 3 character slots):

        * THOUGHT or REPLY from a mapped agent -> characterSay with the body
          (truncated). This is the cute payoff: when the orchestrator dispatches
          and the researcher reads a file, you see them actually speak.
        * TOOL_CALL -> short "🔧 read_file()" line so it's clear who's working.
        * TOOL_RESULT and EVENT -> ignored to avoid spamming the bubbles.

        Errors swallowed: a JS bridge hiccup must never bubble back to the
        agent loop and crash a goal.
        """
        try:
            cid = AGENT_TO_CHARACTER.get(msg.from_agent)
            if cid is None:
                return

            if msg.kind in (MessageKind.REPLY, MessageKind.THOUGHT):
                line = (msg.body or "").strip()
                if not line:
                    return
                self._call_js("window.characterSay", cid, _truncate_speech(line))
            elif msg.kind == MessageKind.TOOL_CALL:
                tool = (msg.meta or {}).get("tool", "tool")
                self._call_js("window.characterSay", cid, f"🔧 {tool}()")
        except Exception:
            # Don't crash the page — if the JS bridge isn't ready (page
            # still loading) calls just no-op.
            pass

    def _on_speech_started(self, agent: str) -> None:
        """TTS just started speaking ``agent``'s reply — pulse the bubble."""
        try:
            cid = AGENT_TO_CHARACTER.get(agent)
            if cid is not None:
                self._call_js("window.characterStartTalking", cid)
        except Exception:
            pass

    def _on_speech_ended(self, agent: str) -> None:
        try:
            cid = AGENT_TO_CHARACTER.get(agent)
            if cid is not None:
                self._call_js("window.characterStopTalking", cid)
        except Exception:
            pass

    def _start_inference(self, cid: str, prompt: str, done: Callable[[str], None] | None = None):
        picker = self.char_pickers.get(cid)
        composite = picker.current_id() if picker else ""
        if not composite:
            self._call_js("window.characterSay", cid, "Assign a model first.")
            return

        self._set_status(f"Running inference for {cid}...")
        worker = InferenceWorker(
            cid=cid,
            composite_id=composite,
            prompt=prompt,
            temperature=0.8,
            max_tokens=85,
        )
        self._workers.append(worker)

        def on_finished(worker_cid: str, text: str, error: str):
            if error:
                self._call_js("window.characterSay", worker_cid, f"Error: {error[:150]}")
                self._set_status(f"{worker_cid} failed")
            else:
                self._call_js("window.characterSay", worker_cid, text)
                self._set_status(f"{worker_cid} replied")
                if done:
                    done(text)
            try:
                self._workers.remove(worker)
            except ValueError:
                pass
            worker.deleteLater()

        worker.finished_signal.connect(on_finished)
        worker.start()

    def _build_prompt(self, cid: str, scene_event: str) -> str:
        persona = self._CHARACTER_META[cid]["persona"]
        return (
            f"{persona}\n"
            "Constraints: one sentence, max 20 words, no markdown.\n"
            f"Scene event: {scene_event}\n"
            "Speak in character now."
        )

    def _generate_line(self, cid: str):
        self._call_js("window.characterAction", cid, "wave")
        prompt = self._build_prompt(cid, "You are greeting the other two characters.")
        self._start_inference(cid, prompt)

    def _next_char(self, cid: str) -> str:
        order = ["A", "B", "C"]
        return order[(order.index(cid) + 1) % len(order)]

    def _poke_next(self, cid: str):
        target = self._next_char(cid)
        self._call_js("window.sceneInteract", cid, target, "combat")
        attacker_prompt = self._build_prompt(cid, f"You just playfully poked {self._CHARACTER_META[target]['title']}.")
        target_prompt = self._build_prompt(target, f"You were playfully poked by {self._CHARACTER_META[cid]['title']}.")
        self._start_inference(cid, attacker_prompt)
        QTimer.singleShot(900, lambda: self._start_inference(target, target_prompt))

    def _run_round_robin(self):
        active = [cid for cid, picker in self.char_pickers.items() if picker.current_id()]
        if len(active) < 2:
            self._set_status("Assign at least 2 models first")
            return
        self._set_status("Starting conversation round...")
        for idx, cid in enumerate(active):
            event = f"Conversation round turn {idx + 1}. React to prior messages in-world."
            QTimer.singleShot(idx * 900, lambda k=cid, e=event: self._start_inference(k, self._build_prompt(k, e)))

    def _on_js_message(self, payload: dict):
        if payload.get("type") == "click" and payload.get("id") in self._CHARACTER_META:
            cid = payload["id"]
            prompt = self._build_prompt(cid, "You were selected by the user. Acknowledge confidently.")
            self._start_inference(cid, prompt)
