"""Pluggable model backends for the agent runtime.

Five built-in routes:

* local        — OWLLM's local inference server (any onboarded model).
* claude_cli   — Anthropic Claude Code CLI ('claude -p ...'); uses the user's
                 logged-in claude.ai subscription. NO API key needed.
* codex_cli    — OpenAI Codex CLI ('codex exec ...'); uses the user's logged-in
                 ChatGPT subscription. NO API key needed.
* claude_api   — Anthropic API via the official SDK; requires ANTHROPIC_API_KEY.
* openai_api   — OpenAI API via the official SDK; requires OPENAI_API_KEY.

Each backend exposes ``list_entries()`` (what shows up in the agent dropdowns)
and ``generate(messages, model_key)`` (the actual call). ``dispatch_model_fn``
is a single ``ModelFn`` shaped string → string that routes by composite id of
the form ``backend|model_key`` so the Agent loop stays backend-agnostic.
"""
from core.agents.backends.base import (
    AUTO_STRATEGIES,
    ModelEntry,
    TestResult,
    compose_id,
    dispatch_model_fn,
    list_all_entries,
    parse_id,
    quick_test,
    register_backend,
    registered_backends,
)

# Importing the concrete backends here registers them with the dispatcher.
# Order matters only for the dropdown listing (auto first so the cost-aware
# router shows up at the top of the picker as a "smart default").
from core.agents.backends.base import _AutoBackend, register_backend as _reg
_reg(_AutoBackend())
from core.agents.backends import local        # noqa: F401  -- side-effect: register
from core.agents.backends import claude_cli   # noqa: F401
from core.agents.backends import codex_cli    # noqa: F401
from core.agents.backends import claude_api   # noqa: F401
from core.agents.backends import openai_api   # noqa: F401

__all__ = [
    "AUTO_STRATEGIES",
    "ModelEntry",
    "TestResult",
    "compose_id",
    "parse_id",
    "dispatch_model_fn",
    "list_all_entries",
    "quick_test",
    "register_backend",
    "registered_backends",
]
