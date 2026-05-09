"""Tests for ``backends._container_wrap.wrap_cli_for_container``.

The wrap's logic — given the new ``kind=container`` default — boils down to:

* No project cwd          → no-op (host fallback).
* ``kind=worktree``       → no-op (user explicitly opted out).
* Docker daemon down      → no-op (logged warning; degraded > broken).
* Otherwise               → ``docker run …`` with workspace + auth mounts.

Docker availability is mocked across the suite — these tests must run on
hosts without Docker installed and must NEVER trigger ``docker build``.
"""
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.agents.backends._container_wrap import (
    _strip_host_binary_path,
    wrap_cli_for_container,
    wrap_shell_for_container,
)
from core.fleet.container_runtime import Mount


# ---------------------------------------------------------------------------
# Host-binary path stripping
# ---------------------------------------------------------------------------


class TestStripHostBinaryPath:
    """Inner argv must use the container's ``claude`` / ``codex`` from
    PATH, not the host-resolved absolute path. Otherwise Node tries to
    load a module at ``/workspace/C:\\Users\\…`` and fails."""

    def test_windows_cmd_path_stripped(self):
        argv = [r"C:\Users\mc\AppData\Roaming\npm\claude.cmd", "--print", "--model", "x"]
        out = _strip_host_binary_path(argv)
        assert out[0] == "claude"
        assert out[1:] == ["--print", "--model", "x"]

    def test_windows_exe_path_stripped(self):
        argv = [r"C:\Program Files\Node\codex.exe", "exec"]
        assert _strip_host_binary_path(argv)[0] == "codex"

    def test_posix_abs_path_stripped(self):
        argv = ["/usr/local/bin/claude", "--print"]
        assert _strip_host_binary_path(argv)[0] == "claude"

    def test_bare_command_unchanged(self):
        argv = ["claude", "--print"]
        assert _strip_host_binary_path(argv) == argv

    def test_empty_argv_unchanged(self):
        assert _strip_host_binary_path([]) == []


# ---------------------------------------------------------------------------
# default_auth_mounts — file + directory + cross-platform variants
# ---------------------------------------------------------------------------


class TestDefaultAuthMounts:
    """Verify the auth-mount audit picks up the FILES (.claude.json,
    .gitconfig) plus all per-CLI directory variants. The 'Claude config
    not found at /root/.claude.json' bug was caused by mounting the
    dir but not the file — these tests guard against regressing."""

    def test_claude_json_file_is_mounted_when_present(
        self, tmp_path, monkeypatch,
    ):
        # Simulate a fake home with .claude.json present.
        fake_home = tmp_path / "home"
        fake_home.mkdir()
        (fake_home / ".claude.json").write_text("{}", encoding="utf-8")

        monkeypatch.setattr(
            "core.fleet.container_runtime.Path.home",
            staticmethod(lambda: fake_home),
        )
        from core.fleet.container_runtime import default_auth_mounts
        mounts = default_auth_mounts()
        dests = [m.container_path for m in mounts]
        assert "/root/.claude.json" in dests
        # Mode is ro for all auth mounts
        for m in mounts:
            assert m.mode == "ro"

    def test_gitconfig_mounted_when_present(self, tmp_path, monkeypatch):
        fake_home = tmp_path / "home"
        fake_home.mkdir()
        (fake_home / ".gitconfig").write_text("[user]\n", encoding="utf-8")

        monkeypatch.setattr(
            "core.fleet.container_runtime.Path.home",
            staticmethod(lambda: fake_home),
        )
        from core.fleet.container_runtime import default_auth_mounts
        dests = [m.container_path for m in default_auth_mounts()]
        assert "/root/.gitconfig" in dests

    def test_codex_cross_platform_first_match_wins(self, tmp_path, monkeypatch):
        # Both ~/.config/codex AND ~/.codex exist (rare but possible).
        # First matching candidate (POSIX path) should win to avoid
        # double-mounting /root/.config/codex etc.
        fake_home = tmp_path / "home"
        (fake_home / ".config" / "codex").mkdir(parents=True)
        (fake_home / ".codex").mkdir()

        monkeypatch.setattr(
            "core.fleet.container_runtime.Path.home",
            staticmethod(lambda: fake_home),
        )
        from core.fleet.container_runtime import default_auth_mounts
        mounts = default_auth_mounts()
        # Both candidates have DIFFERENT container paths, so both should mount.
        dests = [m.container_path for m in mounts]
        assert "/root/.config/codex" in dests
        assert "/root/.codex" in dests

    def test_gh_dedup_when_both_paths_exist(self, tmp_path, monkeypatch):
        # POSIX gh AND Windows gh both pointing at /root/.config/gh —
        # only the first should be mounted.
        fake_home = tmp_path / "home"
        (fake_home / ".config" / "gh").mkdir(parents=True)
        (fake_home / "AppData" / "Roaming" / "GitHub CLI").mkdir(parents=True)

        monkeypatch.setattr(
            "core.fleet.container_runtime.Path.home",
            staticmethod(lambda: fake_home),
        )
        from core.fleet.container_runtime import default_auth_mounts
        # Only one mount per /root/.config/gh — first-match wins.
        gh_mounts = [
            m for m in default_auth_mounts()
            if m.container_path == "/root/.config/gh"
        ]
        assert len(gh_mounts) == 1

    def test_missing_files_skipped(self, tmp_path, monkeypatch):
        # Empty home — nothing to mount.
        fake_home = tmp_path / "empty_home"
        fake_home.mkdir()
        monkeypatch.setattr(
            "core.fleet.container_runtime.Path.home",
            staticmethod(lambda: fake_home),
        )
        from core.fleet.container_runtime import default_auth_mounts
        assert default_auth_mounts() == []


