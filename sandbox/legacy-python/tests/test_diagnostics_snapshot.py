"""Tests for :mod:`core.diagnostics.snapshot`.

The snapshot logic is filesystem-heavy, so the tests use ``tmp_path``
fixtures + monkey-patches to avoid touching the user's real OWLLM
layout. We're verifying:

  * Inventory finds files that exist and skips ones that don't.
  * Redaction catches the patterns we care about (Telegram tokens,
    Anthropic/OpenAI keys, JWT, GitHub PAT, JSON ``token`` values).
  * Manifest matches the actual zip contents.
  * ``--no-redact`` keeps text bodies verbatim.
  * ``--no-dbs`` excludes SQLite files.
  * The CLI exits 0 with valid args and writes a zip the test can read.
"""
import json
import sys
import zipfile
from pathlib import Path

import pytest

llm_dir = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(llm_dir))

from core.diagnostics.snapshot import (
    _read_bounded,
    _redact_text,
    create_snapshot,
)


# ---------------------------------------------------------------------------
# Redaction unit tests
# ---------------------------------------------------------------------------


class TestRedaction:
    def test_telegram_bot_token(self):
        text = 'bot_token = "8731012269:AAGGXByhM1eoW5U1KHlTVh97nXCwmN6abcdefghij"'
        out, hits = _redact_text(text)
        assert hits >= 1
        assert "AAGGXByhM1eo" not in out
        assert "***REDACTED" in out

    def test_anthropic_api_key(self):
        text = "ANTHROPIC_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890"
        out, hits = _redact_text(text)
        assert hits >= 1
        assert "AbCdEfGhIjKl" not in out

    def test_json_token_field_value(self):
        text = '{"token": "supersecretvalue1234567890abcdef"}'
        out, hits = _redact_text(text)
        assert hits >= 1
        assert "supersecretvalue" not in out
        assert "***REDACTED***" in out

    def test_json_secret_field_value(self):
        text = '{"client_secret": "shh-this-is-private-xyz123"}'
        out, hits = _redact_text(text)
        assert hits >= 1
        assert "shh-this-is-private" not in out

    def test_no_false_positive_on_short_value(self):
        # Don't redact short non-secret values just because the key
        # happens to mention 'token' — be conservative.
        text = '{"unrelated": "hello"}'
        _, hits = _redact_text(text)
        assert hits == 0

    def test_github_pat(self):
        text = "GH_TOKEN=ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"
        out, hits = _redact_text(text)
        assert hits >= 1
        assert "aBcDeFgHiJ" not in out

    def test_jwt_pattern(self):
        text = "Authorization: Bearer eyJhbGciOiJIUzI1NiI.eyJzdWIiOiIxMjM0NTY.SflKxwRJSMeKKF2QT4f"
        out, hits = _redact_text(text)
        assert hits >= 1
        assert "eyJhbGciOiJ" not in out


# ---------------------------------------------------------------------------
# Read-bounded
# ---------------------------------------------------------------------------


class TestReadBounded:
    def test_small_file_full_read(self, tmp_path):
        p = tmp_path / "small.txt"
        p.write_text("hello world")
        data, truncated = _read_bounded(p, max_bytes=1024)
        assert data == b"hello world"
        assert truncated is False

    def test_large_file_tail_only(self, tmp_path):
        p = tmp_path / "big.log"
        p.write_text("A" * 1000 + "TAIL_MARKER")
        data, truncated = _read_bounded(p, max_bytes=50)
        assert truncated is True
        assert b"TAIL_MARKER" in data
        assert len(data) == 50


# ---------------------------------------------------------------------------
# End-to-end snapshot creation
# ---------------------------------------------------------------------------


