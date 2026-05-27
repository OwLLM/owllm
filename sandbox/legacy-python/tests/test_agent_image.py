"""Tests for ``core.agents.agent_image``.

Cover the cache-hit fast path, the build-on-miss slow path, and error
paths. Docker is fully mocked — no real builds, no network.
"""
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.agents.agent_image import (
    AGENT_IMAGE_REPO,
    AgentImageError,
    agent_image_tag,
    dockerfile_path,
    ensure_agent_image,
)


class TestDockerfileLocation:
    def test_dockerfile_exists_at_shipped_path(self):
        # The shipped Dockerfile must be present on disk — it's the
        # canonical recipe consumers rebuild from.
        assert dockerfile_path().is_file()

    def test_tag_is_content_hashed(self):
        tag = agent_image_tag()
        assert tag.startswith(f"{AGENT_IMAGE_REPO}:")
        # Content hash is 12 hex chars
        suffix = tag.split(":", 1)[1]
        assert len(suffix) == 12
        assert all(c in "0123456789abcdef" for c in suffix)

    def test_tag_changes_when_dockerfile_changes(self, tmp_path):
        a = tmp_path / "Dockerfile.a"
        a.write_text("FROM scratch\n")
        b = tmp_path / "Dockerfile.b"
        b.write_text("FROM scratch\nRUN true\n")
        assert agent_image_tag(a) != agent_image_tag(b)


class TestEnsureAgentImage:
    def test_cache_hit_skips_build(self, tmp_path):
        # docker image inspect returns 0 → no build needed.
        with patch(
            "core.agents.agent_image.shutil.which", return_value="/usr/bin/docker",
        ), patch(
            "core.agents.agent_image._docker_inspect_image", return_value=True,
        ), patch(
            "core.agents.agent_image._docker_build",
        ) as build:
            tag = ensure_agent_image()
        assert tag.startswith(f"{AGENT_IMAGE_REPO}:")
        build.assert_not_called()

    def test_cache_miss_triggers_build(self):
        with patch(
            "core.agents.agent_image.shutil.which", return_value="/usr/bin/docker",
        ), patch(
            "core.agents.agent_image._docker_inspect_image", return_value=False,
        ), patch(
            "core.agents.agent_image._docker_build", return_value=None,
        ) as build:
            tag = ensure_agent_image()
        assert tag.startswith(f"{AGENT_IMAGE_REPO}:")
        build.assert_called_once()
        # Tag passed to build must match the returned tag.
        called_tag = build.call_args.args[0]
        assert called_tag == tag

    def test_no_docker_raises(self):
        with patch(
            "core.agents.agent_image.shutil.which", return_value=None,
        ):
            with pytest.raises(AgentImageError):
                ensure_agent_image()

    def test_build_failure_propagates(self):
        with patch(
            "core.agents.agent_image.shutil.which", return_value="/usr/bin/docker",
        ), patch(
            "core.agents.agent_image._docker_inspect_image", return_value=False,
        ), patch(
            "core.agents.agent_image._docker_build",
            side_effect=AgentImageError("build failed"),
        ):
            with pytest.raises(AgentImageError):
                ensure_agent_image()
