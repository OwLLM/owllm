import sys
from pathlib import Path


llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.inference import _is_action_request, _is_low_intent_message


def test_action_request_detects_read_file_tool_name():
    assert _is_action_request("Please use read_file on README.md")


def test_action_request_detects_plain_file_read_phrase():
    assert _is_action_request("Can you read the file LLM/core/inference.py?")


def test_low_intent_greeting_with_action_is_not_low_intent():
    assert not _is_low_intent_message("hey, read file LLM/core/inference.py")


def test_low_intent_greeting_only_still_low_intent():
    assert _is_low_intent_message("hey")
