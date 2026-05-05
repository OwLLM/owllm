"""Local backend — OWLLM's onboarded models served by the local inference stack.

Lists every model the onboarding service marks READY. If the OWLLM server
manager has a model running right now, that row is annotated "(running)" and
listed first so it's the obvious pick after the user just started Gemma 4.

Vision: when a chat history carries image attachments on user messages,
this backend talks to the running server's OpenAI-compatible
``/v1/chat/completions`` endpoint with a multipart message (image_url
parts + text part) instead of the flat-prompt ``/generate`` route.
This lets multimodal local models (Gemma 4 / Llama 3.2 Vision /
Qwen2-VL) actually see the image bytes — the bundled llama-server
proxy auto-discovers an mmproj projector when one is on disk.

For text-only conversations the legacy ``/generate`` path is kept so
non-multimodal local models behave exactly as before.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional

from core.agents.backends.base import (
    ModelEntry,
    register_backend,
    render_messages_as_prompt,
)
from core.agents.vision import encode_image_paths, extract_image_paths

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
        # Bucket rows by (base_path, adapter_dir) so that an adapter row
        # and its underlying base row don't collide — they share the
        # same base_model_path but are distinct entries the user wants
        # to pick between. Without `adapter_dir` in the key, the dedupe
        # would silently swallow every fine-tuned adapter under its base.
        by_path: Dict[tuple, List[dict]] = {}
        no_path: List[dict] = []
        for row in ready:
            base = row.get("base_model_path") or row.get("base_model") or ""
            adapter = row.get("adapter_dir") or ""
            if not base and not adapter:
                no_path.append(row)
                continue
            try:
                base_key = str(Path(base).resolve()).lower() if base else ""
            except OSError:
                base_key = base.lower()
            try:
                adapter_key = str(Path(adapter).resolve()).lower() if adapter else ""
            except OSError:
                adapter_key = adapter.lower()
            by_path.setdefault((base_key, adapter_key), []).append(row)

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

    def generate(self, messages: List[Mapping[str, Any]], model_key: str) -> str:
        # Step 1: look up the model's base_model_path (the actual weights file
        # on disk). The user-facing model_id (e.g. "unsloth/gemma-4-E4B-it-GGUF")
        # is what the picker shows, but the server manager keys running
        # servers by a config_id like "Gemma 4 E4b Instruct GGUF__gguf__...".
        # The reliable bridge between the two is base_model_path: if a
        # server is already running with the same weights file, we can use
        # it directly without any id matching.
        base_model_path = self._lookup_base_model_path(model_key)
        has_images = self._has_image_attachments(messages)

        # Decide whether this model_key represents an adapter sharing the
        # base server. The base entry sends adapter=None (LoRA OFF); an
        # adapter entry sends adapter=<model_key> (LoRA ON). Without this,
        # picking the BASE in agents would inherit whatever toggle state
        # Test Chat last left the server in.
        adapter_param = self._adapter_for_request(model_key)

        # Step 2: prefer a server that's already running with these weights.
        # Skips the entire ensure_server_running dance, which would otherwise
        # try to start a *duplicate* server because the ids don't match.
        running_url = self._url_for_running_server(base_model_path)
        if running_url:
            logger.info("local backend: reusing running server at %s", running_url)
            if has_images:
                return self._call_server_chat_completions(running_url, messages, model_key, adapter=adapter_param)
            return self._call_server(running_url, messages, adapter=adapter_param)

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
                    if has_images:
                        return self._call_server_chat_completions(server_url, messages, model_key, adapter=adapter_param)
                    return self._call_server(server_url, messages, adapter=adapter_param)
        except Exception as exc:
            raise RuntimeError(
                f"Could not start local server for {model_key!r}: {exc}\n"
                f"Open the Server tab and confirm the model's onboarding "
                f"status is READY. If it isn't, run repair from the Models tab."
            ) from exc

        # Step 4: fall back to the legacy run_inference path (which has its
        # own ensure_server_running but uses cfg.model_id alone for lookup).
        # Image attachments can't survive the flat-prompt route so we drop
        # to text-only here; the textual stub from attachments_to_prompt_block
        # at least tells the model something is there.
        from core.inference import InferenceConfig, run_inference
        cfg = InferenceConfig(
            prompt=render_messages_as_prompt(messages),
            model_id=model_key,
            base_model=base_model_path or None,
            max_new_tokens=1024,
            temperature=0.4,
        )
        return run_inference(cfg)

    # -- vision: chat-completions path ----------------------------------

    @staticmethod
    def _has_image_attachments(messages: List[Mapping[str, Any]]) -> bool:
        for m in messages:
            if not hasattr(m, "get"):
                continue
            if extract_image_paths(m):
                return True
        return False

    @staticmethod
    def _call_server_chat_completions(
        server_url: str,
        messages: List[Mapping[str, Any]],
        model_key: str,
        adapter: Optional[str] = None,
    ) -> str:
        """POST OpenAI-shape multipart messages to the running server.

        Used when ANY user message carries image attachments. The bundled
        llama-server proxy exposes /v1/chat/completions and forwards to
        the inner llama-server which natively understands the OpenAI
        ``image_url`` content-part shape (with ``data:`` URIs) when an
        mmproj projector was loaded at startup. For text-only messages
        we still fall back to the cheaper /generate route.
        """
        import requests

        clean: list[dict] = []
        for m in messages:
            role = (m.get("role") or "user").lower() if hasattr(m, "get") else "user"
            if role not in ("system", "user", "assistant"):
                continue
            content = m.get("content") or ""
            image_paths = extract_image_paths(m) if role == "user" else []
            if image_paths:
                parts: list[dict] = []
                for enc in encode_image_paths(image_paths):
                    parts.append(
                        {
                            "type": "image_url",
                            "image_url": {"url": enc.to_data_uri()},
                        }
                    )
                if content:
                    parts.append({"type": "text", "text": content})
                clean.append({"role": role, "content": parts})
            else:
                clean.append({"role": role, "content": content})
        if not clean:
            clean = [{"role": "user", "content": "(no input)"}]

        url = server_url.rstrip("/") + "/v1/chat/completions"
        payload = {
            "model": model_key,
            "messages": clean,
            "temperature": 0.4,
            "max_tokens": 1024,
            "stream": False,
        }
        # Tell the server which LoRA state to use for THIS request — None
        # = base only, str = enable that adapter. The server toggles
        # under a lock so concurrent base/adapter calls don't interleave.
        if adapter is not None:
            payload["adapter"] = adapter
        # Long timeout: vision processing on CPU/GPU adds seconds.
        resp = requests.post(url, json=payload, timeout=900)
        if resp.status_code != 200:
            raise RuntimeError(
                f"local vision call failed: HTTP {resp.status_code} {resp.text[:300]}"
            )
        data = resp.json() if resp.content else {}
        choices = data.get("choices") or []
        if not choices:
            raise RuntimeError(f"local vision call returned no choices: {data}")
        msg = choices[0].get("message") or {}
        out = msg.get("content") or ""
        return (out or "").strip()

    # -- inference helpers ----------------------------------------------

    @staticmethod
    def _adapter_for_request(model_key: str) -> Optional[str]:
        """Return the adapter id to flip ON for this request, or None.

        Reads llm_backends.yaml: an entry with ``shares_server_with``
        set is an adapter sharing its base's server, so the per-request
        LoRA toggle must be flipped ON. The base entry returns None so
        its responses stay unmodified even though the same server has
        the adapter loaded.

        Falls through to None on any lookup failure — that matches the
        old behaviour (server stays in last-set toggle state) instead
        of failing the chat outright.
        """
        try:
            from core.llm_server_manager import get_global_server_manager
            mgr = get_global_server_manager()
            if mgr is None:
                return None
            mgr._load_config()
            cfg = (mgr.config.get("models") or {}).get(model_key) if hasattr(mgr, "config") else None
            if isinstance(cfg, dict) and cfg.get("shares_server_with"):
                return str(model_key)
        except Exception:
            logger.debug("local backend: adapter lookup failed for %r", model_key, exc_info=True)
        return None

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
        """Find a RUNNING server whose effective base weights match.

        Match path: for each running server's model_id, resolve the
        candidate base path through TWO sources:

        1. ``models.model_path`` — the legacy field; works when the
           server was started directly with the base id.
        2. ``model_onboarding.base_model_path`` — the source of truth
           that captures both base AND adapter rows. An adapter row's
           ``base_model_path`` points at the SAME weights file as its
           base row, so a server registered under an adapter id still
           matches when the user picks the base in agents.

        Without (2), a Test Chat session that started the server under
        the adapter's id and a subsequent agents pick of the base would
        miss each other and try to spawn a duplicate server (port
        conflict or silent failure).

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
                # Collect every base path that resolves to this server.
                candidates: list[str] = []
                model_row = store.get_model(cfg_id) if hasattr(store, "get_model") else None
                if model_row and model_row.get("model_path"):
                    candidates.append(str(model_row["model_path"]))
                onb = store.get_onboarding(cfg_id) if hasattr(store, "get_onboarding") else None
                if onb and onb.get("base_model_path"):
                    candidates.append(str(onb["base_model_path"]))
                for cand in candidates:
                    try:
                        if str(Path(cand).resolve()).lower() == target:
                            host = row.get("host") or "127.0.0.1"
                            port = row.get("port")
                            if port:
                                return f"http://{host}:{port}"
                            break
                    except OSError:
                        continue
        except Exception:
            logger.exception("local backend: running server lookup failed")
        return ""

    @staticmethod
    def _call_server(
        server_url: str,
        messages: List[Mapping[str, str]],
        adapter: Optional[str] = None,
    ) -> str:
        """Generate via an existing server URL — no manager indirection.

        ``adapter`` is forwarded so a base-vs-adapter toggle is applied
        per request: None = base only, str = flip the named LoRA on for
        this call. Without this flag the server would stay in whatever
        toggle state Test Chat last left it in.
        """
        from core.inference_client import InferenceClient
        from core.inference import _filter_model_output
        prompt = render_messages_as_prompt(messages)
        client = InferenceClient(server_url)
        raw = client.generate(
            prompt=prompt,
            max_new_tokens=1024,
            temperature=0.4,
            adapter=adapter,
        )
        return _filter_model_output(raw)

    # -- helpers ---------------------------------------------------------

    @staticmethod
    def _list_ready_models() -> List[dict]:
        """Onboarded local models filtered for disk existence.

        The state store keeps a model's onboarding row at status=READY
        even after the user deletes the underlying weights — onboarding
        only writes the row, it never reaps it. We strip rows whose
        files are obviously gone, but the rule is per-row-type:

        - Adapter rows (``adapter_dir`` set): keep iff the adapter
          directory itself exists. The base_model_path may point at a
          base model that's been deleted, moved, or is referenced by a
          HuggingFace hub id — that's the loader's problem at run
          time, not a reason to hide the adapter from the dropdown.
        - Base-model rows (``adapter_dir`` empty): keep iff
          ``base_model_path`` exists.
        - Rows with neither a base path nor an adapter dir stay
          (defensive: API/synthetic targets and rows on flaky FSes).
        - Disk-check failures (OSError) keep the row so a transient
          I/O hiccup doesn't blank the dropdown.
        """
        try:
            from core.model_onboarding import get_onboarding_service
            ready = get_onboarding_service().list_ready_models() or []
        except Exception:
            logger.exception("local backend: list_ready_models failed")
            return []

        def _exists(p: str) -> bool:
            try:
                return bool(p) and Path(p).exists()
            except OSError:
                # Treat unreachable paths as "alive" — better a stale
                # entry than hiding a real one because the FS hiccuped.
                return True

        alive: List[dict] = []
        for row in ready:
            adapter = row.get("adapter_dir") or ""
            base = row.get("base_model_path") or row.get("base_model") or ""
            if adapter:
                # Adapter row — life depends on the adapter dir, not
                # on whether the base is still around. Keep it if the
                # adapter folder exists OR if both paths are blank
                # (defensive).
                if _exists(adapter) or (not adapter and not base):
                    alive.append(row)
                continue
            # Base-model row.
            if not base:
                alive.append(row)
                continue
            if _exists(base):
                alive.append(row)
        return alive

    @staticmethod
    def _running_base_paths() -> set[str]:
        """Resolve absolute paths of base-model files that have a server up.

        Pulls candidate paths from BOTH the models table (legacy field)
        and the model_onboarding table (which stores the true base path
        even for adapter rows). Without the onboarding fallback, a base
        row whose server was started under an adapter id would never
        get tagged ``(running)`` in the picker.
        """
        out: set[str] = set()
        try:
            from core.state_store import get_state_store
            store = get_state_store()
            for row in store.list_servers(status="RUNNING") or []:
                cfg_id = row.get("model_id")
                if not cfg_id:
                    continue
                candidates: list[str] = []
                model_row = store.get_model(cfg_id) if hasattr(store, "get_model") else None
                if model_row and model_row.get("model_path"):
                    candidates.append(str(model_row["model_path"]))
                onb = store.get_onboarding(cfg_id) if hasattr(store, "get_onboarding") else None
                if onb and onb.get("base_model_path"):
                    candidates.append(str(onb["base_model_path"]))
                for cand in candidates:
                    try:
                        out.add(str(Path(cand).resolve()).lower())
                    except OSError:
                        continue
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
