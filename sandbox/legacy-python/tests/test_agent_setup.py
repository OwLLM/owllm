"""Tests for ``core.agents.setup.check_agent_setup``.

Probes (Docker / claude / codex) are mocked. Verify the synthesised
state and the recommendation list match each prerequisite combo.
"""
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.agents.setup import (
    AgentSetupStatus,
    SetupState,
    check_agent_setup,
)


def _mock_probes(
    *,
    docker_installed=False,
    docker_running=False,
    claude_cli=False,
    claude_logged=False,
    codex_cli=False,
    codex_logged=False,
):
    """Patch every individual probe to return a predetermined value."""
    return [
        patch("core.agents.setup._docker_installed", return_value=docker_installed),
        patch("core.agents.setup._docker_running", return_value=docker_running),
        patch("core.agents.setup._claude_cli_on_host", return_value=claude_cli),
        patch("core.agents.setup._claude_logged_in", return_value=claude_logged),
        patch("core.agents.setup._codex_cli_on_host", return_value=codex_cli),
        patch("core.agents.setup._codex_logged_in", return_value=codex_logged),
    ]


class TestStatesByPriority:
    """State priority is most-blocking-first: missing-docker beats
    docker-down beats no-auth beats ready. Each test sets the worst
    issue and one less-blocking issue, expects the worst to win."""

    def test_missing_docker_dominates(self):
        # Worst case: nothing installed.
        with patch("core.agents.setup._docker_installed", return_value=False):
            with patch("core.agents.setup._docker_running", return_value=False):
                with patch("core.agents.setup._claude_cli_on_host", return_value=False):
                    with patch("core.agents.setup._claude_logged_in", return_value=False):
                        with patch("core.agents.setup._codex_cli_on_host", return_value=False):
                            with patch("core.agents.setup._codex_logged_in", return_value=False):
                                s = check_agent_setup()
        assert s.state == SetupState.DOCKER_MISSING
        # Recommendations include both 'install Docker' and 'install a CLI'
        joined = "\n".join(s.recommendations)
        assert "Docker" in joined

    def test_docker_down_when_installed_but_daemon_off(self):
        # Daemon down but everything else fine.
        ctxs = _mock_probes(
            docker_installed=True, docker_running=False,
            claude_cli=True, claude_logged=True,
        )
        with ctxs[0], ctxs[1], ctxs[2], ctxs[3], ctxs[4], ctxs[5]:
            s = check_agent_setup()
        assert s.state == SetupState.DOCKER_DOWN
        assert any("Start Docker" in r for r in s.recommendations)

    def test_not_logged_in_when_docker_up_no_cli_session(self):
        # Docker up but neither CLI is logged in.
        ctxs = _mock_probes(
            docker_installed=True, docker_running=True,
            claude_cli=True, claude_logged=False,  # CLI installed, no login
            codex_cli=False, codex_logged=False,
        )
        with ctxs[0], ctxs[1], ctxs[2], ctxs[3], ctxs[4], ctxs[5]:
            s = check_agent_setup()
        assert s.state == SetupState.NOT_LOGGED_IN
        assert any("claude /login" in r for r in s.recommendations)

    def test_ready_when_everything_set(self):
        ctxs = _mock_probes(
            docker_installed=True, docker_running=True,
            claude_cli=True, claude_logged=True,
        )
        with ctxs[0], ctxs[1], ctxs[2], ctxs[3], ctxs[4], ctxs[5]:
            s = check_agent_setup()
        assert s.state == SetupState.READY
        assert s.is_container_ready() is True
        # Empty recs when ready
        assert s.recommendations == []

    def test_ready_when_only_codex_logged_in(self):
        # Either CLI logged in is sufficient — user picks their backend.
        ctxs = _mock_probes(
            docker_installed=True, docker_running=True,
            claude_cli=False, claude_logged=False,
            codex_cli=True, codex_logged=True,
        )
        with ctxs[0], ctxs[1], ctxs[2], ctxs[3], ctxs[4], ctxs[5]:
            s = check_agent_setup()
        assert s.state == SetupState.READY


class TestRecommendations:
    """Recommendations should be paste-ready and ordered by impact."""

    def test_no_cli_installed_suggests_install(self):
        ctxs = _mock_probes(docker_installed=True, docker_running=True)
        with ctxs[0], ctxs[1], ctxs[2], ctxs[3], ctxs[4], ctxs[5]:
            s = check_agent_setup()
        assert any("npm install" in r for r in s.recommendations)

    def test_cli_installed_no_login_suggests_login(self):
        ctxs = _mock_probes(
            docker_installed=True, docker_running=True,
            claude_cli=True, claude_logged=False,
        )
        with ctxs[0], ctxs[1], ctxs[2], ctxs[3], ctxs[4], ctxs[5]:
            s = check_agent_setup()
        login_recs = [r for r in s.recommendations if "/login" in r]
        assert len(login_recs) == 1


class TestIsContainerReady:
    def test_true_when_docker_up_and_logged_in(self):
        ctxs = _mock_probes(
            docker_installed=True, docker_running=True,
            claude_cli=True, claude_logged=True,
        )
        with ctxs[0], ctxs[1], ctxs[2], ctxs[3], ctxs[4], ctxs[5]:
            s = check_agent_setup()
        assert s.is_container_ready() is True

    def test_false_when_docker_down(self):
        ctxs = _mock_probes(
            docker_installed=True, docker_running=False,
            claude_cli=True, claude_logged=True,
        )
        with ctxs[0], ctxs[1], ctxs[2], ctxs[3], ctxs[4], ctxs[5]:
            s = check_agent_setup()
        assert s.is_container_ready() is False
