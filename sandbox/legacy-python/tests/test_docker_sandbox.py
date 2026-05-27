"""Tests for :mod:`core.diagnostics.docker_sandbox`.

Most tests are gated on Docker being installed AND the daemon being up
— they skip cleanly when not, so CI without Docker stays green.

Coverage:

  * Auth fixture materialisation — files appear / don't appear per the
    classmethod chosen (unit-only, no Docker).
  * argv assembly — pure function, no Docker (verifies our mount strings,
    flags, user, network options).
  * End-to-end (Docker-gated):
      - simple ``echo`` round-trips
      - non-zero exit captured
      - workspace files visible inside container
      - auth fixtures mounted at expected ``/home/node/`` paths
      - ``--network=none`` actually blocks DNS
      - timeout fires and marks ``timed_out=True``
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

llm_dir = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(llm_dir))

from core.diagnostics.docker_sandbox import (
    AuthFixtures,
    DockerUnavailableError,
    _build_run_argv,
    _docker_available,
    run_in_sandbox,
)


# ---------------------------------------------------------------------------
# Docker availability gate
# ---------------------------------------------------------------------------


def _can_run_docker_tests() -> bool:
    """True iff Docker is installed AND the daemon responds AND the
    OWLLM agent image is buildable (which requires the Dockerfile to
    exist). We skip the e2e tests cleanly when any of those is false."""
    if not _docker_available():
        return False
    from core.agents.agent_image import dockerfile_path
    try:
        return dockerfile_path().is_file()
    except Exception:  # noqa: BLE001
        return False


docker_required = pytest.mark.skipif(
    not _can_run_docker_tests(),
    reason="Docker not available or agent Dockerfile missing",
)


# ---------------------------------------------------------------------------
# Unit tests — no Docker
# ---------------------------------------------------------------------------


class TestAuthFixtures:
    def test_empty_writes_nothing(self, tmp_path):
        fixtures = AuthFixtures.empty()
        paths = fixtures.materialize(tmp_path)
        assert paths == {}
        # Directory should exist but be empty.
        assert tmp_path.is_dir()
        assert list(tmp_path.iterdir()) == []

    def test_claude_logged_in_stub_writes_claude_files(self, tmp_path):
        fixtures = AuthFixtures.claude_logged_in_stub()
        paths = fixtures.materialize(tmp_path)
        assert ".claude.json" in paths
        # Stub must be parseable JSON with the expected shape.
        body = json.loads((tmp_path / ".claude.json").read_text())
        assert "oauthAccount" in body
        assert body["hasCompletedOnboarding"] is True
        # gitconfig comes for free.
        assert ".gitconfig" in paths

    def test_claude_stub_passes_login_probe(self, tmp_path, monkeypatch):
        """The synthetic ``.claude.json`` must pass the
        ``_claude_logged_in`` probe's size threshold (>32 bytes)."""
        from core.agents import setup as setup_mod
        AuthFixtures.claude_logged_in_stub().materialize(tmp_path)
        monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
        assert setup_mod._claude_logged_in() is True

    def test_codex_logged_in_stub_writes_codex_dir(self, tmp_path):
        fixtures = AuthFixtures.codex_logged_in_stub()
        paths = fixtures.materialize(tmp_path)
        assert ".codex" in paths
        assert (tmp_path / ".codex" / "auth.json").is_file()

    def test_both_logged_in_writes_both(self, tmp_path):
        paths = AuthFixtures.both_logged_in().materialize(tmp_path)
        assert ".claude.json" in paths
        assert ".codex" in paths


