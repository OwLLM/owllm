"""Local backend — OWLLM's onboarded models served by the local inference stack.

Lists every model the onboarding service marks READY. If the OWLLM server
manager has a model running right now, that row is annotated "(running)" and
listed first so it's the obvious pick after the user just started Gemma 4.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Dict, List, Mapping

from core.agents.backends.base import (
    ModelEntry,
    register_backend,
    render_messages_as_prompt,
)

logger = logging.getLogger(__name__)


class LocalBackend:
    name = "local"

    # -- listing ---------------------------------------------------------

    def list_entries(self) -> List[ModelEntry]:
        ready = self._list_ready_models()
        running_paths = self._running_base_paths()

        # Dedupe by resolved base_model_path: when a model has been
        # onboarded under two different model_id strings (e.g. once via
        # the user-typed slug and once via the canonical id, or once
        # per repo variant) the underlying .gguf on disk is the same
        # file. Showing both rows in the dropdown lets the user pick a
        # "wrong" one that nonetheless serves the same weights — that's
        # the GLM-4.7 "two entries, only one active" symptom.
        # Strategy: bucket rows by absolute lower-cased path; within
        # each bucket pick a single representative, preferring (in
        # order): the row that's currently RUNNING, then the row whose
        # model_id equals canonical_id (the authoritative name), then
        # the first row inserted. Rows without a base_model_path stay
        # as their own entries — we can't dedupe what we can't compare.
        by_path: Dict[str, List[dict]] = {}
        no_path: List[dict] = []
        for row in ready:
            base = row.get("base_model_path") or row.get("base_model") or ""
            if not base:
                no_path.append(row)
                continue
            try:
                key = str(Path(base).resolve()).lower()
            except OSError:
                key = base.lower()
            by_path.setdefault(key, []).append(row)

        def _rank(row: dict) -> tuple:
            base = row.get("base_model_path") or row.get("base_model") or ""
            try:
                key = str(Path(base).resolve()).lower()
            except OSError:
                key = base.lower()
            is_running = key in running_paths
            mid = row.get("model_id") or ""
            cid = row.get("canonical_id") or ""
            is_canonical = bool(mid) and mid == cid
            # Lower tuple sorts first.
            return (0 if is_running else 1, 0 if is_canonical else 1)

        chosen_rows: List[dict] = []
        for path_key, rows in by_path.items():
            rows.sort(key=_rank)
            chosen_rows.append(rows[0])
        chosen_rows.extend(no_path)

        entries: List[ModelEntry] = []
        for row in chosen_rows:
            model_id = row.get("model_id") or row.get("canonical_id") or ""
            base = row.get("base_model_path") or row.get("base_model") or ""
            if not model_id:
                continue
            display = self._pretty(model_id)
            note = ""
            if base and str(Path(base).resolve()).lower() in running_paths:
                note = "(running)"
            entries.append(
                ModelEntry(
                    backend=self.name,
                    model_key=model_id,
                    display=f"{display}  {note}".strip(),
                    available=True,
                    note=note,
                    cost_tier="free",  # local inference has no per-token cost
                )
            )

        # Hoist running rows to the top — that's the model the user just
        # started, and almost certainly the one they want pinned.
        entries.sort(key=lambda e: (0 if "(running)" in e.note else 1, e.display.lower()))
        return entries

    # -- inference -------------------------------------------------------

    def generate(self, messages: List[Mapping[str, str]], model_key: str) -> str:
        # Step 1: look up the model's base_model_path (the actual weights file
        # on disk). The user-facing model_id (e.g. "unsloth/gemma-4-E4B-it-GGUF")
        # is what the picker shows, but the server manager keys running
        # servers by a config_id like "Gemma 4 E4b Instruct GGUF__gguf__...".
        # The reliable bridge between the two is base_model_path: if a
        # server is already running with the same weights file, we can use
        # it directly without any id matching.
        base_model_path = self._lookup_base_model_path(model_key)

        # Step 2: prefer a server that's already running with these weights.
        # Skips the entire ensure_server_running dance, which would otherwise
        # try to start a *duplicate* server because the ids don't match.
        running_url = self._url_for_running_server(base_model_path)
        if running_url:
            logger.info("local backend: reusing running server at %s", running_url)
            return self._call_server(running_url, messages)

        # Step 3: nothing running yet — auto-start. We pass runtime_base_model
        # so the manager knows exactly which weights to load, avoiding the
        # id mismatch.
        try:
            from core.llm_server_manager import get_global_server_manager
            manager = get_global_server_manager()
            if manager is not None:
                logger.info(
                    "local backend: starting server for %s (base=%s)",
                    model_key, base_model_path,
                )
                server_url = manager.ensure_server_running(
                    model_key,
                    log_callback=lambda line: logger.info("[server warmup] %s", line),
                    runtime_base_model=base_model_path or None,
                )
                if server_url:
                    return self._call_server(server_url, messages)
        except Exception as exc:
            raise RuntimeError(
                f"Could not start local server for {model_key!r}: {exc}\n"
                f"Open the Server tab and confirm the model's onboarding "
                f"status is READY. If it isn't, run repair from the Models tab."
            ) from exc

        # Step 4: fall back to the legacy run_inference path (which has its
        # own ensure_server_running but uses cfg.model_id alone for lookup).
        from core.inference import InferenceConfig, run_inference
        cfg = InferenceConfig(
            prompt=render_messages_as_prompt(messages),
            model_id=model_key,
            base_model=base_model_path or None,
            max_new_tokens=1024,
            temperature=0.4,
        )
        return run_inference(cfg)

    # -- inference helpers ----------------------------------------------

    @staticmethod
    def _lookup_base_model_path(model_key: str) -> str:
        """Resolve a user-facing model_id to its on-disk weights path.

        Reads the onboarding store — the same source ``list_entries`` uses
        to populate the dropdown — so the path matches what the user
        picked.
        """
        try:
            from core.state_store import get_state_store
            entry = get_state_store().get_onboarding(model_key) or {}
            return str(entry.get("base_model_path") or "").strip()
        except Exception:
            logger.exception("local backend: base_model_path lookup failed")
            return ""

    @staticmethod
    def _url_for_running_server(base_model_path: str) -> str:
        """Find a RUNNING server whose model_path equals ``base_model_path``.

        Returns the ``http://host:port`` URL or empty string if no match.
        Match is case-insensitive on Windows-resolved absolute paths.
        """
        if not base_model_path:
            return ""
        try:
            target = str(Path(base_model_path).resolve()).lower()
            from core.state_store import get_state_store
            store = get_state_store()
            for row in store.list_servers(status="RUNNING") or []:
                cfg_id = row.get("model_id")
                if not cfg_id:
                    continue
                model_row = store.get_model(cfg_id) if hasattr(store, "get_model") else None
                if not model_row:
                    continue
                running_path = str(model_row.get("model_path") or "")
                if not running_path:
                    continue
                if str(Path(running_path).resolve()).lower() == target:
                    host = row.get("host") or "127.0.0.1"
                    port = row.get("port")
                    if port:
                        return f"http://{host}:{port}"
        except Exception:
            logger.exception("local backend: running server lookup failed")
        return ""

    @staticmethod
    def _call_server(server_url: str, messages: List[Mapping[str, str]]) -> str:
        """Generate via an existing server URL — no manager indirection."""
        from core.inference_client import InferenceClient
        prompt = render_messages_as_prompt(messages)
        client = InferenceClient(server_url)
        return client.generate(
            prompt=prompt,
            max_new_tokens=1024,
            temperature=0.4,
        )

    # -- helpers ---------------------------------------------------------

    @staticmethod
    def _list_ready_models() -> List[dict]:
        try:
            from core.model_onboarding import get_onboarding_service
            return get_onboarding_service().list_ready_models() or []
        except Exception:
            logger.exception("local backend: list_ready_models failed")
            return []

    @staticmethod
    def _running_base_paths() -> set[str]:
        """Resolve absolute paths of base-model files that have a server up."""
        out: set[str] = set()
        try:
            from core.state_store import get_state_store
            store = get_state_store()
            for row in store.list_servers(status="RUNNING") or []:
                cfg_id = row.get("model_id")
                if not cfg_id:
                    continue
                model_row = store.get_model(cfg_id) if hasattr(store, "get_model") else None
                if not model_row:
                    continue
                base = model_row.get("model_path")
                if base:
                    out.add(str(Path(base).resolve()).lower())
        except Exception:
            # Server manager state is best-effort context for the dropdown
            # — never block listing if the lookup hiccups.
            logger.debug("local backend: running-server lookup failed", exc_info=True)
        return out

    @staticmethod
    def _pretty(model_id: str) -> str:
        try:
            from core.models import pretty_model_name
            return pretty_model_name(model_id)
        except Exception:
            return model_id


register_backend(LocalBackend())
