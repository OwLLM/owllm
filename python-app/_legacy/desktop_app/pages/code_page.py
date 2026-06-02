"""Code tab — embeds bundled VSCodium inside an OWLLM Qt host.

UX flow:
- First open: run :func:`vscodium_manager.ensure_ready` on a worker thread,
  showing a progress label. Bootstraps VSCodium portable + Cline + settings
  if the bundle isn't present yet.
- Once ready: button-bar header with workspace selector and model selector,
  plus a host widget that contains the reparented VSCodium window.

Closing the page or quitting OWLLM kills the bundled VSCodium process so we
don't leak a ghost editor.
"""
from __future__ import annotations

import logging
import subprocess
import sys
from pathlib import Path
from typing import Optional

from PySide6.QtCore import QEvent, QObject, QSettings, Qt, QThread, QTimer, Signal
from PySide6.QtGui import QWindow
from PySide6.QtWidgets import (
    QComboBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QStackedWidget,
    QVBoxLayout,
    QWidget,
)

from desktop_app import cline_proxy, vscodium_manager

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Foreign-HWND focus forwarder
# ---------------------------------------------------------------------------

if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes
    _user32 = ctypes.WinDLL("user32", use_last_error=True)
    _user32.SetFocus.argtypes = [wintypes.HWND]
    _user32.SetFocus.restype = wintypes.HWND
    _user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    _user32.SetForegroundWindow.restype = wintypes.BOOL
    _user32.SetActiveWindow.argtypes = [wintypes.HWND]
    _user32.SetActiveWindow.restype = wintypes.HWND
    _user32.IsWindow.argtypes = [wintypes.HWND]
    _user32.IsWindow.restype = wintypes.BOOL
else:
    _user32 = None


class _ForwardFocusFilter(QObject):
    """Forward Qt focus / mouse activation to the embedded VSCodium HWND.

    ``QWidget.createWindowContainer(QWindow.fromWinId(hwnd))`` on Windows
    visually embeds a foreign top-level window but does not pipe Qt focus
    events through to it — keystrokes go to OWLLM's Qt event loop and are
    silently dropped. We install this filter on both the container widget
    and its parent host so any FocusIn / MouseButtonPress / WindowActivate
    triggers a hard focus handoff via the Win32 API. No-op on non-Windows.
    """

    _FORWARD_EVENTS = {
        QEvent.FocusIn,
        QEvent.MouseButtonPress,
        QEvent.MouseButtonRelease,
        QEvent.WindowActivate,
        QEvent.Enter,
    }

    def __init__(self, hwnd: int) -> None:
        super().__init__()
        self._hwnd = int(hwnd)

    def force_focus(self) -> None:
        if _user32 is None or not self._hwnd:
            return
        try:
            if not _user32.IsWindow(self._hwnd):
                return
            _user32.SetForegroundWindow(self._hwnd)
            _user32.SetActiveWindow(self._hwnd)
            _user32.SetFocus(self._hwnd)
        except Exception:
            pass

    def eventFilter(self, obj, event):  # type: ignore[override]
        try:
            if event.type() in self._FORWARD_EVENTS:
                self.force_focus()
        except Exception:
            pass
        return False  # don't consume — let Qt do its normal thing too


# ---------------------------------------------------------------------------
# Worker for the one-time bootstrap (download + Cline install + seed)
# ---------------------------------------------------------------------------


