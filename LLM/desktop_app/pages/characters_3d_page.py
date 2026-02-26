"""3D characters page with real LLM-backed interaction and animated GLTF visuals."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

from PySide6.QtCore import Qt, QThread, Signal, QTimer, QUrl
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

from core.models import list_local_downloads


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
    """Background inference job to keep UI responsive."""

    finished_signal = Signal(str, str, str)  # cid, text, error

    def __init__(self, cid: str, model_id: str, prompt: str, temperature: float = 0.8, max_tokens: int = 90):
        super().__init__()
        self.cid = cid
        self.model_id = model_id
        self.prompt = prompt
        self.temperature = float(temperature)
        self.max_tokens = int(max_tokens)

    def run(self):
        try:
            from core.inference import InferenceConfig, run_inference

            cfg = InferenceConfig(
                prompt=self.prompt,
                model_id=self.model_id,
                max_new_tokens=self.max_tokens,
                temperature=self.temperature,
            )
            out = run_inference(cfg).strip()
            self.finished_signal.emit(self.cid, out or "(no response)", "")
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
        self.char_combos: dict[str, QComboBox] = {}
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

        panel = QWidget()
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

        for cid in ("A", "B", "C"):
            meta = self._CHARACTER_META[cid]
            group = QGroupBox(f"{cid}: {meta['title']}")
            g_layout = QVBoxLayout(group)

            combo = QComboBox()
            combo.addItem("None", None)
            self.char_combos[cid] = combo
            combo.currentTextChanged.connect(lambda _text, k=cid: self._on_model_selection_changed(k))
            g_layout.addWidget(combo)

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

    def _set_status(self, text: str):
        if self.status_label:
            self.status_label.setText(text)

    def _refresh_models(self):
        model_paths = list_local_downloads()
        for cid, combo in self.char_combos.items():
            current_data = combo.currentData()
            combo.blockSignals(True)
            combo.clear()
            combo.addItem("None", None)
            for model_path in model_paths:
                p = Path(model_path)
                display = p.name
                if p.parent.name:
                    display = f"{p.name} ({p.parent.name})"
                combo.addItem(display, str(model_path))
            if current_data:
                idx = combo.findData(current_data)
                if idx >= 0:
                    combo.setCurrentIndex(idx)
            combo.blockSignals(False)
            self._on_model_selection_changed(cid)
        self._set_status(f"Loaded {len(model_paths)} local model(s)")

    def _on_model_selection_changed(self, cid: str):
        combo = self.char_combos[cid]
        model_path = combo.currentData()
        if not model_path:
            label = self._CHARACTER_META[cid]["title"].split(" ")[0]
        else:
            label = Path(model_path).stem[:20]
        self._call_js("window.updateLabels", cid, label)
        self._call_js("window.assignVisual", cid, self._CHARACTER_META[cid]["visual"])

    def _call_js(self, fn_name: str, *args):
        js_args = ", ".join(json.dumps(arg) for arg in args)
        self.web_view.page().runJavaScript(f"{fn_name}({js_args});")

    def _resolve_model_id(self, model_path: str) -> str:
        host = self.parent()
        if host and hasattr(host, "_resolve_chat_model_id_from_path"):
            return host._resolve_chat_model_id_from_path(model_path)  # type: ignore[attr-defined]
        raise RuntimeError("Main app resolver is not available")

    def _start_inference(self, cid: str, prompt: str, done: Callable[[str], None] | None = None):
        model_path = self.char_combos[cid].currentData()
        if not model_path:
            self._call_js("window.characterSay", cid, "Assign a model first.")
            return
        try:
            model_id = self._resolve_model_id(str(model_path))
        except Exception as exc:
            self._call_js("window.characterSay", cid, f"Model setup error: {exc}")
            return

        self._set_status(f"Running inference for {cid}...")
        worker = InferenceWorker(cid=cid, model_id=model_id, prompt=prompt, temperature=0.8, max_tokens=85)
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
        active = [cid for cid, combo in self.char_combos.items() if combo.currentData()]
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
