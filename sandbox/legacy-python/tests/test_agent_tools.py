"""Tests for the tool layer: parser, builtins, registry, approval gate."""
import sys
import threading
import time
from pathlib import Path

import pytest

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.agents.tools import (
    ApprovalDecision,
    ApprovalGate,
    ToolCall,
    ToolError,
    ToolRegistry,
    builtin_registry,
    format_for_prompt,
    parse_tool_calls,
)


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------


class TestParser:
    def test_simple_call(self):
        text = '<tool_call name="read_file"><arg name="path">/tmp/x</arg></tool_call>'
        calls = parse_tool_calls(text)
        assert len(calls) == 1
        assert calls[0].name == "read_file"
        assert calls[0].args == {"path": "/tmp/x"}

    def test_multiple_calls_in_order(self):
        text = (
            'preamble <tool_call name="a"><arg name="x">1</arg></tool_call> mid '
            '<tool_call name="b"><arg name="y">2</arg></tool_call> end'
        )
        calls = parse_tool_calls(text)
        assert [c.name for c in calls] == ["a", "b"]

    def test_multiline_arg_body(self):
        text = (
            '<tool_call name="write_file_with_diff">'
            '<arg name="path">/tmp/code.py</arg>'
            '<arg name="content">def f():\n    return 1\n</arg>'
            "</tool_call>"
        )
        calls = parse_tool_calls(text)
        assert calls[0].args["content"] == "def f():\n    return 1"

    def test_missing_name_skipped(self):
        text = '<tool_call><arg name="x">1</arg></tool_call><tool_call name="b"></tool_call>'
        calls = parse_tool_calls(text)
        assert [c.name for c in calls] == ["b"]

    def test_no_calls_returns_empty(self):
        assert parse_tool_calls("just plain text, no tools here") == []

    def test_format_for_prompt_lists_all_tools(self):
        reg = builtin_registry()
        prompt = format_for_prompt(reg)
        for name in (
            "read_file", "write_file_with_diff", "edit_file", "list_dir",
            "glob_files", "grep", "todo_write", "shell", "http_get",
            "git_status", "git_diff", "git_log", "git_blame", "git_show",
        ):
            assert name in prompt
        assert "(requires approval)" in prompt  # write_file + edit_file + shell

    def test_unknown_attr_tolerated(self):
        text = '<tool_call name="x" extra="y"><arg name="a" foo="bar">v</arg></tool_call>'
        calls = parse_tool_calls(text)
        assert calls[0].name == "x"
        assert calls[0].args == {"a": "v"}


# ---------------------------------------------------------------------------
# Builtin: read_file / list_dir / write
# ---------------------------------------------------------------------------


class TestBuiltins:
    def test_read_file_round_trip(self, tmp_path):
        f = tmp_path / "hello.txt"
        f.write_text("hi", encoding="utf-8")
        reg = builtin_registry()
        result = reg.invoke(
            ToolCall(name="read_file", args={"path": str(f)}),
            agent="t",
            goal_id="g",
        )
        assert result.ok
        # Read output now uses cat -n style (line number\tcontent).
        assert "\thi" in result.output
        assert "1\t" in result.output

    def test_read_file_missing_returns_error(self, tmp_path):
        reg = builtin_registry()
        result = reg.invoke(
            ToolCall(name="read_file", args={"path": str(tmp_path / "nope")}),
            agent="t",
            goal_id="g",
        )
        assert not result.ok
        assert "no such file" in result.output

    def test_list_dir(self, tmp_path):
        (tmp_path / "a.txt").write_text("")
        (tmp_path / "sub").mkdir()
        (tmp_path / "sub" / "b.txt").write_text("")
        reg = builtin_registry()
        result = reg.invoke(
            ToolCall(name="list_dir", args={"path": str(tmp_path), "depth": 2}),
            agent="t",
            goal_id="g",
        )
        assert result.ok
        assert "a.txt" in result.output
        assert "sub/" in result.output
        assert "b.txt" in result.output

    def test_write_blocked_without_approval(self, tmp_path):
        # Default gate timeout is 300s — set it short and reject.
        reg = builtin_registry()
        reg.gate.default_timeout_seconds = 0.1

        result = reg.invoke(
            ToolCall(
                name="write_file_with_diff",
                args={"path": str(tmp_path / "x.txt"), "content": "hello"},
            ),
            agent="t",
            goal_id="g",
        )
        assert not result.ok
        assert (tmp_path / "x.txt").exists() is False

    def test_write_proceeds_when_approved(self, tmp_path):
        reg = builtin_registry()

        def auto_approve(req):
            # Approve from a thread to mimic the UI side.
            t = threading.Thread(
                target=lambda: reg.gate.resolve(req.id, ApprovalDecision.APPROVE)
            )
            t.start()

        reg.gate.add_listener(auto_approve)

        target = tmp_path / "out.txt"
        result = reg.invoke(
            ToolCall(
                name="write_file_with_diff",
                args={"path": str(target), "content": "hi\n"},
            ),
            agent="t",
            goal_id="g",
        )
        assert result.ok, result.output
        assert target.read_text(encoding="utf-8") == "hi\n"
        assert "+hi" in result.output  # diff visible