class _StartServerWorker(QObject):
    """Resolve a base_model_path to the server-manager config id (creating a
    config entry if needed), then run
    ``LLMServerManager.ensure_server_running(config_id)``. Both steps off the
    GUI thread because they can take 30s+ for the first warmup."""

    progress = Signal(str)
    done = Signal(str, str, bool, str)  # display_name, server_url, ok, error

    def __init__(self, manager, main_window, display_name: str, base_model_path: str) -> None:
        super().__init__()
        self.manager = manager
        self.main_window = main_window
        self.display_name = display_name
        self.base_model_path = base_model_path

    def _file_log(self, msg: str) -> None:
        # Direct file write — does NOT go through MainWindow methods (which
        # touch GUI widgets and would warn/crash from a non-GUI thread). This
        # is a worker-only log so we can see whether ``run()`` even executes.
        try:
            from datetime import datetime
            ts = datetime.now().strftime("%H:%M:%S")
            log_path = Path(__file__).resolve().parents[2] / "logs" / "code_worker.log"
            log_path.parent.mkdir(parents=True, exist_ok=True)
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(f"[{ts}] {msg}\n")
        except Exception:
            pass

    def run(self) -> None:
        self._file_log(">>> run() entered (top of method, before try)")
        try:
            self._file_log(f"run() start; base={self.base_model_path!r}")
            self.progress.emit(f"Resolving {self.display_name}…")
            config_id = self.main_window._resolve_model_id_from_path(
                self.base_model_path, allow_create=True
            )
            self._file_log(f"resolved config_id={config_id!r}")
            self.progress.emit(f"Starting {self.display_name} (loading weights into VRAM)…")
            url = self.manager.ensure_server_running(
                config_id,
                log_callback=lambda msg: (
                    self._file_log(f"manager: {str(msg)[:140]}"),
                    self.progress.emit(str(msg)[:140]),
                )[1],
            )
            self._file_log(f"ensure_server_running returned url={url!r}")
            self.done.emit(self.display_name, url, True, "")
        except Exception as e:  # noqa: BLE001
            logger.exception("ensure_server_running failed for %s", self.display_name)
            self._file_log(f"EXCEPTION {type(e).__name__}: {e}")
            import traceback as _tb
            self._file_log(_tb.format_exc()[-800:])
            self.done.emit(self.display_name, "", False, str(e))


class _BootstrapWorker(QObject):
    progress = Signal(str)
    done = Signal(bool, str)  # ok, error_message

    def __init__(self, *, base_url: str, model_id: str) -> None:
        super().__init__()
        self.base_url = base_url
        self.model_id = model_id

    def run(self) -> None:
        try:
            self.progress.emit("Checking VSCodium bundle…")
            if not vscodium_manager.vscodium_exe().exists():
                self.progress.emit("Downloading VSCodium portable (~180 MB) — first run only…")
                vscodium_manager.ensure_vscodium_extracted(progress=self.progress.emit)
            self.progress.emit("Installing Cline extension…")
            vscodium_manager.install_cline_extension()
            self.progress.emit("Seeding settings…")
            vscodium_manager.seed_settings(
                openai_base_url=self.base_url, model_id=self.model_id
            )
            self.done.emit(True, "")
        except Exception as e:  # noqa: BLE001 — top-level worker boundary
            logger.exception("VSCodium bootstrap failed")
            self.done.emit(False, str(e))


# ---------------------------------------------------------------------------
# Code page
# ---------------------------------------------------------------------------


