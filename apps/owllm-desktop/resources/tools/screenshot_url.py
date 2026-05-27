"""Thin CLI wrapper around TwinForge's web_adapter.capture().

Used by the brainstormer agent in OwLLM Desktop to snap competitor
landing pages without the agent shelling raw `python -c "..."`. Args:

  --url      <https://...>          required
  --out-png  <path.png>             required
  --out-tree <path.json>            optional (defaults to <out-png>.tree.json)
  --width    <px>                   default 1700
  --height   <px>                   default 1100

Resolves the legacy LLM tree on sys.path the same way twinforge_loop.py
does so `from core.twinforge ...` imports work without an editable
install. Exit code 0 on success, 1 on failure with stderr explaining.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

_LLM_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_LLM_ROOT))

from core.twinforge.adapters.web_adapter import capture  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--out-png", required=True)
    ap.add_argument("--out-tree", default=None)
    ap.add_argument("--width", type=int, default=1700)
    ap.add_argument("--height", type=int, default=1100)
    args = ap.parse_args()

    out_tree = args.out_tree or (args.out_png + ".tree.json")
    try:
        capture(args.url, args.out_png, out_tree, width=args.width, height=args.height)
    except Exception as e:
        print(f"screenshot failed: {e}", file=sys.stderr)
        return 1
    print(args.out_png)
    return 0


if __name__ == "__main__":
    sys.exit(main())
