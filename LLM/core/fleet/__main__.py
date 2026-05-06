"""Entrypoint for ``python -m core.fleet``."""
from __future__ import annotations

import sys

from core.fleet.cli import main


if __name__ == "__main__":
    sys.exit(main())