class CodePage(QWidget):
    """Top-level Code tab content widget."""

    def _dbg(self, msg: str) -> None:
        """Log to MainWindow's app log so the user can see what the Code tab is
        actually doing without attaching a debugger. Falls back to stdlib logger
        if the parent doesn't expose ``_log_to_app_log``."""
        try:
            mw = self._main_window()
            if mw is not None and hasattr(mw, "_log_to_app_log"):
                mw._log_to_app_log(f"[CODE] {msg}")
                return
        except Exception:
            pass
        try:
            logger.info("[CODE] %s", msg)
        except Exception:
            pass

    def __init__(
        self,
        parent: Optional[QWidget] = None,
        *,
        owllm_base_url: str = cline_proxy.PROXY_BASE_URL,
        owllm_model_id: str = "owllm-active-model",
    ) -> None:
        super().__init__(parent)
        self._dbg("__init__ start")
        self._owllm_base_url = owllm_base_url
        self._owllm_model_id = owllm_model_id
        self._settings = QSettings("LocaLLM", "OWLLM")
        last = self._settings.value("code_page/workspace", "", type=str)
        self._workspace: Path = Path(last) if last and Path(last).exists() else Path.cwd()
        self._proc: Optional[subprocess.Popen] = None
        self._embedded_container: Optional[QWidget] = None
        self._bootstrap_thread: Optional[QThread] = None

        # Stable-port proxy must be running before Cline (in the embedded
        # VSCodium) ever fires its first request. Starts on app open even
        # though Cline only fires after the user clicks "Launch / Re-embed".
        cline_proxy.ensure_started()

        # --- UI scaffolding ----------------------------------------------
        outer = QVBoxLayout(self)
        outer.setContentsMargins(8, 6, 8, 8)
        outer.setSpacing(6)

        header = QHBoxLayout()
        header.setSpacing(8)

        self.workspace_label = QLabel(f"Workspace: {self._workspace}", self)
        self.workspace_label.setStyleSheet("color: #b0b0b0;")

        self.model_combo = QComboBox(self)
        # Wide enough to show "<Pretty Model Name> — <MAKER>  -  running"
        # without the truncating ellipsis the previous 220px gave us.
        self.model_combo.setMinimumWidth(420)
        self.model_combo.setSizeAdjustPolicy(QComboBox.AdjustToContents)
        self.model_combo.setToolTip(
            "Pick which currently-loaded OWLLM model Cline should talk to. "
            "Refreshes when models start or stop in the Server tab."
        )
        self.model_combo.currentIndexChanged.connect(self._on_model_changed)

        self.launch_btn = QPushButton("Launch / Re-embed", self)
        self.launch_btn.clicked.connect(self._launch_or_relaunch)
        self.status_label = QLabel("Idle.", self)
        self.status_label.setStyleSheet("color: #888;")

        header.addWidget(self.workspace_label, 1)
        header.addWidget(QLabel("Cline →", self))
        header.addWidget(self.model_combo)
        header.addWidget(self.launch_btn)
        outer.addLayout(header)
        outer.addWidget(self.status_label)

        # Refresh the model dropdown periodically so it reflects what's
        # actually running in the Server tab right now.
        self._model_refresh_timer = QTimer(self)
        self._model_refresh_timer.setInterval(2000)
        self._model_refresh_timer.timeout.connect(self._refresh_model_list)
        self._model_refresh_timer.start()
        QTimer.singleShot(0, self._refresh_model_list)

        self.stack = QStackedWidget(self)
        self.host = QWidget(self.stack)
        self.host.setStyleSheet("background: palette(window);")
        self.host_layout = QVBoxLayout(self.host)
        self.host_layout.setContentsMargins(0, 0, 0, 0)
        self.stack.addWidget(self.host)
        outer.addWidget(self.stack, 1)

        # --- Kick the bootstrap worker -----------------------------------
        self._start_bootstrap()

    # ------------------------------------------------------------------
    # Bootstrap
    # ------------------------------------------------------------------

    def _start_bootstrap(self) -> None:
        if vscodium_manager.status().fully_ready:
            self.status_label.setText("Bundle ready. Click Launch / Re-embed.")
            self.launch_btn.setEnabled(True)
            return

        self.launch_btn.setEnabled(False)
        self.status_label.setText("Preparing bundled VSCodium…")

        thread = QThread(self)
        worker = _BootstrapWorker(
            base_url=self._owllm_base_url, model_id=self._owllm_model_id
        )
        worker.moveToThread(thread)
        thread.started.connect(worker.run)
        worker.progress.connect(self.status_label.setText)
        worker.done.connect(self._on_bootstrap_done)
        worker.done.connect(thread.quit)
        thread.finished.connect(worker.deleteLater)
        thread.finished.connect(thread.deleteLater)
        self._bootstrap_thread = thread
        thread.start()

    def _on_bootstrap_done(self, ok: bool, error_message: str) -> None:
        if ok:
            self.status_label.setText("Bundle ready. Click Launch / Re-embed.")
            self.launch_btn.setEnabled(True)
        else:
            self.status_label.setText(f"Bootstrap failed: {error_message}")
            QMessageBox.warning(
                self,
                "VSCodium bootstrap failed",
                "Could not prepare the bundled code editor.\n\n"
                f"Error: {error_message}\n\n"
                "Check your internet connection (first run downloads VSCodium "
                "from GitHub) and try again.",
            )

    # ------------------------------------------------------------------
    # Live model dropdown
    # ------------------------------------------------------------------

    def _server_manager(self):
        try:
            from core.llm_server_manager import get_global_server_manager
            return get_global_server_manager()
        except Exception:
            return None

    def _main_window(self):
        """Walk up to the MainWindow so we can use its _resolve_model_id_from_path."""
        w = self.parent()
        while w is not None and not hasattr(w, "_resolve_model_id_from_path"):
            w = w.parent()
        return w

    def _running_url_for_config_id(self, config_id: str) -> Optional[str]:
        mgr = self._server_manager()
        if mgr is None or not config_id:
            return None
        try:
            if config_id in getattr(mgr, "running_servers", {}):
                return mgr._get_server_url(config_id)
        except Exception:
            pass
        return None

    def _list_available_models(self) -> list[dict]:
        """Return one dict per onboarded/ready OWLLM model::

            {
              "display":   "<HF model id>",
              "base_path": "<absolute path to local weights>",
              "running":   True if a server for that model is in
                           ``LLMServerManager.running_servers`` right now,
              "url":       "http://127.0.0.1:<port>" if running, else None,
            }
        """
        out: list[dict] = []
        mw = self._main_window()
        mgr = self._server_manager()
        # Map running config_id -> base_model_path so we can decide whether a
        # given ready row is currently running. The server config tracks
        # base_model under config["models"][cfg_id]["base_model"].
        running_paths: dict[str, str] = {}
        if mgr is not None:
            try:
                cfg_models = mgr.config.get("models", {})
                # In-memory: this session's children
                for cfg_id in getattr(mgr, "running_servers", {}).keys():
                    bm = (cfg_models.get(cfg_id) or {}).get("base_model")
                    if bm:
                        running_paths[str(Path(bm).resolve()).lower()] = cfg_id
                # State store: servers from prior sessions still on their ports
                try:
                    for row in (mgr.state_store.list_servers(status="RUNNING") or []):
                        cfg_id = row.get("model_id")
                        if not cfg_id:
                            continue
                        bm = (cfg_models.get(cfg_id) or {}).get("base_model")
                        if bm:
                            key = str(Path(bm).resolve()).lower()
                            running_paths.setdefault(key, cfg_id)
                except Exception:
                    pass
            except Exception:
                running_paths = {}

        try:
            from core.model_onboarding import get_onboarding_service
            ready = get_onboarding_service().list_ready_models() or []
        except Exception:
            ready = []

        # Lazy import — pretty_model_name lives in core and the page
        # shouldn't pay its import cost during ``__init__``-time module load
        # if the user never opens this tab.
        try:
            from core.model_compatibility import (
                pretty_model_name as _pretty,
                split_org_and_repo as _split,
            )
        except Exception:
            _pretty = lambda s, **_: s or ""
            _split = lambda s: (None, s or "")

        def _format_display(raw: str) -> str:
            """Render '<Clean Model Name> — <MAKER>'. Maker comes from the
            HF org segment (e.g. 'unsloth', 'NVIDIA') uppercased so it reads
            as a label rather than competing visually with the model name."""
            raw = (raw or "").replace("\\", "/").strip("/")
            if "/" in raw:
                last = raw.rsplit("/", 1)[-1]
            else:
                last = raw
            org, _ = _split(raw)
            name = _pretty(last, include_org=False) or last
            if org:
                return f"{name} — {org.upper()}"
            return name

        seen_paths: set[str] = set()
        for row in ready:
            raw_id = row.get("model_id") or row.get("hf_model_id") or "(unknown)"
            display = _format_display(raw_id)
            base = row.get("base_model_path")
            if not base:
                continue
            try:
                base_norm = str(Path(base).resolve()).lower()
            except Exception:
                base_norm = str(base).lower()
            if base_norm in seen_paths:
                continue
            seen_paths.add(base_norm)

            cfg_id = running_paths.get(base_norm)
            url = None
            if cfg_id and mgr is not None:
                try:
                    url = mgr._get_server_url(cfg_id)
                except Exception:
                    url = None
            out.append(
                {
                    "display": display,
                    # Canonical HF id (e.g. "unsloth/gemma-4-E4B-it-GGUF").
                    # Kept distinct from ``display`` so downstream code that
                    # needs to identify the model to Cline / the server
                    # manager never sees the prettified label.
                    "model_id": raw_id,
                    "base_path": base,
                    "running": bool(url),
                    "url": url,
                }
            )

        out.sort(key=lambda m: (not m["running"], m["display"].lower()))
        return out

    def _current_model_id(self) -> str:
        """Return the canonical HF id for the currently-selected combo item.

        We stash this on the QComboBox item via ``setItemData(..., UserRole+1)``
        in :meth:`_refresh_model_list`. Callers that need to identify the
        model to Cline / VSCodium / the server manager MUST use this rather
        than parsing ``currentText()`` — the visible label is now a
        prettified display string and is no longer a valid HF id."""
        idx = self.model_combo.currentIndex()
        if idx < 0:
            return ""
        raw = self.model_combo.itemData(idx, Qt.UserRole + 1)
        return str(raw or "")

    def _refresh_model_list(self) -> None:
        models = self._list_available_models()
        if not getattr(self, "_logged_first_refresh", False):
            self._dbg(f"_refresh_model_list: {len(models)} model(s) discovered")
            self._logged_first_refresh = True
        prev_path = self.model_combo.currentData() if self.model_combo.count() else None

        self.model_combo.blockSignals(True)
        self.model_combo.clear()
        if not models:
            self.model_combo.addItem("(no model onboarded - download one in the Models tab)", None)
            self.model_combo.setEnabled(False)
        else:
            self.model_combo.setEnabled(True)
            for m in models:
                label = m["display"] + ("  -  running" if m["running"] else "")
                self.model_combo.addItem(label, m["base_path"])
                # Stash the canonical HF id on the item so callers can
                # recover it without parsing the visible label. Qt.UserRole
                # is reserved for ``base_path``; UserRole+1 holds model_id.
                self.model_combo.setItemData(
                    self.model_combo.count() - 1,
                    m.get("model_id") or "",
                    Qt.UserRole + 1,
                )
            if prev_path is not None:
                idx = self.model_combo.findData(prev_path)
                if idx >= 0:
                    self.model_combo.setCurrentIndex(idx)
        self.model_combo.blockSignals(False)

        # Re-apply current selection to the proxy without restarting servers
        # (so the dropdown auto-refresh doesn't trigger a model load).
        self._apply_selection_to_proxy()

    def _apply_selection_to_proxy(self) -> None:
        """Point the proxy at the currently-selected model if a server for it
        is already up; otherwise clear the upstream so 503 messages are
        correct.

        Walks both:
        * ``mgr.running_servers`` (this OWLLM session's spawned children), and
        * ``mgr.state_store.list_servers(status="RUNNING")`` (external/adopted
          servers — e.g. one started by a previous OWLLM session that's
          still alive on its bound port). Without the state_store walk the
          proxy stays at ``target_url = None`` even though the upstream is
          healthy, and Cline gets 503 "no model loaded" responses.
        """
        base_path = self.model_combo.currentData()
        if not base_path:
            cline_proxy.set_target_url(None)
            return
        mgr = self._server_manager()
        if mgr is None:
            cline_proxy.set_target_url(None)
            return
        try:
            base_norm = str(Path(base_path).resolve()).lower()
        except Exception:
            cline_proxy.set_target_url(None)
            return

        cfg_models = {}
        try:
            cfg_models = mgr.config.get("models", {}) or {}
        except Exception:
            cfg_models = {}

        # Aggregate cfg_ids from both in-memory + state_store, deduped.
        candidates: list[str] = []
        try:
            candidates.extend(list(getattr(mgr, "running_servers", {}).keys()))
        except Exception:
            pass
        try:
            for row in (mgr.state_store.list_servers(status="RUNNING") or []):
                cfg_id = row.get("model_id")
                if cfg_id and cfg_id not in candidates:
                    candidates.append(cfg_id)
        except Exception:
            pass

        for cfg_id in candidates:
            bm = (cfg_models.get(cfg_id) or {}).get("base_model")
            if not bm:
                continue
            try:
                if str(Path(bm).resolve()).lower() != base_norm:
                    continue
            except Exception:
                continue
            try:
                url = mgr._get_server_url(cfg_id)
            except Exception:
                continue
            target = url.rstrip("/")
            if not target.endswith("/v1"):
                target = f"{target}/v1"
            # Only log when the upstream actually changes — the periodic
            # 2-second refresh would otherwise flood the app log.
            if cline_proxy.get_target_url() != target:
                self._dbg(f"_apply_selection_to_proxy: target -> {target} (cfg_id={cfg_id})")
            cline_proxy.set_target_url(target)
            try:
                vscodium_manager.seed_settings(
                    openai_base_url=cline_proxy.PROXY_BASE_URL,
                    model_id=self._current_model_id() or self._owllm_model_id,
                )
            except Exception as e:  # noqa: BLE001
                logger.warning("Failed to update Cline settings: %s", e)
            return

        cline_proxy.set_target_url(None)

    def _on_model_changed(self) -> None:
        """User picked a model from the dropdown. If a server for that model
        is already running, just point the proxy. Otherwise resolve the path
        to a server-manager config id (creating it if needed) and start the
        server on a worker thread — same path Chat uses, which is what
        actually loads the weights into VRAM."""
        base_path = self.model_combo.currentData()
        self._dbg(f"_on_model_changed: base_path={base_path!r}")
        if not base_path:
            cline_proxy.set_target_url(None)
            return
        # Pretty label for status text only — strips the "  -  running"
        # suffix added in _refresh_model_list.
        display = self.model_combo.currentText().split("  -  ")[0]

        # Already running? Check both in-memory dict AND state_store
        # (state_store catches servers started by a prior OWLLM session
        # that are still bound to their port).
        try:
            base_norm = str(Path(base_path).resolve()).lower()
        except Exception:
            base_norm = base_path.lower()
        mgr = self._server_manager()
        if mgr is not None:
            try:
                cfg_models = mgr.config.get("models", {}) or {}
                candidate_ids: list[str] = list(
                    getattr(mgr, "running_servers", {}).keys()
                )
                try:
                    for row in (mgr.state_store.list_servers(status="RUNNING") or []):
                        cid = row.get("model_id")
                        if cid and cid not in candidate_ids:
                            candidate_ids.append(cid)
                except Exception:
                    pass
                for cfg_id in candidate_ids:
                    bm = (cfg_models.get(cfg_id) or {}).get("base_model")
                    if bm and str(Path(bm).resolve()).lower() == base_norm:
                        self._apply_selection_to_proxy()
                        self.status_label.setText(f"Cline -> {display} (already running).")
                        return
            except Exception:
                pass

        if mgr is None:
            self._dbg("_on_model_changed: server manager unavailable")
            self.status_label.setText("Server manager not available yet.")
            return
        mw = self._main_window()
        if mw is None:
            self._dbg("_on_model_changed: MainWindow not reachable from parent chain")
            self.status_label.setText("Cannot resolve model id (MainWindow not reachable).")
            return

        self._dbg(f"_on_model_changed: spawning _StartServerWorker for {display!r}")
        self.status_label.setText(f"Starting {display}…")
        thread = QThread(self)
        worker = _StartServerWorker(mgr, mw, display, base_path)
        worker.moveToThread(thread)
        thread.started.connect(worker.run)
        worker.progress.connect(self.status_label.setText)
        worker.done.connect(self._on_server_started)
        worker.done.connect(thread.quit)
        thread.finished.connect(worker.deleteLater)
        thread.finished.connect(thread.deleteLater)
        # Keep a strong reference to the worker too — if it gets GC'd before
        # the thread fires ``started``, the slot binding becomes invalid and
        # ``run()`` is silently dropped.
        self._start_worker = worker
        self._start_thread = thread
        thread.start()
        self._dbg(f"_on_model_changed: thread.start() called; thread.isRunning()={thread.isRunning()}")

    def _on_server_started(self, display: str, url: str, ok: bool, error_message: str) -> None:
        self._dbg(f"_on_server_started: display={display!r} ok={ok} url={url!r} err={error_message!r}")
        if not ok:
            self.status_label.setText(f"Failed to start {display}: {error_message}")
            return
        target = url.rstrip("/")
        if not target.endswith("/v1"):
            target = f"{target}/v1"
        cline_proxy.set_target_url(target)
        try:
            # ``display`` here is the pretty label from the worker — the
            # canonical HF id Cline needs lives on the combo item.
            vscodium_manager.seed_settings(
                openai_base_url=cline_proxy.PROXY_BASE_URL,
                model_id=self._current_model_id() or self._owllm_model_id,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("Failed to update Cline settings after start: %s", e)
        self.status_label.setText(f"Cline -> {display} (started, weights loaded).")

    # ------------------------------------------------------------------
    # Launch + embed
    # ------------------------------------------------------------------

    def _launch_or_relaunch(self) -> None:
        # Kill any previous bundled instance so we don't accumulate ghosts.
        if self._embedded_container is not None:
            self._embedded_container.setParent(None)
            self._embedded_container.deleteLater()
            self._embedded_container = None
        vscodium_manager.kill_all_vscodium()

        # Auto-configure Cline so its first-run wizard is skipped and the
        # OpenAI-Compatible provider is pre-pointed at the OWLLM proxy.
        # ``kill_all_vscodium`` above guarantees state.vscdb is unlocked.
        try:
            # Use the canonical HF id, NOT the prettified combo label —
            # Cline forwards this as the OpenAI ``model`` field.
            cline_model_id = self._current_model_id() or self._owllm_model_id
            vscodium_manager.patch_cline_apikey_check()
            vscodium_manager.seed_cline_globalstate(
                openai_base_url=cline_proxy.PROXY_BASE_URL,
                model_id=cline_model_id,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("Cline auto-config failed: %s", e)

        try:
            self._proc = vscodium_manager.launch(self._workspace)
        except Exception as e:  # noqa: BLE001
            self.status_label.setText(f"Launch failed: {e}")
            return

        self.status_label.setText("Launching VSCodium…")
        self._poll_for_hwnd(0)

    def _poll_for_hwnd(self, attempts: int) -> None:
        hwnd = vscodium_manager.find_vscodium_top_hwnd(self._workspace)
        if hwnd:
            self._embed_hwnd(hwnd)
            return
        if attempts > 100:  # ~20s
            self.status_label.setText("Could not find VSCodium window — see logs.")
            return
        QTimer.singleShot(200, lambda: self._poll_for_hwnd(attempts + 1))

    def _embed_hwnd(self, hwnd: int) -> None:
        try:
            foreign = QWindow.fromWinId(hwnd)
            container = QWidget.createWindowContainer(foreign, self.host)
            container.setMinimumSize(800, 500)
            container.setFocusPolicy(Qt.StrongFocus)
            self.host_layout.addWidget(container)
            self._embedded_container = container
            self._embedded_hwnd = int(hwnd)

            # Qt's foreign-HWND container does not auto-forward keyboard focus
            # to the embedded HWND on Windows. Without this, the user can see
            # VSCodium but every keystroke is swallowed by OWLLM's Qt event
            # loop. We install an event filter that hands focus over via
            # Win32 SetFocus + SetForegroundWindow whenever Qt activates the
            # container or the user clicks inside it.
            self._focus_filter = _ForwardFocusFilter(int(hwnd))
            container.installEventFilter(self._focus_filter)
            self.host.installEventFilter(self._focus_filter)
            # Kick once so the user can start typing immediately.
            QTimer.singleShot(150, self._focus_filter.force_focus)

            self.status_label.setText(
                f"VSCodium embedded (HWND {hwnd:#x}). Click inside to type."
            )
        except Exception as e:  # noqa: BLE001
            self.status_label.setText(f"Embedding failed: {e}")
            logger.exception("Embedding failed")

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def shutdown(self) -> None:
        """Called by MainWindow on close. Kills the embedded VSCodium and
        stops the Cline proxy. Also waits for any worker QThread we spawned
        (bootstrap, model-start) so Qt does not warn ``QThread: Destroyed
        while thread is still running`` on app exit — that warning is
        harmless to functionality but trips the launcher's
        non-zero-exit-code path which would falsely show the repair UI on
        the next launch."""
        try:
            self._model_refresh_timer.stop()
        except Exception:
            pass
        for attr in ("_bootstrap_thread", "_start_thread"):
            t = getattr(self, attr, None)
            if t is None:
                continue
            try:
                if t.isRunning():
                    t.quit()
                    t.wait(2000)
            except Exception:
                pass
        try:
            vscodium_manager.kill_all_vscodium()
        except Exception:
            logger.exception("Failed to terminate bundled VSCodium")
        try:
            cline_proxy.stop()
        except Exception:
            logger.exception("Failed to stop Cline proxy")

    def closeEvent(self, event) -> None:  # type: ignore[override]
        self.shutdown()
        super().closeEvent(event)


__all__ = ["CodePage"]