# ---------------------------------------------------------------------------
# Registry semantics
# ---------------------------------------------------------------------------


class TestRegistry:
    def test_unknown_tool_raises(self):
        reg = builtin_registry()
        with pytest.raises(ToolError):
            reg.invoke(ToolCall(name="bogus", args={}), agent="t", goal_id="g")

    def test_for_allowlist_filters(self):
        reg = builtin_registry()
        view = reg.for_allowlist(["read_file", "list_dir"])
        assert set(view.names()) == {"read_file", "list_dir"}

    def test_allowlist_none_passes_all(self):
        reg = builtin_registry()
        view = reg.for_allowlist(None)
        assert set(view.names()) == set(reg.names())

    def test_for_allowlist_shares_gate(self):
        reg = builtin_registry()
        view = reg.for_allowlist(["write_file_with_diff"])
        assert view.gate is reg.gate

    def test_missing_required_arg_returns_error(self):
        reg = builtin_registry()
        # read_file needs 'path'
        result = reg.invoke(ToolCall(name="read_file", args={}), agent="t", goal_id="g")
        assert not result.ok
        assert "missing required arg" in result.output


# ---------------------------------------------------------------------------
# Approval gate
# ---------------------------------------------------------------------------


class TestApprovalGate:
    def test_approve_resolves_decision(self):
        gate = ApprovalGate(default_timeout_seconds=2.0)
        result_holder = {}

        def caller():
            result_holder["d"] = gate.request("a", "shell", {"cmd": "ls"}, "g")

        t = threading.Thread(target=caller)
        t.start()
        # Wait for the request to land in pending.
        for _ in range(50):
            if gate.list_pending():
                break
            time.sleep(0.01)

        pending = gate.list_pending()
        assert len(pending) == 1
        gate.resolve(pending[0].id, ApprovalDecision.APPROVE)
        t.join(timeout=2)
        assert result_holder["d"] == ApprovalDecision.APPROVE

    def test_timeout(self):
        gate = ApprovalGate(default_timeout_seconds=0.05)
        d = gate.request("a", "shell", {}, "g")
        assert d == ApprovalDecision.TIMEOUT

    def test_reject(self):
        gate = ApprovalGate(default_timeout_seconds=2.0)
        result_holder = {}

        def caller():
            result_holder["d"] = gate.request("a", "shell", {}, "g")

        t = threading.Thread(target=caller)
        t.start()
        for _ in range(50):
            if gate.list_pending():
                break
            time.sleep(0.01)
        gate.resolve(gate.list_pending()[0].id, ApprovalDecision.REJECT, "no thanks")
        t.join(timeout=2)
        assert result_holder["d"] == ApprovalDecision.REJECT


# ---------------------------------------------------------------------------
# read_file slicing
# ---------------------------------------------------------------------------