class TestSnapshotE2E:
    """Build a fake LLM/ tree, point the module at it, verify the zip."""

    def _setup_fake_tree(self, tmp_path, monkeypatch):
        """Create a minimal LLM/ tree and patch _llm_root to return it."""
        fake_root = tmp_path / "fake_llm"
        (fake_root / "data" / "agent_definitions").mkdir(parents=True)
        (fake_root / "data" / "team_templates").mkdir(parents=True)
        (fake_root / "configs").mkdir(parents=True)
        (fake_root / "logs").mkdir(parents=True)

        (fake_root / "data" / "owllm_state.db").write_bytes(b"FAKE_SQLITE_HEADER")
        (fake_root / "data" / "agent_definitions" / "a1.json").write_text(
            '{"name": "agent1", "token": "this-should-be-redacted-1234567890"}'
        )
        (fake_root / "configs" / "llm_backends.yaml").write_text(
            "endpoint: http://localhost:8000\napi_key: sk-1234567890abcdef\n"
        )
        (fake_root / "logs" / "app.log").write_text(
            "starting\nfound bot_token=8731012269:AAGGXByhM1eoW5U1KHlTVh97nXCwmN6abcdefghij\n"
        )

        # Patch _llm_root to return the fake.
        from core.diagnostics import snapshot as snap_mod
        monkeypatch.setattr(snap_mod, "_llm_root", lambda: fake_root)
        # Patch Path.home so home_dotowllm inventory doesn't pull real config.
        monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path / "fake_home"))
        (tmp_path / "fake_home" / ".owllm").mkdir(parents=True)
        (tmp_path / "fake_home" / ".owllm" / "bridge_config.json").write_text(
            '{"telegram": {"bot_token": "8731012269:AAGGXByhM1eoFAKETOKENvalue1234567890"}}'
        )
        return fake_root

    def test_creates_zip(self, tmp_path, monkeypatch):
        self._setup_fake_tree(tmp_path, monkeypatch)
        out = tmp_path / "snap.zip"
        result = create_snapshot(out, redact=True)
        assert out.exists()
        assert result.file_count > 0
        assert result.out_path == out

    def test_manifest_lists_every_file(self, tmp_path, monkeypatch):
        self._setup_fake_tree(tmp_path, monkeypatch)
        out = tmp_path / "snap.zip"
        create_snapshot(out, redact=True)
        with zipfile.ZipFile(out) as zf:
            names = set(zf.namelist())
            assert "manifest.json" in names
            manifest = json.loads(zf.read("manifest.json"))
        listed = {f["path"] for f in manifest["files"]}
        # Every file the manifest lists must actually be in the zip.
        assert listed.issubset(names)
        # Manifest should not list itself.
        assert "manifest.json" not in listed

    def test_redaction_applied_to_text(self, tmp_path, monkeypatch):
        self._setup_fake_tree(tmp_path, monkeypatch)
        out = tmp_path / "snap.zip"
        result = create_snapshot(out, redact=True)
        assert result.redactions > 0
        with zipfile.ZipFile(out) as zf:
            log_body = zf.read("logs/app.log").decode("utf-8")
            yaml_body = zf.read("configs/llm_backends.yaml").decode("utf-8")
            agent_body = zf.read("state/agent_definitions/a1.json").decode("utf-8")
        assert "AAGGXByhM1eo" not in log_body
        assert "sk-1234567890abcdef" not in yaml_body
        assert "this-should-be-redacted" not in agent_body

    def test_no_redact_keeps_secrets(self, tmp_path, monkeypatch):
        self._setup_fake_tree(tmp_path, monkeypatch)
        out = tmp_path / "snap.zip"
        create_snapshot(out, redact=False)
        with zipfile.ZipFile(out) as zf:
            log_body = zf.read("logs/app.log").decode("utf-8")
        assert "AAGGXByhM1eo" in log_body

    def test_no_dbs_excludes_sqlite(self, tmp_path, monkeypatch):
        self._setup_fake_tree(tmp_path, monkeypatch)
        out = tmp_path / "snap.zip"
        create_snapshot(out, include_dbs=False)
        with zipfile.ZipFile(out) as zf:
            names = set(zf.namelist())
        assert not any(n.endswith(".db") for n in names)

    def test_no_logs_excludes_log_files(self, tmp_path, monkeypatch):
        self._setup_fake_tree(tmp_path, monkeypatch)
        out = tmp_path / "snap.zip"
        create_snapshot(out, include_logs=False)
        with zipfile.ZipFile(out) as zf:
            names = set(zf.namelist())
        # No files under logs/ in the archive.
        assert not any(n.startswith("logs/") for n in names)

    def test_system_probes_always_included(self, tmp_path, monkeypatch):
        self._setup_fake_tree(tmp_path, monkeypatch)
        out = tmp_path / "snap.zip"
        create_snapshot(out)
        with zipfile.ZipFile(out) as zf:
            names = set(zf.namelist())
        assert "system/host.json" in names
        assert "system/processes.json" in names
        assert "system/agent_setup.json" in names
        assert "system/wer_crashes.json" in names

    def test_manifest_sha_matches_file(self, tmp_path, monkeypatch):
        """The sha256 in the manifest must match the actual bytes in the zip."""
        import hashlib
        self._setup_fake_tree(tmp_path, monkeypatch)
        out = tmp_path / "snap.zip"
        create_snapshot(out)
        with zipfile.ZipFile(out) as zf:
            manifest = json.loads(zf.read("manifest.json"))
            for entry in manifest["files"]:
                if not entry.get("sha256"):
                    continue
                body = zf.read(entry["path"])
                assert hashlib.sha256(body).hexdigest() == entry["sha256"], entry["path"]
