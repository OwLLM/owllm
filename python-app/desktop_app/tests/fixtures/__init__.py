"""Real, importable widget classes used by tests.

`ui_render_widget` / `ui_diff_baseline` / `ui_inspect_widget` resolve
their `target` arg through `importlib.import_module`, so the test
suite needs widget classes that live in a real importable module —
not just inline `class _Foo(QWidget): ...` definitions, which can't
be addressed by dotted path.

Keep this package small. It's not a place to dump test helpers; it's
a place for real-but-trivial widget classes the agent-tools tests
can point at.
"""
