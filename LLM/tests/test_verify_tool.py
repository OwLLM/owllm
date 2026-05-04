"""Tests for the verify tool + auto-verify hook in ToolRegistry.

Two surfaces under test:

* ``find_verify_config`` / ``run_verify`` — pure helpers, exercised
  with config files dropped into ``tmp_path``.
* The ``ToolRegistry`` post-edit hook that auto-runs verify after
  ``edit_file`` and appends the result.

We use ``echo`` (cross-platform via shell=True) as the verify command
so we don't depend on pytest/ruff/etc. being installed in the test
environment.
"""
import json
import os
import sys
import threading
from pathlib import Path

import pytest

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.agents.tools import (
    ApprovalDecision,
    ToolCall,
    builtin_registry,
    find_verify_config,
    run_verify,
)
from core.agents.tools.verify import VerifyConfig, verify as verify_tool


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _drop_config(repo_root: Path, **overrides) -> Path:
    """Write .owllm/verify.json with sensible defaults + overrides."""
    cfg = {
        "command": 'echo VERIFY_OK',
        "trigger": "after_edit",
        "cwd": ".",
        "timeout_seconds": 10,
    }
    cfg.update(overrides)
    owllm = repo_root / ".owllm"
    owllm.mkdir(exist_ok=True)
    p = owllm / "verify.json"
    p.write_text(json.dumps(cfg), encoding="utf-8")
    return p


def _auto_approve(reg):
    def _on(req):
        threading.Thread(
            target=lambda: reg.gate.resolve(req.id, ApprovalDecision.APPROVE),
            daemon=True,
        ).start()
    reg.gate.add_listener(_on)


# ---------------------------------------------------------------------------
# find_verify_config — discovery
# ---------------------------------------------------------------------------


class TestFindVerifyConfig:
    def test_finds_at_repo_root(self, tmp_path):
        _drop_config(tmp_path)
        cfg = find_verify_config(tmp_path)
        assert cfg is not None
        assert cfg.command == "echo VERIFY_OK"
        assert cfg.trigger == "after_edit"
        assert cfg.auto is True

    def test_walks_up_from_subdir(self, tmp_path):
        _drop_config(tmp_path)
        deep = tmp_path / "src" / "pkg"
        deep.mkdir(parents=True)
        cfg = find_verify_config(deep)
        assert cfg is not None
        assert cfg.command == "echo VERIFY_OK"

    def test_walks_up_from_file(self, tmp_path):
        _drop_config(tmp_path)
        deep = tmp_path / "src" / "pkg"
        deep.mkdir(parents=True)
        f = deep / "module.py"
        f.write_text("", encoding="utf-8")
        cfg = find_verify_config(f)
        assert cfg is not None

    def test_returns_none_when_no_config(self, tmp_path):
        assert find_verify_config(tmp_path) is None

    def test_malformed_json_returns_none(self, tmp_path):
        owllm = tmp_path / ".owllm"
        owllm.mkdir()
        (owllm / "verify.json").write_text("{not valid json", encoding="utf-8")
        assert find_verify_config(tmp_path) is None

    def test_missing_command_returns_none(self, tmp_path):
        owllm = tmp_path / ".owllm"
        owllm.mkdir()
        (owllm / "verify.json").write_text(json.dumps({"trigger": "after_edit"}),
                                            encoding="utf-8")
        assert find_verify_config(tmp_path) is None

    def test_invalid_trigger_falls_back_to_after_edit(self, tmp_path):
        _drop_config(tmp_path, trigger="bogus")
        cfg = find_verify_config(tmp_path)
        assert cfg is not None
        assert cfg.trigger == "after_edit"

    def test_manual_trigger_is_not_auto(self, tmp_path):
        _drop_config(tmp_path, trigger="manual")
        cfg = find_verify_config(tmp_path)
        assert cfg is not None
        assert cfg.auto is False

    def test_timeout_clamped_to_max(self, tmp_path):
        _drop_config(tmp_path, timeout_seconds=99999)
        cfg = find_verify_config(tmp_path)
        assert cfg is not None
        assert cfg.timeout_seconds == 300

    def test_cwd_must_exist(self, tmp_path):
        _drop_config(tmp_path, cwd="phantom_subdir")
        assert find_verify_config(tmp_path) is None

    def test_subdir_cwd_resolves(self, tmp_path):
        sub = tmp_path / "pkg"
        sub.mkdir()
        _drop_config(tmp_path, cwd="pkg")
        cfg = find_verify_config(tmp_path)
        assert cfg is not None
        assert cfg.cwd == sub.resolve()