class TestReadSlicing:
    """offset/limit + cat -n line numbers + soft cap behavior."""

    def _file(self, tmp_path, n_lines):
        p = tmp_path / "lines.txt"
        p.write_text("\n".join(f"line {i}" for i in range(1, n_lines + 1)) + "\n",
                     encoding="utf-8")
        return p

    def test_default_returns_first_2000(self, tmp_path):
        p = self._file(tmp_path, 50)
        reg = builtin_registry()
        r = reg.invoke(ToolCall(name="read_file", args={"path": str(p)}),
                       agent="t", goal_id="g")
        assert r.ok
        assert "line 1" in r.output and "line 50" in r.output

    def test_offset_skips_leading_lines(self, tmp_path):
        p = self._file(tmp_path, 20)
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="read_file", args={"path": str(p), "offset": 10, "limit": 5}),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "line 11" in r.output and "line 15" in r.output
        assert "line 10" not in r.output and "line 16" not in r.output

    def test_offset_beyond_file_reports_empty_range(self, tmp_path):
        p = self._file(tmp_path, 5)
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="read_file", args={"path": str(p), "offset": 999, "limit": 10}),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "empty range" in r.output

    def test_offset_validates_int(self, tmp_path):
        p = self._file(tmp_path, 5)
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="read_file", args={"path": str(p), "offset": "abc"}),
            agent="t", goal_id="g",
        )
        assert not r.ok
        assert "offset" in r.output


# ---------------------------------------------------------------------------
# edit_file
# ---------------------------------------------------------------------------


def _auto_approve(reg):
    """Helper: install a listener that auto-approves every gate request."""
    def _on(req):
        threading.Thread(
            target=lambda: reg.gate.resolve(req.id, ApprovalDecision.APPROVE),
            daemon=True,
        ).start()
    reg.gate.add_listener(_on)


class TestEditFile:
    def _setup(self, tmp_path, body="hello world"):
        p = tmp_path / "f.txt"
        p.write_text(body, encoding="utf-8")
        reg = builtin_registry()
        _auto_approve(reg)
        # Warm the read-before-edit guard.
        reg.invoke(ToolCall(name="read_file", args={"path": str(p)}),
                   agent="t", goal_id="g")
        return reg, p

    def test_unique_match_replaces(self, tmp_path):
        reg, p = self._setup(tmp_path, "alpha beta gamma")
        r = reg.invoke(
            ToolCall(name="edit_file", args={
                "path": str(p), "old_string": "beta", "new_string": "BETA",
            }),
            agent="t", goal_id="g",
        )
        assert r.ok, r.output
        assert p.read_text(encoding="utf-8") == "alpha BETA gamma"
        assert "1 replacement" in r.output

    def test_non_unique_match_blocked(self, tmp_path):
        reg, p = self._setup(tmp_path, "x x x")
        r = reg.invoke(
            ToolCall(name="edit_file", args={
                "path": str(p), "old_string": "x", "new_string": "Y",
            }),
            agent="t", goal_id="g",
        )
        assert not r.ok
        assert "appears" in r.output and "3" in r.output
        assert p.read_text(encoding="utf-8") == "x x x"  # unchanged

    def test_replace_all_handles_multiple(self, tmp_path):
        reg, p = self._setup(tmp_path, "x x x")
        r = reg.invoke(
            ToolCall(name="edit_file", args={
                "path": str(p), "old_string": "x", "new_string": "Y",
                "replace_all": True,
            }),
            agent="t", goal_id="g",
        )
        assert r.ok, r.output
        assert p.read_text(encoding="utf-8") == "Y Y Y"

    def test_missing_string_fails(self, tmp_path):
        reg, p = self._setup(tmp_path, "hello")
        r = reg.invoke(
            ToolCall(name="edit_file", args={
                "path": str(p), "old_string": "nope", "new_string": "x",
            }),
            agent="t", goal_id="g",
        )
        assert not r.ok
        assert "not found" in r.output

    def test_identical_old_new_fails(self, tmp_path):
        reg, p = self._setup(tmp_path, "hi")
        r = reg.invoke(
            ToolCall(name="edit_file", args={
                "path": str(p), "old_string": "hi", "new_string": "hi",
            }),
            agent="t", goal_id="g",
        )
        assert not r.ok
        assert "identical" in r.output

    def test_empty_old_string_fails(self, tmp_path):
        reg, p = self._setup(tmp_path, "hi")
        r = reg.invoke(
            ToolCall(name="edit_file", args={
                "path": str(p), "old_string": "", "new_string": "y",
            }),
            agent="t", goal_id="g",
        )
        assert not r.ok

    def test_nonexistent_file_fails_with_helpful_message(self, tmp_path):
        reg = builtin_registry()
        _auto_approve(reg)
        # Mark as read so we get past the registry guard, then hit the
        # tool-level "no such file" check.
        ghost = tmp_path / "ghost.txt"
        reg.mark_read("t", "g", str(ghost.resolve()))
        r = reg.invoke(
            ToolCall(name="edit_file", args={
                "path": str(ghost), "old_string": "a", "new_string": "b",
            }),
            agent="t", goal_id="g",
        )
        assert not r.ok
        assert "write_file_with_diff" in r.output


