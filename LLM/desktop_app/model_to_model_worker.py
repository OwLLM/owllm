"""Worker thread for Model To Model automated conversation between 2 or 3 models."""
from __future__ import annotations

import threading
from PySide6.QtCore import QThread, Signal


class ModelToModelWorker(QThread):
    """
    Runs a round-robin model-to-model conversation in a background thread.
    Emits turn_started(model_key), turn_finished(model_key, text), finished_signal(), error_signal(message).
    Supports pause/resume via set_paused(True/False); checks pause between turns.
    """
    turn_started = Signal(str)   # model_key "a", "b", "c"
    turn_finished = Signal(str, str)  # model_key, text
    finished_signal = Signal()
    error_signal = Signal(str)

    def __init__(
        self,
        seed: str,
        model_ids: list[str],
        model_keys: list[str],
        max_turns: int = 20,
        temperature: float = 0.7,
        max_new_tokens: int = 10000,
        parent=None,
    ):
        super().__init__(parent)
        self.seed = seed or ""
        self.model_ids = list(model_ids) if model_ids else []
        self.model_keys = list(model_keys) if model_keys else []
        self.max_turns = max(1, int(max_turns))
        self.temperature = float(temperature)
        self.max_new_tokens = int(max_new_tokens)
        self._paused = False
        self._pause_event = threading.Event()  # set when paused so we can wait on it

    def set_paused(self, paused: bool):
        self._paused = bool(paused)
        if not self._paused:
            self._pause_event.set()
        else:
            self._pause_event.clear()

    def run(self):
        try:
            from core.inference import run_inference, InferenceConfig
        except Exception as e:
            self.error_signal.emit(f"Failed to import inference: {e}")
            self.finished_signal.emit()
            return

        if not self.model_ids or not self.model_keys or len(self.model_ids) != len(self.model_keys):
            self.error_signal.emit("Model list and keys length mismatch.")
            self.finished_signal.emit()
            return

        n = len(self.model_ids)
        history_lines = []
        topic_line = "Topic or initial prompt:\n" + self.seed

        def _trim_single_turn(raw: str, this_key: str) -> str:
            """Keep only this model's reply: strip leading 'Model X:', truncate at next 'Model Y:'."""
            s = (raw or "").strip()
            this_label = f"Model {this_key.upper()}:"
            if s.startswith(this_label):
                s = s[len(this_label):].lstrip()
            for other in ("Model A:", "Model B:", "Model C:"):
                if other == this_label:
                    continue
                idx = s.find(other)
                if idx >= 0:
                    s = s[:idx].rstrip()
            return s.strip()

        for turn in range(self.max_turns):
            while self._paused and not self.isInterruptionRequested():
                self._pause_event.clear()
                self._pause_event.wait(timeout=0.5)
                if self.isInterruptionRequested():
                    self.finished_signal.emit()
                    return

            speaker_idx = turn % n
            model_id = self.model_ids[speaker_idx]
            model_key = self.model_keys[speaker_idx]
            speaker_label = f"Model {model_key.upper()}"

            if history_lines:
                conv = "\n\n".join(history_lines)
                prompt = (
                    f"You are {speaker_label}. Reply only with your single message; do not write for other models.\n\n"
                    f"{topic_line}\n\n"
                    f"Conversation so far:\n{conv}\n\n"
                    f"{speaker_label}:"
                )
            else:
                prompt = (
                    f"You are {speaker_label}. Reply only with your single message; do not write for other models.\n\n"
                    f"{topic_line}\n\n"
                    f"{speaker_label}:"
                )

            self.turn_started.emit(model_key)

            try:
                cfg = InferenceConfig(
                    prompt=prompt,
                    model_id=model_id,
                    max_new_tokens=self.max_new_tokens,
                    temperature=self.temperature,
                )
                text = run_inference(cfg)
            except Exception as e:
                self.error_signal.emit(f"Model {model_key.upper()} error: {e}")
                self.finished_signal.emit()
                return

            text = _trim_single_turn(text or "", model_key)

            if not text:
                self.error_signal.emit(f"Model {model_key.upper()} returned empty response.")
                self.finished_signal.emit()
                return

            self.turn_finished.emit(model_key, text)
            history_lines.append(f"Model {model_key.upper()}: {text}")

        self.finished_signal.emit()