# ---------------------------------------------------------------------------
# run_verify
# ---------------------------------------------------------------------------


class TestRunVerify:
    def _cfg(self, tmp_path, command='echo HELLO_WORLD'):
        _drop_config(tmp_path, command=command)
        return find_verify_config(tmp_path)

    def test_success_includes_stdout(self, tmp_path):
        cfg = self._cfg(tmp_path, 'echo HELLO_WORLD')
        out = run_verify(cfg)
        assert "exit=0" in out
        assert "HELLO_WORLD" in out

    def test_nonzero_exit_surfaced(self, tmp_path):
        # `exit 7` is portable in both bash and cmd via shell=True semantics.
        # On Windows, `exit /b 7` works inside cmd; without /b it kills the
        # shell. We use the more portable shell builtin.
        if os.name == "nt":
            cmd = "cmd /c exit 7"
        else:
            cmd = "exit 7"
        cfg = self._cfg(tmp_path, cmd)
        out = run_verify(cfg)
        assert "exit=7" in out

    def test_timeout_returns_clean_message(self, tmp_path):
        # Sleep longer than the override timeout. Use a portable
        # shell-only command so we don't have to worry about quoting
        # ``sys.executable`` (which on Windows lives under "Program Files").
        if os.name == "nt":
            cmd = "ping -n 5 127.0.0.1 >nul"
        else:
            cmd = "sleep 5"
        cfg = self._cfg(tmp_path, cmd)
        out = run_verify(cfg, timeout_override=1)
        assert "TIMED OUT" in out

    def test_command_override_used(self, tmp_path):
        cfg = self._cfg(tmp_path, 'echo CONFIGURED')
        out = run_verify(cfg, command_override='echo OVERRIDDEN')
        assert "OVERRIDDEN" in out
        assert "CONFIGURED" not in out


# ---------------------------------------------------------------------------
# Manual ``verify`` tool calls
# ---------------------------------------------------------------------------