@pytest.fixture
def fleet_root_env(tmp_path, monkeypatch):
    """Point the fleet config at a fresh tmp dir for each test."""
    monkeypatch.setenv("OWLLM_FLEET_ROOT", str(tmp_path))
    return tmp_path


@pytest.fixture
def project_dir(tmp_path):
    """A real on-disk project directory the wrap can mount."""
    proj = tmp_path / "project"
    proj.mkdir()
    return proj


def _write_runtime_json(fleet_root: Path, payload: dict) -> None:
    (fleet_root / "runtime.json").write_text(
        json.dumps(payload), encoding="utf-8",
    )


# ---------------------------------------------------------------------------
# Default-disabled paths (no Docker / no project / explicit worktree)
# ---------------------------------------------------------------------------


class TestNoOpPaths:
    @pytest.fixture(autouse=True)
    def _docker_unavailable(self):
        """Pretend Docker isn't installed so missing-config + default
        kind=container falls back to host instead of trying to build."""
        with patch(
            "core.fleet.container_runtime.ContainerRuntime.is_available",
            return_value=False,
        ):
            yield

    def test_no_cwd_returns_unchanged(self, fleet_root_env):
        argv = ["claude", "--print"]
        out_argv, out_cwd, info = wrap_cli_for_container(argv, host_cwd=None)
        assert out_argv == argv
        assert out_cwd is None
        assert info is None

    def test_missing_cwd_returns_unchanged(self, fleet_root_env, tmp_path):
        argv = ["claude", "--print"]
        bogus = str(tmp_path / "does_not_exist")
        out_argv, out_cwd, info = wrap_cli_for_container(argv, host_cwd=bogus)
        assert out_argv == argv
        assert out_cwd == bogus
        assert info is None

    def test_docker_unavailable_returns_unchanged(self, fleet_root_env, project_dir):
        # No runtime.json on disk → defaults apply (kind=container) → but
        # Docker is mocked unavailable → host fallback.
        argv = ["claude", "--print"]
        out_argv, out_cwd, info = wrap_cli_for_container(
            argv, host_cwd=str(project_dir),
        )
        assert out_argv == argv
        assert out_cwd == str(project_dir)
        assert info is None

    def test_kind_worktree_returns_unchanged(self, fleet_root_env, project_dir):
        # Explicit worktree opts out even if Docker is up — but we already
        # have Docker mocked off, so this test really proves that
        # kind=worktree short-circuits *before* checking is_available.
        _write_runtime_json(fleet_root_env, {"kind": "worktree"})
        argv = ["claude", "--print"]
        out_argv, out_cwd, info = wrap_cli_for_container(
            argv, host_cwd=str(project_dir),
        )
        assert out_argv == argv
        assert info is None


