"""Cross-platform UI replica/comparison agent.

Architecture: a thin adapter layer per source platform (Qt, web DOM, native
UIA, Flutter driver, ...) that produces a normalized element tree, plus a
platform-agnostic core that does region-aware diffing, ranking, and report
generation. The core never knows whether it's looking at a Qt window or an
HTML page.

The contract lives in `schema.py`. Adapters live in `adapters/`. The diff
engine and orchestration live at this package's root.
"""
