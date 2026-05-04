"""Tests for git_status / git_diff / git_log / git_blame / git_show.

Each test stands up a real git repo in tmp_path so we exercise the actual
git binary — mocking subprocess would just test that we built a command
line, not that the wrapper survives real git output. Tests are skipped
if git isn't on PATH (CI environments without it).
"""
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.agents.tools import ToolCall, builtin_registry


pytestmark = pytest.mark.skipif(
    shutil.which("git") is None, reason="git not installed"
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _git(repo: Path, *args: str) -> str:
    """Helper: shell out to git inside ``repo`` and return stdout."""
    proc = subprocess.run(
        ["git", *args],
        cwd=str(repo),
        capture_output=True,
        text=True,
        check=True,
    )
    return proc.stdout


@pytest.fixture
def repo(tmp_path):
    """A fresh git repo with one initial commit on branch 'main'."""
    r = tmp_path / "r"
    r.mkdir()
    _git(r, "init", "-q", "-b", "main")
    _git(r, "config", "user.email", "test@example.com")
    _git(r, "config", "user.name", "Test")
    (r / "a.txt").write_text("alpha\n", encoding="utf-8")
    _git(r, "add", "a.txt")
    _git(r, "commit", "-q", "-m", "initial")
    return r


# ---------------------------------------------------------------------------
# git_status
# ---------------------------------------------------------------------------


class TestGitStatus:
    def test_clean_tree(self, repo):
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="git_status", args={"repo": str(repo)}),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "clean working tree" in r.output
        assert "main" in r.output

    def test_modified_file_shown(self, repo):
        (repo / "a.txt").write_text("alpha changed\n", encoding="utf-8")
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="git_status", args={"repo": str(repo)}),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "a.txt" in r.output
        # porcelain: " M a.txt" or "M  a.txt" depending on staged state
        assert "M" in r.output

    def test_untracked_hidden_by_default(self, repo):
        (repo / "new.txt").write_text("", encoding="utf-8")
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="git_status", args={"repo": str(repo)}),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "new.txt" not in r.output

    def test_untracked_shown_when_requested(self, repo):
        (repo / "new.txt").write_text("", encoding="utf-8")
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="git_status", args={
                "repo": str(repo), "show_untracked": True,
            }),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "new.txt" in r.output

    def test_not_a_git_repo_clean_error(self, tmp_path):
        non = tmp_path / "not_a_repo"
        non.mkdir()
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="git_status", args={"repo": str(non)}),
            agent="t", goal_id="g",
        )
        assert not r.ok
        assert "not a git repository" in r.output.lower() or "fatal" in r.output.lower()


# ---------------------------------------------------------------------------
# git_diff
# ---------------------------------------------------------------------------


class TestGitDiff:
    def test_unstaged(self, repo):
        (repo / "a.txt").write_text("alpha changed\n", encoding="utf-8")
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="git_diff", args={"repo": str(repo)}),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "-alpha" in r.output and "+alpha changed" in r.output

    def test_no_changes(self, repo):
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="git_diff", args={"repo": str(repo)}),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert r.output == "(no diff)"

    def test_staged_diff(self, repo):
        (repo / "a.txt").write_text("alpha changed\n", encoding="utf-8")
        _git(repo, "add", "a.txt")
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="git_diff", args={"repo": str(repo), "staged": True}),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "+alpha changed" in r.output

    def test_stat_mode(self, repo):
        (repo / "a.txt").write_text("alpha changed\n", encoding="utf-8")
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="git_diff", args={"repo": str(repo), "stat": True}),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "a.txt" in r.output
        assert "+" in r.output  # the stat plus-sign histogram

    def test_path_filter(self, repo):
        (repo / "a.txt").write_text("alpha changed\n", encoding="utf-8")
        (repo / "b.txt").write_text("brand new\n", encoding="utf-8")
        _git(repo, "add", "b.txt")
        _git(repo, "commit", "-q", "-m", "add b")
        (repo / "b.txt").write_text("brand newer\n", encoding="utf-8")
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="git_diff", args={"repo": str(repo), "path": "a.txt"}),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "a.txt" in r.output
        assert "b.txt" not in r.output


# ---------------------------------------------------------------------------
# git_log
# ---------------------------------------------------------------------------


class TestGitLog:
    def test_oneline_default(self, repo):
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="git_log", args={"repo": str(repo)}),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "initial" in r.output
        # Oneline: short hash + subject + (author, ago)
        assert "(Test" in r.output

    def test_limit_respected(self, repo):
        for i in range(5):
            (repo / f"f{i}.txt").write_text(str(i), encoding="utf-8")
            _git(repo, "add", f"f{i}.txt")
            _git(repo, "commit", "-q", "-m", f"commit {i}")
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="git_log", args={"repo": str(repo), "limit": 2}),
            agent="t", goal_id="g",
        )
        assert r.ok
        # Should mention the latest two and not the initial.
        assert "commit 4" in r.output and "commit 3" in r.output
        assert "initial" not in r.output

    def test_grep_filters(self, repo):
        (repo / "x.txt").write_text("", encoding="utf-8")
        _git(repo, "add", "x.txt")
        _git(repo, "commit", "-q", "-m", "FOO_MARKER one")
        (repo / "y.txt").write_text("", encoding="utf-8")
        _git(repo, "add", "y.txt")
        _git(repo, "commit", "-q", "-m", "unrelated")
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="git_log", args={"repo": str(repo), "grep": "FOO_MARKER"}),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "FOO_MARKER" in r.output
        assert "unrelated" not in r.output

    def test_full_format_when_oneline_false(self, repo):
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="git_log", args={"repo": str(repo), "oneline": False}),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "Author:" in r.output and "Date:" in r.output


# ---------------------------------------------------------------------------
# git_blame
# ---------------------------------------------------------------------------


class TestGitBlame:
    def test_blame_known_line(self, repo):
        (repo / "a.txt").write_text("alpha\nbeta\ngamma\n", encoding="utf-8")
        _git(repo, "add", "a.txt")
        _git(repo, "commit", "-q", "-m", "expand a")
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="git_blame", args={
                "repo": str(repo), "path": "a.txt", "line_start": 2, "line_end": 2,
            }),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "beta" in r.output
        assert "Test" in r.output  # author from fixture

    def test_path_required(self, repo):
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="git_blame", args={"repo": str(repo)}),
            agent="t", goal_id="g",
        )
        assert not r.ok
        # Tool.invoke validates required args and surfaces them generically.
        assert "missing required" in r.output and "path" in r.output

    def test_invalid_range_rejected(self, repo):
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="git_blame", args={
                "repo": str(repo), "path": "a.txt", "line_start": 5, "line_end": 2,
            }),
            agent="t", goal_id="g",
        )
        assert not r.ok


# ---------------------------------------------------------------------------
# git_show
# ---------------------------------------------------------------------------


class TestGitShow:
    def test_default_head(self, repo):
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="git_show", args={"repo": str(repo)}),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "initial" in r.output

    def test_stat_mode(self, repo):
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="git_show", args={"repo": str(repo), "stat": True}),
            agent="t", goal_id="g",
        )
        assert r.ok
        assert "a.txt" in r.output

    def test_invalid_rev_clean_error(self, repo):
        reg = builtin_registry()
        r = reg.invoke(
            ToolCall(name="git_show", args={"repo": str(repo), "rev": "nonexistent_ref"}),
            agent="t", goal_id="g",
        )
        assert not r.ok
        assert "git show" in r.output.lower()
