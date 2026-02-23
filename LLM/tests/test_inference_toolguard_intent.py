import sys
import json
from pathlib import Path


llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.inference import (
    _is_action_request,
    _is_low_intent_message,
    clean_display_answer,
    _is_unusable_final_answer,
    _derive_answer_from_tool_log,
    ToolEnabledInferenceConfig,
    run_inference_with_tools,
)


def test_action_request_detects_read_file_tool_name():
    assert _is_action_request("Please use read_file on README.md")


def test_action_request_detects_plain_file_read_phrase():
    assert _is_action_request("Can you read the file LLM/core/inference.py?")


def test_low_intent_greeting_with_action_is_not_low_intent():
    assert not _is_low_intent_message("hey, read file LLM/core/inference.py")


def test_low_intent_greeting_only_still_low_intent():
    assert _is_low_intent_message("hey")


def test_clean_display_answer_removes_tool_transcript_noise():
    raw = """
"🔧 Calling read_file

{
  "path": "LLM/core/inference.py"
}"
"✗ Tool Result (Error)

{
  "tool": "read_file",
  "result": {"content": "from __future__ import annotations"}
}"

Here are the first lines:
from __future__ import annotations
from dataclasses import dataclass
"""
    cleaned = clean_display_answer(raw)
    assert "Calling read_file" not in cleaned
    assert "Tool Result (Error)" not in cleaned
    assert "from __future__ import annotations" in cleaned


def test_clean_display_answer_against_regression_fixture():
    fixture = Path(__file__).parent / "fixtures" / "runtime_regression_prompts.json"
    data = json.loads(fixture.read_text(encoding="utf-8"))
    blocked = data["tool_read_file_first_lines"]["must_not_appear_in_clean_output"]
    raw = """
"🔧 Calling read_file

{
  "path": "LLM/core/inference.py"
}"
"✗ Tool Result (Error)

{
  "tool": "read_file"
}"

Here are the first lines:
from __future__ import annotations
"""
    cleaned = clean_display_answer(raw)
    for marker in blocked:
        assert marker not in cleaned
    assert "from __future__ import annotations" in cleaned


def test_clean_display_answer_removes_malformed_tool_call_tags():
    raw = """
```<tool_call>read_file(path="Dios.txt")</
tool_call>```
"""
    cleaned = clean_display_answer(raw)
    assert "tool_call" not in cleaned.lower()


def test_unusable_answer_detection_for_refusal_and_blank():
    assert _is_unusable_final_answer("I'm sorry, but I can't assist with that.")
    assert _is_unusable_final_answer("\n\n\r\n\t")
    assert not _is_unusable_final_answer("Here are the first lines:\nfrom __future__ import annotations")


def test_deterministic_fallback_from_read_file_tool_log():
    tool_log = [
        {
            "tool": "read_file",
            "status": "success",
            "args": {"path": "LLM/core/inference.py"},
            "result": {
                "content": "from __future__ import annotations\nfrom dataclasses import dataclass\nfrom pathlib import Path\n"
            },
        }
    ]
    out = _derive_answer_from_tool_log(tool_log, "show first lines")
    assert "Here are the first lines" in out
    assert "from __future__ import annotations" in out


def test_action_prompt_uses_model_loop_before_tool_execution(monkeypatch):
    class _NativeExecutorStub:
        def __init__(self):
            self.calls = 0

        def execute(self, tool_call):
            self.calls += 1
            raise AssertionError("Executor should not run when model emits no tool calls")

    model_calls = {"count": 0}

    def _fake_run_inference(cfg, env=None, log_callback=None):
        model_calls["count"] += 1
        return "Final answer with no tool call."

    monkeypatch.setattr("core.inference.run_inference", _fake_run_inference)

    executor = _NativeExecutorStub()
    cfg = ToolEnabledInferenceConfig(
        prompt="use read_file on LLM/core/inference.py and show first lines",
        model_id="dummy",
        enable_tools=True,
        native_executor=executor,
        max_tool_iterations=1,
    )
    output, tool_log = run_inference_with_tools(cfg=cfg, tool_callback=None, approval_callback=None, log_callback=None)
    assert model_calls["count"] == 1
    assert executor.calls == 0
    assert tool_log == []
    assert "Final answer with no tool call." in output


def test_post_tool_fallback_is_bounded_and_uses_tool_log(monkeypatch):
    class _NativeExecutorStub:
        def execute(self, tool_call):
            return type(
                "Result",
                (),
                {
                    "success": True,
                    "result": {
                        "content": (
                            "from __future__ import annotations\n"
                            "from dataclasses import dataclass\n"
                        )
                    },
                    "error": None,
                },
            )()

    calls = {"count": 0}

    def _fake_run_inference(cfg, env=None, log_callback=None):
        calls["count"] += 1
        if calls["count"] == 1:
            return '<tool_call>read_file(path="LLM/core/inference.py")</tool_call>'
        if calls["count"] == 2:
            return "I'm sorry, but I can't assist with that."
        # Finalization pass intentionally unusable -> deterministic tool-log fallback
        return "\n\n\r\n\t"

    monkeypatch.setattr("core.inference.run_inference", _fake_run_inference)

    cfg = ToolEnabledInferenceConfig(
        prompt="use read_file on LLM/core/inference.py and show first lines",
        model_id="dummy",
        enable_tools=True,
        native_executor=_NativeExecutorStub(),
        max_tool_iterations=3,
    )
    output, tool_log = run_inference_with_tools(cfg=cfg, tool_callback=None, approval_callback=None, log_callback=None)

    assert calls["count"] == 3  # model loop + one bounded finalization pass
    assert any((e or {}).get("status") == "success" for e in tool_log)
    assert "Here are the first lines" in output
    assert "from __future__ import annotations" in output
