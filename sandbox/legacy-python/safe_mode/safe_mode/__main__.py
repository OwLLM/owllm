"""``python -m safe_mode`` entry point.

The bundled embeddable Python doesn't put ``cwd`` on ``sys.path`` by
default, so ``-m safe_mode`` only works when the LLM directory is
explicitly reachable. The launcher arranges this two ways:
  * Sets ``PYTHONPATH`` to the LLM directory when spawning safe-mode.
  * Falls back to direct script invocation (the path to this file)
    if ``-m`` resolution fails.

This module ensures the LLM dir is on sys.path and dispatches to
:func:`safe_mode.run`. Anything that needs ``import core.install`` or
``import safe_mode.repair_window`` works after that.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Make sure the LLM dir is importable regardless of how Python was
# invoked (cwd / -m / direct path / embeddable site config).
_HERE = Path(__file__).resolve().parent  # .../LLM/safe_mode
_LLM_DIR = _HERE.parent
if str(_LLM_DIR) not in sys.path:
    sys.path.insert(0, str(_LLM_DIR))

from safe_mode import run  # noqa: E402


if __name__ == "__main__":
    sys.exit(run(_LLM_DIR))