# ---------------------------------------------------------------------------
# Read-before-edit guard
# ---------------------------------------------------------------------------


class TestReadBeforeEditGuard:
    def test_edit_without_read_blocked(self, tmp_path):
        p = tmp_path / "f.txt"
        p.write_text("hi", encoding="utf-8")
        reg = builtin_registry()
        _auto_approve(reg)
        r = reg.invoke(
            ToolCall(name="edit_file", args={
                "path": str(p), "old_string": "hi", "new_string": "bye",
            }),
            agent="t", goal_id="g",
        )
        assert not r.ok
        assert "hasn't read" in r.output
        # File untouched.
        assert p.read_text(encoding="utf-8") == "hi"

    def test_guard_scoped_per_agent(self, tmp_path):
        p = tmp_path / "f.txt"
        p.write_text("hi", encoding="utf-8")
        reg = builtin_registry()
        _auto_approve(reg)
        # Agent A reads.
        reg.invoke(ToolCall(name="read_file", args={"path": str(p)}),
                   agent="A", goal_id="g")
        # Agent B tries to edit — should be blocked.
        r = reg.invoke(
            ToolCall(name="edit_file", args={
                "path": str(p), "old_string": "hi", "new_string": "bye",
            }),
            agent="B", goal_id="g",
        )
        assert not r.ok
        assert "hasn't read" in r.output

    def test_guard_scoped_per_goal(self, tmp_path):
        p = tmp_path / "f.txt"
        p.write_text("hi", encoding="utf-8")
        reg = builtin_registry()
        _auto_approve(reg)
        reg.invoke(ToolCall(name="read_file", args={"path": str(p)}),
                   agent="A", goal_id="g1")
        # Same agent, different goal — must re-read.
        r = reg.invoke(
            ToolCall(name="edit_file", args={
                "path": str(p), "old_string": "hi", "new_string": "bye",
            }),
            agent="A", goal_id="g2",
        )
        assert not r.ok

    def test_allowlist_view_shares_read_state(self, tmp_path):
        p = tmp_path / "f.txt"
        p.write_text("hi", encoding="utf-8")
        reg = builtin_registry()
        _auto_approve(reg)
        reg.invoke(ToolCall(name="read_file", args={"path": str(p)}),
                   agent="A", goal_id="g")
        # An agent with a restricted toolset should still benefit from
        # the parent's read tracking.
        view = reg.for_allowlist(["edit_file"])
        r = view.invoke(
            ToolCall(name="edit_file", args={
                "path": str(p), "old_string": "hi", "new_string": "bye",
            }),
            agent="A", goal_id="g",
        )
        assert r.ok, r.output

    def test_forget_reads_resets(self, tmp_path):
        p = tmp_path / "f.txt"
        p.write_text("hi", encoding="utf-8")
        reg = builtin_registry()
        _auto_approve(reg)
        reg.invoke(ToolCall(name="read_file", args={"path": str(p)}),
                   agent="A", goal_id="g")
        assert reg.has_read("A", "g", str(p.resolve()))
        reg.forget_reads("A", "g")
        assert not reg.has_read("A", "g", str(p.resolve()))


# ---------------------------------------------------------------------------
# glob_files / grep
# ---------------------------------------------------------------------------


