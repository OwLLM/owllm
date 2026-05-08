"""Tests for ``backends._container_wrap.wrap_cli_for_container``.

Covers the no-op paths (missing cwd, no runtime.json, kind=worktree,
docker absent) and the active path (kind=container + docker available
+ valid cwd → ``docker run`` argv with workspace + auth mounts).
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
# No-op paths
# ---------------------------------------------------------------------------


class TestNoOpPaths:
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

    def test_no_runtime_json_returns_unchanged(self, fleet_root_env, project_dir):
        argv = ["claude", "--print"]
        out_argv, out_cwd, info = wrap_cli_for_container(
            argv, host_cwd=str(project_dir),
        )
        assert out_argv == argv
        assert out_cwd == str(project_dir)
        assert info is None

    def test_kind_worktree_returns_unchanged(self, fleet_root_env, project_dir):
        _write_runtime_json(fleet_root_env, {"kind": "worktree"})
        argv = ["claude", "--print"]
        out_argv, out_cwd, info = wrap_cli_for_container(
            argv, host_cwd=str(project_dir),
        )
        assert out_argv == argv
        assert info is None

    def test_kind_container_but_docker_unavailable_falls_back(
        self, fleet_root_env, project_dir,
    ):
        _write_runtime_json(fleet_root_env, {"kind": "container"})
        argv = ["claude", "--print"]
        # Force is_available() to False — simulates Docker not installed.
        with patch(
            "core.fleet.container_runtime.ContainerRuntime.is_available",
            return_value=False,
        ):
            out_argv, out_cwd, info = wrap_cli_for_container(
                argv, host_cwd=str(project_dir),
            )
        assert out_argv == argv
        assert out_cwd == str(project_dir)
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
