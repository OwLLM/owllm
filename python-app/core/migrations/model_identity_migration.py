"""
Model identity migration helpers.

Consolidates duplicate onboarding aliases (config-key/sanitized/HF IDs) into a
single canonical onboarding row per model fingerprint.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Any

from core.model_id_resolver import to_canonical_id
from core.state_store import get_state_store


@dataclass
class MigrationResult:
    merged_groups: int
    deleted_rows: int
    updated_rows: int
    details: List[str]


def _norm_path(path: str) -> str:
    try:
        return str(Path(path or "").resolve()).lower()
    except Exception:
        return str(path or "").lower()


def consolidate_onboarding_aliases() -> MigrationResult:
    """
    Consolidate duplicate onboarding rows by canonical model identity.

    Rules:
    - Group rows by canonical ID (derived from model_id + base_model_path).
    - Keep the best row: READY first, then most recently updated.
    - Rewrite keeper row to canonical model_id.
    - Delete non-keeper aliases in same canonical group.
    """
    store = get_state_store()
    all_rows = store.list_all_onboarding() or []
    by_canonical: Dict[str, List[Dict[str, Any]]] = {}
    for row in all_rows:
        mid = str(row.get("model_id") or "")
        base = str(row.get("base_model_path") or "")
        canonical = to_canonical_id(mid, model_cfg=None, base_model_path=base) or mid
        by_canonical.setdefault(canonical, []).append(row)

    details: List[str] = []
    merged_groups = 0
    deleted_rows = 0
    updated_rows = 0

    for canonical, rows in by_canonical.items():
        unique_ids = sorted({str(r.get("model_id") or "") for r in rows})
        if len(unique_ids) <= 1:
            # Keep canonical id normalized even for single-row groups.
            row = rows[0]
            row_id = str(row.get("model_id") or "")
            if row_id != canonical:
                store.upsert_onboarding(
                    model_id=canonical,
                    config_key=row_id,
                    model_fingerprint=_norm_path(str(row.get("base_model_path") or "")),
                    base_model_path=str(row.get("base_model_path") or ""),
                    adapter_dir=row.get("adapter_dir"),
                    env_key=row.get("env_key"),
                    backend=row.get("backend"),
                    accelerator=row.get("accelerator"),
                    status=row.get("status") or "NEW",
                    last_error=row.get("last_error"),
                    healthcheck_log_path=row.get("healthcheck_log_path"),
                )
                store.delete_onboarding(row_id)
                updated_rows += 1
                deleted_rows += 1
                details.append(f"normalized onboarding id '{row_id}' -> '{canonical}'")
            continue

        merged_groups += 1
        ranked = sorted(
            rows,
            key=lambda r: (
                0 if str(r.get("status") or "").upper() == "READY" else 1,
                str(r.get("updated_at") or ""),
            ),
            reverse=False,
        )
        keeper = ranked[0]
        keeper_id = str(keeper.get("model_id") or "")

        store.upsert_onboarding(
            model_id=canonical,
            config_key=keeper_id,
            model_fingerprint=_norm_path(str(keeper.get("base_model_path") or "")),
            base_model_path=str(keeper.get("base_model_path") or ""),
            adapter_dir=keeper.get("adapter_dir"),
            env_key=keeper.get("env_key"),
            backend=keeper.get("backend"),
            accelerator=keeper.get("accelerator"),
            status=keeper.get("status") or "NEW",
            last_error=keeper.get("last_error"),
            healthcheck_log_path=keeper.get("healthcheck_log_path"),
        )
        updated_rows += 1
        details.append(
            f"merged aliases {unique_ids} -> '{canonical}' (kept status={keeper.get('status')})"
        )

        for row in rows:
            row_id = str(row.get("model_id") or "")
            if row_id and row_id != canonical:
                store.delete_onboarding(row_id)
                deleted_rows += 1

    return MigrationResult(
        merged_groups=merged_groups,
        deleted_rows=deleted_rows,
        updated_rows=updated_rows,
        details=details,
    )