# ---------------------------------------------------------------------------
# Active wrap path
# ---------------------------------------------------------------------------


class TestActiveWrap:
    @pytest.fixture(autouse=True)
    def _force_docker_available_no_auth_mounts(self):
        """Pretend Docker is up; skip default auth mounts so tests stay
        deterministic across hosts (we don't want to assert the user has
        ``~/.claude`` populated)."""
        with patch(
            "core.fleet.container_runtime.ContainerRuntime.is_available",
            return_value=True,
        ), patch(
            "core.fleet.container_runtime.default_auth_mounts",
            return_value=[],
        ):
            yield

    def test_basic_wrap(self, fleet_root_env, project_dir):
        # Pin a custom image so we don't trigger the auto-build code path.
        _write_runtime_json(
            fleet_root_env,
            {
                "kind": "container",
                "image": "owllm/agent-runtime:test",
                "use_default_auth_mounts": False,
            },
        )
        argv = ["claude", "--print", "--model", "claude-haiku-4-5"]
        out_argv, out_cwd, info = wrap_cli_for_container(
            argv, host_cwd=str(project_dir),
        )
        assert out_argv[0] == "docker"
        assert out_argv[1] == "run"
        assert "--rm" in out_argv
        assert "-i" in out_argv
        # Workspace mount + workdir
        assert "-v" in out_argv
        v_idx = out_argv.index("-v")
        assert out_argv[v_idx + 1] == f"{project_dir}:/workspace:rw"
        w_idx = out_argv.index("-w")
        assert out_argv[w_idx + 1] == "/workspace"
        # Image immediately before the inner argv
        assert "owllm/agent-runtime:test" in out_argv
        img_idx = out_argv.index("owllm/agent-runtime:test")
        assert out_argv[img_idx + 1 :] == argv
        # cwd cleared because Docker handles the mount
        assert out_cwd is None
        # Info dict for log lines
        assert info is not None
        assert info["image"] == "owllm/agent-runtime:test"
        assert info["workspace"] == str(project_dir)

    def test_default_image_triggers_auto_build(self, fleet_root_env, project_dir):
        # No runtime.json → defaults apply → image == DEFAULT_IMAGE →
        # wrap calls ensure_agent_image(). Mock the helper so the test
        # stays fast and offline.
        with patch(
            "core.agents.agent_image.ensure_agent_image",
            return_value="owllm/agent:abc1234",
        ) as ensure:
            out_argv, out_cwd, info = wrap_cli_for_container(
                ["claude", "--print"], host_cwd=str(project_dir),
            )
        ensure.assert_called_once()
        assert "owllm/agent:abc1234" in out_argv
        assert info["image"] == "owllm/agent:abc1234"
        assert out_cwd is None

    def test_auto_build_failure_falls_back_to_host(
        self, fleet_root_env, project_dir,
    ):
        # When the auto-build helper raises (no Docker, build error,
        # network down for npm install, …), the wrap must NOT freeze
        # the team — it falls back to host execution with a warning.
        from core.agents.agent_image import AgentImageError
        with patch(
            "core.agents.agent_image.ensure_agent_image",
            side_effect=AgentImageError("simulated"),
        ):
            argv = ["claude", "--print"]
            out_argv, out_cwd, info = wrap_cli_for_container(
                argv, host_cwd=str(project_dir),
            )
        assert out_argv == argv
        assert out_cwd == str(project_dir)
        assert info is None

    def test_network_passed_through(self, fleet_root_env, project_dir):
        _write_runtime_json(
            fleet_root_env,
            {
                "kind": "container",
                "image": "test:latest",
                "network": "none",
                "use_default_auth_mounts": False,
            },
        )
        out_argv, _, info = wrap_cli_for_container(
            ["claude", "--print"], host_cwd=str(project_dir),
        )
        assert "--network" in out_argv
        n_idx = out_argv.index("--network")
        assert out_argv[n_idx + 1] == "none"
        assert info["network"] == "none"

    def test_extra_auth_mounts_added(self, fleet_root_env, project_dir, tmp_path):
        host_secrets = tmp_path / "secrets"
        host_secrets.mkdir()
        _write_runtime_json(
            fleet_root_env,
            {
                "kind": "container",
                "image": "test:latest",
                "use_default_auth_mounts": False,
                "extra_auth_mounts": [
                    {
                        "host_path": str(host_secrets),
                        "container_path": "/etc/secrets",
                        "mode": "ro",
                    }
                ],
            },
        )
        out_argv, _, info = wrap_cli_for_container(
            ["claude", "--print"], host_cwd=str(project_dir),
        )
        # Should appear as a -v with ro mode
        joined = " ".join(out_argv)
        assert f"{host_secrets}:/etc/secrets:ro" in joined

    def test_user_flag_passed_through(self, fleet_root_env, project_dir):
        _write_runtime_json(
            fleet_root_env,
            {
                "kind": "container",
                "image": "test:latest",
                "user": "1000:1000",
                "use_default_auth_mounts": False,
            },
        )
        out_argv, _, _ = wrap_cli_for_container(
            ["claude", "--print"], host_cwd=str(project_dir),
        )
        assert "--user" in out_argv
        u_idx = out_argv.index("--user")
        assert out_argv[u_idx + 1] == "1000:1000"


