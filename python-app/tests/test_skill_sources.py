"""Tests for the skill-source registry: aliases, body preview, install detection.

The actual git-clone path (fetch_source) is exercised opportunistically in
manual smoke runs — pinning a network test to a moving GitHub repo would
make CI flaky. This file covers the pure-Python helpers that don't need
the network.
"""
import sys
from pathlib import Path

import pytest

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.agents.skill_sources import (
    ALIAS_MAP,
    KNOWN_SOURCES,
    SkillSource,
    _rewrite_tool_aliases,
    alias_tool_name,
    custom_source_from_url,
    is_skill_installed,
    read_skill_body,
)


# ---------------------------------------------------------------------------
# alias_tool_name
# ---------------------------------------------------------------------------


class TestAliasMap:
    @pytest.mark.parametrize("anthropic_name,owllm_name", [
        ("Read", "read_file"),
        ("Write", "write_file_with_diff"),
        ("Edit", "edit_file"),
        ("MultiEdit", "edit_file"),
        ("Bash", "shell"),
        ("LS", "list_dir"),
        ("Glob", "glob_files"),
        ("Grep", "grep"),
        ("WebFetch", "http_get"),
        ("TodoWrite", "todo_write"),
    ])
    def test_known_aliases_resolve(self, anthropic_name, owllm_name):
        assert alias_tool_name(anthropic_name) == owllm_name

    def test_native_owllm_names_pass_through(self):
        for name in ("read_file", "edit_file", "shell", "grep"):
            assert alias_tool_name(name) == name

    def test_empty_string_passes_through(self):
        assert alias_tool_name("") == ""

    def test_unknown_camelcase_lowercased(self):
        # No known mapping → fall back to lowercase. Better than failing
        # the whole skill load; the runtime drops unknown ids quietly.
        assert alias_tool_name("MysteryTool") == "mysterytool"

    def test_alias_map_covers_anthropic_core(self):
        # If Anthropic adds a tool, this test won't fire — but we want a
        # canary that the well-known set is intact.
        for required in ("Read", "Write", "Edit", "Bash", "Glob", "Grep", "TodoWrite"):
            assert required in ALIAS_MAP


# ---------------------------------------------------------------------------
# _rewrite_tool_aliases — frontmatter-only rewrite
# ---------------------------------------------------------------------------


class TestFrontmatterRewrite:
    def test_rewrites_yaml_list_items(self):
        text = (
            "---\n"
            "name: t\n"
            "tools:\n"
            "  - Read\n"
            "  - Bash\n"
            "  - Edit\n"
            "---\n"
            "\n"
            "Body\n"
        )
        out = _rewrite_tool_aliases(text)
        assert "- read_file" in out
        assert "- shell" in out
        assert "- edit_file" in out
        # Body untouched.
        assert "\nBody\n" in out

    def test_does_not_touch_markdown_body(self):
        text = (
            "---\n"
            "name: t\n"
            "tools:\n"
            "  - Read\n"
            "---\n"
            "\n"
            "Talk about Read and Bash in prose — these stay capitalized.\n"
        )
        out = _rewrite_tool_aliases(text)
        assert "Talk about Read and Bash" in out

    def test_no_frontmatter_returns_unchanged(self):
        text = "Just a markdown file.\n"
        assert _rewrite_tool_aliases(text) == text

    def test_unterminated_frontmatter_returns_unchanged(self):
        text = "---\nname: x\nstuff: y\n"  # no closing ---
        assert _rewrite_tool_aliases(text) == text

    def test_blank_tools_block_handled(self):
        text = "---\nname: t\ntools: []\n---\n\nbody\n"
        # Inline empty list — our walker leaves the line alone (no items
        # to rewrite). Should not crash.
        out = _rewrite_tool_aliases(text)
        assert "tools: []" in out


# ---------------------------------------------------------------------------
# read_skill_body
# ---------------------------------------------------------------------------


class TestReadSkillBody:
    def test_strips_frontmatter(self, tmp_path):
        p = tmp_path / "SKILL.md"
        p.write_text(
            "---\nname: x\ndescription: y\n---\n\n# Body\n\nHello\n",
            encoding="utf-8",
        )
        body = read_skill_body(p)
        assert body.startswith("# Body")
        assert "Hello" in body
        assert "name: x" not in body

    def test_no_frontmatter_returns_full_text(self, tmp_path):
        p = tmp_path / "SKILL.md"
        p.write_text("Plain body\n", encoding="utf-8")
        assert read_skill_body(p).strip() == "Plain body"

    def test_truncates_at_max_chars(self, tmp_path):
        p = tmp_path / "SKILL.md"
        p.write_text("x" * 10_000, encoding="utf-8")
        body = read_skill_body(p, max_chars=100)
        assert "truncated" in body
        # Body length is approximately max_chars + the truncation suffix.
        assert len(body) < 250

    def test_unreadable_file_returns_clean_message(self, tmp_path):
        # Point at a non-existent file.
        body = read_skill_body(tmp_path / "nope.md")
        assert "could not read" in body


# ---------------------------------------------------------------------------
# is_skill_installed
# ---------------------------------------------------------------------------


class TestIsSkillInstalled:
    def test_returns_false_for_missing(self):
        # Random non-existent skill — the installed-skills folder may or
        # may not exist depending on the environment, but this name
        # certainly isn't there.
        assert not is_skill_installed("nonexistent_source", "phantom_skill_xyz_123")

    def test_returns_false_on_empty_relative_dir(self):
        assert not is_skill_installed("any", "")


# ---------------------------------------------------------------------------
# custom_source_from_url
# ---------------------------------------------------------------------------


class TestCustomSource:
    def test_extracts_repo_name(self):
        s = custom_source_from_url("https://github.com/foo/bar.git")
        assert s.key == "bar"
        assert "bar" in s.label
        assert s.git_url == "https://github.com/foo/bar.git"

    def test_strips_trailing_slash_and_dot_git(self):
        s = custom_source_from_url("https://github.com/foo/baz/")
        assert s.key == "baz"

    def test_sanitizes_special_chars_in_key(self):
        s = custom_source_from_url("https://example.org/owner/weird@name")
        # Non-alnum chars in last segment collapse to underscore.
        assert "@" not in s.key
        assert s.git_url.endswith("weird@name")

    def test_handles_blank_url_gracefully(self):
        s = custom_source_from_url("   ")
        # Returns *something* — the caller will fail at clone time, not here.
        assert s.key  # non-empty


# ---------------------------------------------------------------------------
# KNOWN_SOURCES sanity
# ---------------------------------------------------------------------------


class TestKnownSources:
    def test_all_have_required_fields(self):
        for s in KNOWN_SOURCES:
            assert s.key
            assert s.label
            assert s.git_url.startswith(("http://", "https://", "git@"))

    def test_keys_unique(self):
        keys = [s.key for s in KNOWN_SOURCES]
        assert len(keys) == len(set(keys))