class TestGlobFiles:
    def test_finds_python_files(self, tmp_path):
        (tmp_path / "a.py").write_text("")
        (tmp_path / "b.py").write_text("")
        (tmp_path / "c.txt").write_text("")
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="glob_files", args={"pattern": "*.py", "path": str(tmp_path)}),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "a.py" in r.output and "b.py" in r.output
        assert "c.txt" not in r.output

    def test_skips_node_modules(self, tmp_path):
        (tmp_path / "node_modules").mkdir()
        (tmp_path / "node_modules" / "junk.py").write_text("")
        (tmp_path / "wanted.py").write_text("")
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="glob_files", args={"pattern": "**/*.py", "path": str(tmp_path)}),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "wanted.py" in r.output
        assert "junk.py" not in r.output

    def test_no_match_clean_message(self, tmp_path):
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="glob_files", args={"pattern": "*.xyz", "path": str(tmp_path)}),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "no files matched" in r.output

    def test_head_limit_truncates(self, tmp_path):
        for i in range(10):
            (tmp_path / f"f{i}.txt").write_text("")
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="glob_files", args={
                "pattern": "*.txt", "path": str(tmp_path), "head_limit": 3,
            }),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "truncated" in r.output

    def test_pattern_required(self, tmp_path):
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="glob_files", args={"pattern": "", "path": str(tmp_path)}),
            agent="t", goal_id="g",
        )
        assert not r.ok