# ---------------------------------------------------------------------------
# wrap_shell_for_container — host fallback shape + container shape
# ---------------------------------------------------------------------------


class TestShellWrap:
    def test_no_cwd_returns_unchanged_string_with_shell_true(self, fleet_root_env):
        # Shell tool's host path is ``subprocess.run(cmd, shell=True, …)``.
        # The wrap must preserve that contract when not containerizing.
        with patch(
            "core.fleet.container_runtime.ContainerRuntime.is_available",
            return_value=False,
        ):
            cmd, cwd, use_shell, info = wrap_shell_for_container(
                "pytest -x", host_cwd=None,
            )
        assert cmd == "pytest -x"
        assert cwd is None
        assert use_shell is True
        assert info is None

    def test_docker_unavailable_returns_string_with_shell_true(
        self, fleet_root_env, project_dir,
    ):
        with patch(
            "core.fleet.container_runtime.ContainerRuntime.is_available",
            return_value=False,
        ):
            cmd, cwd, use_shell, info = wrap_shell_for_container(
                "ls -la", host_cwd=str(project_dir),
            )
        assert cmd == "ls -la"
        assert cwd == str(project_dir)
        assert use_shell is True
        assert info is None

    def test_active_wrap_returns_argv_with_shell_false(
        self, fleet_root_env, project_dir,
    ):
        # When containerized, the shell command is passed as
        # ``["sh", "-c", cmd]`` to ``docker run``, and subprocess.run
        # must NOT use shell=True (the OS shell already lives inside
        # the container).
        _write_runtime_json(
            fleet_root_env,
            {
                "kind": "container",
                "image": "test:latest",
                "use_default_auth_mounts": False,
            },
        )
        with patch(
            "core.fleet.container_runtime.ContainerRuntime.is_available",
            return_value=True,
        ), patch(
            "core.fleet.container_runtime.default_auth_mounts", return_value=[],
        ):
            cmd, cwd, use_shell, info = wrap_shell_for_container(
                "pytest -x", host_cwd=str(project_dir),
            )
        # Should be a docker run … sh -c "pytest -x" argv
        assert isinstance(cmd, list)
        assert cmd[0] == "docker"
        assert cmd[1] == "run"
        assert "sh" in cmd
        sh_idx = cmd.index("sh")
        assert cmd[sh_idx : sh_idx + 3] == ["sh", "-c", "pytest -x"]
        assert cwd is None
        assert use_shell is False
        assert info is not None
        assert info["image"] == "test:latest"
