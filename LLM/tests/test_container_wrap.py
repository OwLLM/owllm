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

from core.agents.backends._container_wrap import wrap_cli_for_container
from core.fleet.container_runtime import Mount


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