class TestVerifyToolManual:
    def test_no_config_no_command_returns_helpful_message(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="verify", args={}),
            agent="t", goal_id="g",
        )
        # Tool succeeded (returned a string), it just told the agent what to do.
        assert r.ok
        assert "no .owllm/verify.json" in r.output

    def test_configured_command_not_gated(self, tmp_path, monkeypatch):
        # No approval listener installed — if the registry tried to gate
        # this, it would time out. The fact that it returns quickly with
        # the echo output proves the gate was skipped.
        _drop_config(tmp_path, command='echo NO_GATE')
        monkeypatch.chdir(tmp_path)
        reg = builtin_registry()
        reg.gate.default_timeout_seconds = 0.5
        r = reg.invoke(
            ToolCall(name="verify", args={}),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "NO_GATE" in r.output

    def test_command_override_is_gated(self, tmp_path, monkeypatch):
        _drop_config(tmp_path)
        monkeypatch.chdir(tmp_path)
        reg = builtin_registry()
        reg.gate.default_timeout_seconds = 0.1  # short timeout, no listener
        r = reg.invoke(
            ToolCall(name="verify", args={"command": "echo OVERRIDE"}),
            agent="t", goal_id="g",
        )
        assert not r.ok
        assert "approval" in r.output

    def test_command_override_runs_when_approved(self, tmp_path, monkeypatch):
        _drop_config(tmp_path)
        monkeypatch.chdir(tmp_path)
        reg = builtin_registry()
        _auto_approve(reg)
        r = reg.invoke(
            ToolCall(name="verify", args={"command": "echo APPROVED_OVERRIDE"}),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "APPROVED_OVERRIDE" in r.output


# ---------------------------------------------------------------------------
# Auto-verify hook on edit_file / write_file_with_diff
# ---------------------------------------------------------------------------


class TestAutoVerifyHook:
    def _setup_repo(self, tmp_path, command='echo AUTO_OK', body="hello\n"):
        f = tmp_path / "src.txt"
        f.write_text(body, encoding="utf-8")
        _drop_config(tmp_path, command=command)
        return f

    def test_appends_to_edit_file_output(self, tmp_path):
        f = self._setup_repo(tmp_path, command='echo AUTO_OK')
        reg = builtin_registry()
        _auto_approve(reg)
        # Warm read-before-edit guard.
        reg.invoke(ToolCall(name="read_file", args={"path": str(f)}),
                   agent="t", goal_id="g")
        r = reg.invoke(
            ToolCall(name="edit_file", args={
                "path": str(f), "old_string": "hello", "new_string": "HELLO",
            }),
            agent="t", goal_id="g",
        )
        assert r.ok, r.output
        assert "--- AUTO-VERIFY ---" in r.output
        assert "AUTO_OK" in r.output

    def test_appends_to_write_file_output(self, tmp_path):
        new_file = tmp_path / "new.txt"
        _drop_config(tmp_path, command='echo WRITE_VERIFIED')
        reg = builtin_registry()
        _auto_approve(reg)
        r = reg.invoke(
            ToolCall(name="write_file_with_diff", args={
                "path": str(new_file), "content": "fresh\n",
            }),
            agent="t", goal_id="g",
        )
        assert r.ok, r.output
        assert "--- AUTO-VERIFY ---" in r.output
        assert "WRITE_VERIFIED" in r.output

    def test_no_config_no_auto_verify(self, tmp_path):
        # No verify.json → no AUTO-VERIFY block.
        f = tmp_path / "src.txt"
        f.write_text("hi\n", encoding="utf-8")
        reg = builtin_registry()
        _auto_approve(reg)
        reg.invoke(ToolCall(name="read_file", args={"path": str(f)}),
                   agent="t", goal_id="g")
        r = reg.invoke(
            ToolCall(name="edit_file", args={
                "path": str(f), "old_string": "hi", "new_string": "bye",
            }),
            agent="t", goal_id="g",
        )
        assert r.ok, r.output
        assert "AUTO-VERIFY" not in r.output

    def test_manual_trigger_skips_auto(self, tmp_path):
        f = self._setup_repo(tmp_path)
        # Re-write config with manual trigger.
        _drop_config(tmp_path, command='echo SHOULD_NOT_RUN', trigger="manual")
        reg = builtin_registry()
        _auto_approve(reg)
        reg.invoke(ToolCall(name="read_file", args={"path": str(f)}),
                   agent="t", goal_id="g")
        r = reg.invoke(
            ToolCall(name="edit_file", args={
                "path": str(f), "old_string": "hello", "new_string": "HI",
            }),
            agent="t", goal_id="g",
        )
        assert r.ok, r.output
        assert "AUTO-VERIFY" not in r.output

    def test_failing_verify_does_not_undo_edit(self, tmp_path):
        f = self._setup_repo(tmp_path, command=("cmd /c exit 3" if os.name == "nt" else "exit 3"))
        reg = builtin_registry()
        _auto_approve(reg)
        reg.invoke(ToolCall(name="read_file", args={"path": str(f)}),
                   agent="t", goal_id="g")
        r = reg.invoke(
            ToolCall(name="edit_file", args={
                "path": str(f), "old_string": "hello", "new_string": "GOODBYE",
            }),
            agent="t", goal_id="g",
        )
        assert r.ok, r.output
        # Edit applied even though verify failed.
        assert f.read_text(encoding="utf-8") == "GOODBYE\n"
        assert "exit=3" in r.output

    def test_auto_verify_hidden_when_tool_not_in_view(self, tmp_path):
        # An agent with a restricted allowlist that doesn't include verify
        # should not trigger auto-verify (it's not in their toolset, so
        # they wouldn't be able to read about it anyway).
        f = self._setup_repo(tmp_path)
        reg = builtin_registry()
        _auto_approve(reg)
        reg.invoke(ToolCall(name="read_file", args={"path": str(f)}),
                   agent="t", goal_id="g")
        view = reg.for_allowlist(["read_file", "edit_file"])  # no verify
        r = view.invoke(
            ToolCall(name="edit_file", args={
                "path": str(f), "old_string": "hello", "new_string": "HEY",
            }),
            agent="t", goal_id="g",
        )
        assert r.ok, r.output
        assert "AUTO-VERIFY" not in r.output

    def test_format_for_prompt_includes_verify(self):
        from core.agents.tools import format_for_prompt
        prompt = format_for_prompt(builtin_registry())
        assert "verify" in prompt
