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
    _extract_direct_read_file_path,
    _extract_direct_list_dir_path,
    _extract_direct_search_in_file_intent,
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


def test_extract_direct_read_file_path_from_user_text():
    assert _extract_direct_read_file_path("hey, use read_file on LLM/core/inference.py and show first lines") == "LLM/core/inference.py"
    assert _extract_direct_read_file_path("please read the file README.md") == "README.md"


def test_extract_direct_list_dir_path_from_user_text():
    assert _extract_direct_list_dir_path("list files in LLM/core") == "LLM/core"
    assert _extract_direct_list_dir_path("show directories") == "."


def test_extract_direct_search_intent_from_user_text():
    assert _extract_direct_search_in_file_intent("search for _ACTION_KEYWORDS in LLM/core/inference.py") == (
        "LLM/core/inference.py",
        "_ACTION_KEYWORDS",
    )
    assert _extract_direct_search_in_file_intent('find for "run_inference" in LLM/core/inference.py') == (
        "LLM/core/inference.py",
        "run_inference",
    )
