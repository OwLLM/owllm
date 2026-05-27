"""
Verify that derived dependency artifacts are in sync with profiles.

Usage:
    python scripts/verify_profiles_sync.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure repository root on path
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.profile_sync import check  # noqa: E402


def main():
    ok, outdated = check()
    if ok:
        print("All generated artifacts are up to date.")
        sys.exit(0)
    else:
        print("Outdated artifacts detected:")
        for f in outdated:
            print(f" - {f}")
        sys.exit(1)


if __name__ == "__main__":
    main()