class TestGrep:
    def _setup(self, tmp_path):
        (tmp_path / "a.py").write_text("def foo():\n    return 1\n", encoding="utf-8")
        (tmp_path / "b.py").write_text("def bar():\n    return 2\n", encoding="utf-8")
        (tmp_path / "c.md").write_text("foo also lives here\n", encoding="utf-8")
        return builtin_registry()

    def test_files_with_matches_default(self, tmp_path):
        reg = self._setup(tmp_path)
        r = reg.invoke(
            ToolCall(name="grep", args={"pattern": "def foo", "path": str(tmp_path)}),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "a.py" in r.output
        assert "b.py" not in r.output

    def test_glob_filter_restricts_extension(self, tmp_path):
        reg = self._setup(tmp_path)
        r = reg.invoke(
            ToolCall(name="grep", args={
                "pattern": "foo", "path": str(tmp_path), "glob": "*.py",
            }),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "a.py" in r.output
        assert "c.md" not in r.output

    def test_invalid_mode_rejected(self, tmp_path):
        reg = self._setup(tmp_path)
        r = reg.invoke(
            ToolCall(name="grep", args={
                "pattern": "foo", "path": str(tmp_path), "output_mode": "bogus",
            }),
            agent="t", goal_id="g",
        )
        assert not r.ok
        assert "output_mode" in r.output

    def test_no_match_clean_message(self, tmp_path):
        reg = self._setup(tmp_path)
        r = reg.invoke(
            ToolCall(name="grep", args={
                "pattern": "needle_in_a_haystack", "path": str(tmp_path),
            }),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "no matches" in r.output


# ---------------------------------------------------------------------------
# todo_write
# ---------------------------------------------------------------------------


class TestTodoWrite:
    def test_happy_path(self):
        import json
        reg = builtin_registry()
        todos = json.dumps([
            {"content": "A", "status": "in_progress", "activeForm": "A-ing"},
            {"content": "B", "status": "pending", "activeForm": "B-ing"},
        ])
        r = reg.invoke(
            ToolCall(name="todo_write", args={"todos": todos}),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "A" in r.output and "B" in r.output

    def test_two_in_progress_rejected(self):
        import json
        reg = builtin_registry()
        bad = json.dumps([
            {"content": "A", "status": "in_progress", "activeForm": "A"},
            {"content": "B", "status": "in_progress", "activeForm": "B"},
        ])
        r = reg.invoke(
            ToolCall(name="todo_write", args={"todos": bad}),
            agent="t", goal_id="g",
        )
        assert not r.ok
        assert "in_progress" in r.output

    def test_invalid_status_rejected(self):
        import json
        reg = builtin_registry()
        bad = json.dumps([
            {"content": "A", "status": "broken", "activeForm": "A"},
        ])
        r = reg.invoke(
            ToolCall(name="todo_write", args={"todos": bad}),
            agent="t", goal_id="g",
        )
        assert not r.ok

    def test_missing_content_rejected(self):
        import json
        reg = builtin_registry()
        bad = json.dumps([
            {"content": "", "status": "pending", "activeForm": "X"},
        ])
        r = reg.invoke(
            ToolCall(name="todo_write", args={"todos": bad}),
            agent="t", goal_id="g",
        )
        assert not r.ok

    def test_default_active_form_falls_back_to_content(self):
        import json
        from core.agents.tools import get_todos, set_todo_context
        set_todo_context("agent_a", "goal_x")
        reg = builtin_registry()
        todos = json.dumps([{"content": "Build it", "status": "pending"}])
        reg.invoke(
            ToolCall(name="todo_write", args={"todos": todos}),
            agent="agent_a", goal_id="goal_x",
        )
        stored = get_todos("agent_a", "goal_x")
        assert len(stored) == 1
        assert stored[0]["activeForm"] == "Build it"


# ---------------------------------------------------------------------------
# Reliability: telemetry, retry, crash isolation
# ---------------------------------------------------------------------------


class TestTelemetry:
    def test_records_calls_and_latency(self, tmp_path):
        p = tmp_path / "f.txt"
        p.write_text("hi", encoding="utf-8")
        reg = builtin_registry()
        for _ in range(3):
            reg.invoke(ToolCall(name="read_file", args={"path": str(p)}),
                       agent="t", goal_id="g")
        snap = reg.telemetry.snapshot()
        assert snap["read_file"]["calls"] == 3
        assert snap["read_file"]["errors"] == 0
        assert snap["read_file"]["p50"] >= 0.0

    def test_records_errors(self, tmp_path):
        reg = builtin_registry()
        reg.invoke(ToolCall(name="read_file", args={"path": str(tmp_path / "nope")}),
                   agent="t", goal_id="g")
        snap = reg.telemetry.snapshot()
        assert snap["read_file"]["errors"] == 1
        assert "no such file" in snap["read_file"]["last_error"]


class TestCrashIsolation:
    def test_unexpected_exception_returns_clean_result(self):
        from core.agents.tools.base import Tool, ArgSpec, ToolRegistry, ToolCall

        def boom(_args):
            raise RuntimeError("kaboom")

        bad = Tool(
            name="bad_tool", description="", args=[], func=boom,
            requires_approval=False,
        )
        reg = ToolRegistry()
        reg.register(bad)
        r = reg.invoke(ToolCall(name="bad_tool", args={}),
                       agent="t", goal_id="g")
        assert not r.ok
        assert "tool crashed" in r.output
        assert r.meta.get("crashed") is True
        # Telemetry recorded the crash too.
        assert reg.telemetry.snapshot()["bad_tool"]["crashes"] == 1


class TestTransientRetry:
    def test_transient_error_retried_once(self):
        from core.agents.tools.base import Tool, ArgSpec, ToolRegistry, ToolCall, ToolError

        attempts = {"n": 0}

        def flaky(_args):
            attempts["n"] += 1
            if attempts["n"] == 1:
                raise ToolError("network: connection reset by peer")
            return "ok"

        t = Tool(
            name="flaky", description="", args=[], func=flaky,
            requires_approval=False,
        )
        reg = ToolRegistry()
        reg.register(t)
        r = reg.invoke(ToolCall(name="flaky", args={}),
                       agent="a", goal_id="g")
        assert r.ok, r.output
        assert attempts["n"] == 2
        assert reg.telemetry.snapshot()["flaky"]["retries"] == 1

    def test_non_transient_error_not_retried(self):
        from core.agents.tools.base import Tool, ArgSpec, ToolRegistry, ToolCall, ToolError

        attempts = {"n": 0}

        def fail(_args):
            attempts["n"] += 1
            raise ToolError("invalid argument: foo")

        t = Tool(
            name="fail", description="", args=[], func=fail,
            requires_approval=False,
        )
        reg = ToolRegistry()
        reg.register(t)
        r = reg.invoke(ToolCall(name="fail", args={}),
                       agent="a", goal_id="g")
        assert not r.ok
        assert attempts["n"] == 1  # no retry
        assert reg.telemetry.snapshot()["fail"]["retries"] == 0

    def test_approval_gated_tool_not_retried(self, tmp_path):
        # Side-effecting tools must never auto-retry.
        from core.agents.tools.base import Tool, ArgSpec, ToolRegistry, ToolCall, ToolError

        attempts = {"n": 0}

        def flaky(_args):
            attempts["n"] += 1
            raise ToolError("connection reset")

        t = Tool(
            name="flaky_write", description="", args=[], func=flaky,
            requires_approval=True,
        )
        reg = ToolRegistry()
        reg.register(t)
        _auto_approve(reg)
        r = reg.invoke(ToolCall(name="flaky_write", args={}),
                       agent="a", goal_id="g")
        assert not r.ok
        assert attempts["n"] == 1
