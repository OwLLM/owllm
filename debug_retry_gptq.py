#!/usr/bin/env python3
"""
Run the same onboarding logic as the GUI "Retry/Isolation" button, but in-process
so we can see the full, real log output and the exact failure reason.
"""
from __future__ import annotations

import os
import sys
import traceback
from datetime import datetime
from pathlib import Path


def ts() -> str:
    return datetime.now().strftime("%H:%M:%S")


def main() -> int:
    repo_root = Path(__file__).resolve().parent
    llm_root = repo_root / "LLM"
    sys.path.insert(0, str(llm_root))

    model_dir = llm_root / "models" / "TheBloke__deepseek-coder-33B-instruct-GPTQ"
    model_id = "TheBloke/deepseek-coder-33B-instruct-GPTQ"

    print(f"[{ts()}] repo_root = {repo_root}")
    print(f"[{ts()}] model_id  = {model_id}")
    print(f"[{ts()}] model_dir = {model_dir}")
    print(f"[{ts()}] exists    = {model_dir.exists()}")
    if not model_dir.exists():
        print(f"[{ts()}] [FAIL] model_dir not found")
        return 2

    try:
        from core.model_onboarding import get_onboarding_service
    except Exception:
        print(f"[{ts()}] [FAIL] Could not import onboarding service")
        traceback.print_exc()
        return 3

    logs: list[str] = []

    def log_callback(msg: str):
        line = f"[{ts()}] {msg}"
        logs.append(line)
        print(line)

    try:
        onboarding = get_onboarding_service()
        result = onboarding.ensure_model_onboarded(
            model_id=model_id,
            base_model_path=str(model_dir),
            adapter_dir=None,
            profile_data=None,  # auto-detect
            log_callback=log_callback,
            allow_repair=True,
        )
        print(f"[{ts()}] RESULT = {result}")
        return 0 if result.get("status") == "READY" else 1
    except Exception as e:
        print(f"[{ts()}] [EXCEPTION] {e}")
        traceback.print_exc()
        return 4


if __name__ == "__main__":
    raise SystemExit(main())

