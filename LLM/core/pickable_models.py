"""Single source of truth for 'what models can the user pick right now'.

Why this module exists:

Before this layer, every model dropdown across the app had its own
enumeration logic — a directory scan over ``models/``, a separate
``ready_paths`` derivation from the state store, plus per-tab
overlays for adapters / LoRA-GGUFs / running-server tags. That
duplication was the source of the long tail of bugs the user kept
hitting: a fix in one place left another dropdown stale, a row that
appeared in Test Chat didn't show up in Agents, a Models-page filter
also hid the entry from chat dropdowns.

This module consolidates the read path. Every UI surface that needs
to ask "what's pickable right now?" calls :func:`get_pickable_models`.
The function reads the onboarding store (which is already disk-
filtered), classifies each row into a typed :class:`PickableModel`,
dedupes against the (base_path, adapter_dir) tuple, marks running
servers, and returns a sorted list.

Per-surface formatters convert :class:`PickableModel` instances into
the payload shape each consumer expects:

  * :func:`to_combo_payload` / :func:`to_combo_label` — used by
    Test Chat / Model-to-Model / Arena / Tool Chat (the
    ``_fill_model_combo`` family in ``desktop_app/main.py``).
  * :func:`to_composite_id` — used by the Agents page's
    ``ModelPickerButton`` and ``dispatch_model_fn``.

If you're tempted to add a new dropdown that scans ``models/``
directly: don't. Call :func:`get_pickable_models` and format from
there.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple, Union
import logging

logger = logging.getLogger(__name__)


# Model "kind" constants — every PickableModel belongs to exactly one.
# We classify on read so consumers don't have to reinterpret raw
# onboarding fields. Naming mirrors the runtime backends.
KIND_TRANSFORMERS_BASE = "transformers_base"
"""HuggingFace transformers base model (config.json + safetensors / .bin)."""

KIND_GGUF_BASE = "gguf_base"
"""llama.cpp base model — a single ``.gguf`` file or a directory of them."""

KIND_PEFT_ADAPTER = "peft_adapter"
"""PEFT/LoRA adapter that runs on the transformers backend (no GGUF)."""

KIND_LORA_GGUF = "lora_gguf"
"""LoRA converted to GGUF format. Served alongside a base GGUF via ``--lora``."""


@dataclass
class PickableModel:
    """One pickable entry in the unified model list.

    Attributes:
        model_id: Canonical identifier used by run_inference,
            dispatch_model_fn, the server manager, etc.
        display_name: Short human-readable label (no kind suffix —
            formatters add that).
        kind: One of the ``KIND_*`` constants.
        base_path: The on-disk weights path. For GGUF bases this is
            the ``.gguf`` file (or a directory containing one). For
            transformers bases this is the HF model directory. For
            adapter rows this is the underlying base model.
        adapter_dir: Path to the adapter weights, set only for
            ``peft_adapter`` and ``lora_gguf`` kinds.
        is_running: Whether a server is currently running for this
            model (or a model that shares its base).
        note: Optional short tag (e.g. "running") that formatters
            may append after the display name.
    """

    model_id: str
    display_name: str
    kind: str
    base_path: Path
    adapter_dir: Optional[Path] = None
    is_running: bool = False
    note: str = ""

    @property
    def is_adapter(self) -> bool:
        return self.kind in (KIND_PEFT_ADAPTER, KIND_LORA_GGUF)

    @property
    def is_gguf(self) -> bool:
        return self.kind in (KIND_GGUF_BASE, KIND_LORA_GGUF)


# ---------------------------------------------------------------------------
# Public read API
# ---------------------------------------------------------------------------


def get_pickable_models() -> List[PickableModel]:
    """Return every model the user can pick right now.

    Reads from :func:`core.model_onboarding.list_ready_models` (which
    is itself already filtered for disk existence — no zombie rows
    for deleted weights). Classifies each row, dedupes against the
    (base_path, adapter_dir) tuple, marks running servers, and sorts
    so the most relevant entries come first (running, then adapters,
    then alphabetical).

    Returns an empty list on any read failure — never raises. UI
    surfaces should treat an empty result as 'no models available
    yet, prompt the user to download / onboard one'.
    """
    try:
        from core.model_onboarding import get_onboarding_service
        ready = get_onboarding_service().list_ready_models() or []
    except Exception:
        logger.exception("get_pickable_models: list_ready_models failed")
        return []

    running_paths = _running_paths()

    # Bucket rows by (base_path, adapter_dir) tuple. Adapter rows have
    # the same base_path as their base row, but a non-empty adapter_dir
    # — using the tuple as key keeps them in distinct buckets so both
    # survive dedupe. Without this, adapters silently collapsed into
    # the base entry (every previous fix in this area was about exactly
    # this collision).
    by_key: Dict[Tuple[str, str], List[dict]] = {}
    for row in ready:
        rid = str(row.get("model_id") or "")
        if not rid:
            continue
        base = row.get("base_model_path") or row.get("base_model") or ""
        adapter = row.get("adapter_dir") or ""
        base_norm = _normalize_path(base)
        adapter_norm = _normalize_path(adapter)
        by_key.setdefault((base_norm, adapter_norm), []).append(row)

    out: List[PickableModel] = []
    for key, rows in by_key.items():
        rows.sort(key=lambda r: _rank(r, running_paths))
        winner = rows[0]
        model = _classify(winner, running_paths)
        if model is not None:
            out.append(model)

    # When a fine-tune exists in BOTH transformers PEFT form (slow) AND
    # LoRA-GGUF form (fast, works on llama-server), hide the
    # transformers entry so the user has exactly one button per
    # fine-tune. Picking the slow path while a fast equivalent exists
    # is never the right answer; double entries also surface a
    # transformers integrity check that fails on PEFT-only dirs.
    lora_stems = {
        m.model_id[: -len("__lora_gguf")].lower()
        for m in out
        if m.kind == KIND_LORA_GGUF and m.model_id.lower().endswith("__lora_gguf")
    }
    if lora_stems:
        out = [
            m for m in out
            if not (m.kind == KIND_PEFT_ADAPTER and m.model_id.lower() in lora_stems)
        ]

    out.sort(key=_sort_key)
    return out


def get_pickable_for_local_chat() -> List[PickableModel]:
    """Subset of get_pickable_models() that the local chat surfaces show.

    Drops API-only / synthetic rows (no on-disk path) and rows whose
    backend isn't suitable for direct local serving. Used by Test
    Chat / Model-to-Model / Arena / Tool Chat / Agents.
    """
    out: List[PickableModel] = []
    for m in get_pickable_models():
        # Adapter rows always come through — they reference an on-disk
        # adapter_dir even if base_path normalisation looks empty.
        if m.is_adapter and m.adapter_dir is not None:
            out.append(m)
            continue
        if m.base_path and str(m.base_path):
            out.append(m)
    return out


# ---------------------------------------------------------------------------
# Formatters — keep one per UI surface so consumers don't reinvent payloads
# ---------------------------------------------------------------------------


def to_combo_payload(m: PickableModel) -> Union[Dict, str]:
    """Payload for ``QComboBox.addItem(label, payload)`` in chat tabs.

    Mirrors the legacy shape that ``_resolve_chat_model_id_from_path``
    and friends consume:

      * For sharded GGUF / LoRA-GGUF — a dict with
        ``{"base_path": <dir>, "variant_relpath": <file>, "model_id": ...}``
      * For everything else — a path string.
    """
    if m.kind == KIND_LORA_GGUF and m.adapter_dir is not None:
        ggufs = sorted(m.adapter_dir.glob("*-lora-*.gguf")) or sorted(m.adapter_dir.glob("*.gguf"))
        if ggufs:
            return {
                "base_path": str(m.adapter_dir),
                "variant_relpath": ggufs[0].name,
                "model_id": m.model_id,
            }
        return str(m.adapter_dir)
    if m.kind == KIND_PEFT_ADAPTER and m.adapter_dir is not None:
        return str(m.adapter_dir)
    if m.kind == KIND_GGUF_BASE:
        if m.base_path.suffix.lower() == ".gguf":
            return {
                "base_path": str(m.base_path.parent),
                "variant_relpath": m.base_path.name,
                "model_id": m.model_id,
            }
        # Multi-variant directory — caller may want to expand to one
        # entry per variant; return the dir and let it pick.
        return str(m.base_path)
    return str(m.base_path)


def to_combo_label(m: PickableModel) -> str:
    """Combo label for chat tab consumers."""
    suffix = "  (running)" if m.is_running else ""
    if m.kind == KIND_LORA_GGUF:
        return f"🎯 {m.display_name} (LoRA-GGUF){suffix}"
    if m.kind == KIND_PEFT_ADAPTER:
        return f"🎯 {m.display_name} (adapter){suffix}"
    return f"✓ 📦 {m.display_name}{suffix}"


def to_composite_id(m: PickableModel, backend_name: str = "local") -> str:
    """Composite id used by the Agents page (``backend|model_key``)."""
    return f"{backend_name}|{m.model_id}"


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _normalize_path(p: str) -> str:
    """Lowercased, OS-resolved path for dict-key comparisons."""
    if not p:
        return ""
    try:
        return str(Path(p).resolve()).lower()
    except OSError:
        return p.lower()


def _running_paths() -> Set[str]:
    """Resolve absolute paths of base models with an active server.

    Pulls from BOTH the ``models`` table (legacy) and the
    ``model_onboarding`` table (so a server registered under an
    adapter id still surfaces its base's path here).
    """
    out: Set[str] = set()
    try:
        from core.state_store import get_state_store
        store = get_state_store()
        for row in store.list_servers(status="RUNNING") or []:
            cfg_id = row.get("model_id")
            if not cfg_id:
                continue
            model_row = store.get_model(cfg_id) if hasattr(store, "get_model") else None
            if model_row and model_row.get("model_path"):
                key = _normalize_path(str(model_row["model_path"]))
                if key:
                    out.add(key)
            onb = store.get_onboarding(cfg_id) if hasattr(store, "get_onboarding") else None
            if onb and onb.get("base_model_path"):
                key = _normalize_path(str(onb["base_model_path"]))
                if key:
                    out.add(key)
    except Exception:
        logger.debug("running-paths lookup failed", exc_info=True)
    return out


def _rank(row: dict, running_paths: Set[str]) -> Tuple[int, int, int]:
    """Sort key for picking a winner inside a (base, adapter) bucket."""
    base = row.get("base_model_path") or ""
    bp = _normalize_path(base)
    is_running = bp in running_paths
    rid = row.get("model_id") or ""
    cid = row.get("canonical_id") or ""
    is_canonical = bool(rid) and rid == cid
    has_adapter = bool(row.get("adapter_dir"))
    return (
        0 if is_running else 1,
        0 if is_canonical else 1,
        0 if has_adapter else 1,
    )


def _classify(row: dict, running_paths: Set[str]) -> Optional[PickableModel]:
    rid = str(row.get("model_id") or "")
    if not rid:
        return None
    base = row.get("base_model_path") or row.get("base_model") or ""
    adapter = row.get("adapter_dir") or ""
    base_path = Path(base) if base else Path("")
    adapter_path = Path(adapter) if adapter else None

    # Kind classification.
    has_adapter = bool(adapter)
    base_is_gguf_file = base_path.suffix.lower() == ".gguf"
    base_is_gguf_dir = False
    try:
        if base_path.is_dir():
            base_is_gguf_dir = any(base_path.glob("*.gguf"))
    except OSError:
        base_is_gguf_dir = False

    if has_adapter and base_is_gguf_file:
        kind = KIND_LORA_GGUF
    elif has_adapter and "__lora_gguf" in rid.lower():
        kind = KIND_LORA_GGUF
    elif has_adapter:
        kind = KIND_PEFT_ADAPTER
    elif base_is_gguf_file or base_is_gguf_dir:
        kind = KIND_GGUF_BASE
    else:
        kind = KIND_TRANSFORMERS_BASE

    # Running detection.
    is_running = False
    if base_path and str(base_path):
        bn = _normalize_path(str(base_path))
        if bn and bn in running_paths:
            is_running = True

    return PickableModel(
        model_id=rid,
        display_name=_pretty(rid),
        kind=kind,
        base_path=base_path,
        adapter_dir=adapter_path,
        is_running=is_running,
        note="running" if is_running else "",
    )


def _pretty(model_id: str) -> str:
    """Short display name for a model_id.

    Strips the ``tuned__`` prefix and ``__lora_gguf`` suffix that
    onboarding rows carry but users don't want to see.
    """
    s = model_id
    if s.startswith("tuned__"):
        s = s[len("tuned__"):]
    if s.endswith("__lora_gguf"):
        s = s[: -len("__lora_gguf")]
    return s


def _sort_key(m: PickableModel) -> Tuple[int, int, str]:
    """Running first, then adapters, then alphabetical."""
    return (
        0 if m.is_running else 1,
        0 if m.is_adapter else 1,
        m.display_name.lower(),
    )
