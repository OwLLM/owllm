from __future__ import annotations

import sqlite3
import sys
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[2]  # .../LocaLLM
    db = root / "LLM" / "data" / "owllm_state.db"
    
    # Updated to target the correct new folder instead of the old 'zai-org__GLM-4.7'
    model_dir = root / "LLM" / "models" / "DavidAU__GLM-4.7-Flash-Uncensored-Heretic-NEO-CODE-Imatrix-MAX-GGUF"
    model_id = "DavidAU/GLM-4.7-Flash-Uncensored-Heretic-NEO-CODE-Imatrix-MAX-GGUF"

    # Ensure DB access is clean
    if not db.exists():
        raise SystemExit(f"DB not found: {db}")
    if not model_dir.exists():
        raise SystemExit(f"Model folder not found: {model_dir}")

    model_path = str(model_dir)
    # Execute cleanup
    print(f"Connecting to database: {db}...")
    try:
        # Connect but with short timeout so it dies quickly if locked
        con = sqlite3.connect(str(db), timeout=5.0)
        con.row_factory = sqlite3.Row
        cur = con.cursor()
        
        print("Executing cleanup queries...")
        # Delete any onboarding rows that point at this folder (including old/synthetic IDs).
        rows = cur.execute(
            "SELECT model_id FROM model_onboarding WHERE base_model_path = ? OR model_id LIKE ?",
            (model_path, "%GLM-4.7%"),
        ).fetchall()

        for r in rows:
            print(f"Deleting onboarding record: {r['model_id']}")
            cur.execute("DELETE FROM model_onboarding WHERE model_id = ?", (r["model_id"],))

        # Clear model env association (some UI/flows read env_key from models table).
        print("Clearing env associations...")
        cur.execute(
            "UPDATE models SET env_key = NULL WHERE model_path = ? OR model_id LIKE ?",
            (model_path, "%GLM-4.7%"),
        )

        # Clear any lingering server rows for GLM-4.7 IDs.
        print("Clearing server rows...")
        cur.execute("DELETE FROM servers WHERE model_id LIKE ?", ("%GLM-4.7%",))

        con.commit()
        con.close()
        print("Database cleanup successful.")
    except Exception as e:
        print(f"Database error (is the app running and locking the DB?): {e}")
        return 1

    # Re-run onboarding with the correct HF id.
    print("Re-running onboarding process...")
    sys.path.insert(0, str(root / "LLM"))
    from core.model_onboarding import get_onboarding_service  # noqa: E402

    svc = get_onboarding_service()
    result = svc.ensure_model_onboarded(
        model_id=model_id,
        base_model_path=model_path,
        adapter_dir=None,
        profile_data=None,
        log_callback=print,
        allow_repair=True,
    )
    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