class TestArgvAssembly:
    def test_workspace_mount_present(self, tmp_path):
        argv = _build_run_argv(
            image_tag="owllm/agent:test",
            command=["echo", "hi"],
            workspace_dir=tmp_path,
            fixture_paths={},
            network="none",
            memory="1g",
            pids_limit=256,
            docker_bin="docker",
        )
        assert "docker" == argv[0]
        assert "run" in argv
        assert "--rm" in argv
        # Workspace mount must appear.
        mount = f"{tmp_path}:/workspace"
        assert mount in argv
        # Image tag is followed by the command (2 elements: echo, hi).
        image_idx = argv.index("owllm/agent:test")
        assert argv[image_idx + 1:] == ["echo", "hi"]

    def test_fixture_mounts_are_readonly(self, tmp_path):
        argv = _build_run_argv(
            image_tag="owllm/agent:test",
            command=["true"],
            workspace_dir=tmp_path,
            fixture_paths={
                ".claude.json": "/host/fake/.claude.json",
                ".codex": "/host/fake/.codex",
            },
            network="none",
            memory="1g",
            pids_limit=256,
            docker_bin="docker",
        )
        # Both fixture mounts present, both :ro suffixed, both under /home/node/.
        assert "/host/fake/.claude.json:/home/node/.claude.json:ro" in argv
        assert "/host/fake/.codex:/home/node/.codex:ro" in argv

    def test_user_is_node_not_root(self, tmp_path):
        argv = _build_run_argv(
            image_tag="owllm/agent:test", command=["true"],
            workspace_dir=tmp_path, fixture_paths={},
            network="none", memory="1g", pids_limit=256, docker_bin="docker",
        )
        # Production fix: container runs as node, not root, so
        # claude-code's --dangerously-skip-permissions guard is satisfied.
        assert "--user=node" in argv

    def test_network_none_blocks_internet(self, tmp_path):
        argv = _build_run_argv(
            image_tag="owllm/agent:test", command=["true"],
            workspace_dir=tmp_path, fixture_paths={},
            network="none", memory="1g", pids_limit=256, docker_bin="docker",
        )
        assert "--network=none" in argv

    def test_extra_env_passed_through(self, tmp_path):
        argv = _build_run_argv(
            image_tag="owllm/agent:test", command=["true"],
            workspace_dir=tmp_path, fixture_paths={},
            network="none", memory="1g", pids_limit=256, docker_bin="docker",
            extra_env={"NO_COLOR": "1", "FOO": "bar"},
        )
        assert "NO_COLOR=1" in argv
        assert "FOO=bar" in argv


class TestDockerUnavailable:
    def test_raises_when_docker_bin_missing(self, monkeypatch):
        # Point at a docker binary that doesn't exist.
        with pytest.raises(DockerUnavailableError):
            run_in_sandbox(["echo", "hi"], docker_bin="docker-does-not-exist")


# ---------------------------------------------------------------------------
# End-to-end — gated on Docker availability
# ---------------------------------------------------------------------------


@docker_required
class TestE2E:
    """End-to-end: actual ``docker run`` against the OWLLM agent image.

    These tests are slow (each takes 2-5s for image pull/cache lookup +
    container start). Run with ``pytest -k TestE2E -v`` if iterating.
    """

    def test_echo_round_trips(self):
        result = run_in_sandbox(["echo", "hello-sandbox"])
        assert result.exit_code == 0, result.stderr
        assert "hello-sandbox" in result.stdout
        assert result.timed_out is False
        assert result.duration_ms > 0

    def test_non_zero_exit_captured(self):
        result = run_in_sandbox(["sh", "-c", "exit 7"])
        assert result.exit_code == 7

    def test_workspace_files_visible_inside_container(self):
        result = run_in_sandbox(
            ["cat", "seed.txt"],
            workspace_files={"seed.txt": "marker-12345"},
        )
        assert result.exit_code == 0, result.stderr
        assert "marker-12345" in result.stdout

    def test_auth_fixtures_mounted_at_home_node(self):
        result = run_in_sandbox(
            ["sh", "-c", "ls -la /home/node/.claude.json && cat /home/node/.claude.json"],
            auth_fixtures=AuthFixtures.claude_logged_in_stub(),
        )
        assert result.exit_code == 0, result.stderr
        assert "oauthAccount" in result.stdout

    def test_network_none_blocks_dns(self):
        # nslookup / getent under network=none should fail because the
        # container has no networking at all. Cheap check: try to fetch
        # via wget (fails) vs no-network ls (works).
        result = run_in_sandbox(
            ["sh", "-c", "wget -T 3 -q -O - http://example.com 2>&1 || echo BLOCKED"],
            timeout_seconds=15,
        )
        assert "BLOCKED" in result.stdout

    def test_timeout_marks_timed_out(self):
        result = run_in_sandbox(["sh", "-c", "sleep 30"], timeout_seconds=3)
        assert result.timed_out is True
        assert result.exit_code == -1
        assert "timed out" in result.stderr.lower()
