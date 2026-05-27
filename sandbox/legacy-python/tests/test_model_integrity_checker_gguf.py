"""
Unit tests for GGUF integrity checks.
"""
import json
import sys
from pathlib import Path

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from model_integrity_checker import ModelIntegrityChecker


def _write_gguf(path: Path, valid_header: bool = True, size_bytes: int = 1024 * 1024 + 16) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    header = b"GGUF" if valid_header else b"BAD!"
    body_len = max(0, size_bytes - len(header))
    path.write_bytes(header + (b"\x00" * body_len))


def test_gguf_valid_file_is_complete(tmp_path):
    model_dir = tmp_path / "my_model"
    _write_gguf(model_dir / "model.Q4_K_M.gguf", valid_header=True)

    status = ModelIntegrityChecker().check_model(model_dir)
    assert status.is_complete is True
    assert status.missing_files == []


def test_gguf_active_variant_missing_is_incomplete(tmp_path):
    model_dir = tmp_path / "my_model"
    _write_gguf(model_dir / "existing.gguf", valid_header=True)
    (model_dir / ".selected_weights.json").write_text(
        json.dumps({"active_variant": "missing.gguf"}),
        encoding="utf-8",
    )

    status = ModelIntegrityChecker().check_model(model_dir)
    assert status.is_complete is False
    assert any("selected gguf missing" in item for item in status.missing_files)


def test_gguf_invalid_header_is_incomplete(tmp_path):
    model_dir = tmp_path / "my_model"
    _write_gguf(model_dir / "broken.gguf", valid_header=False)

    status = ModelIntegrityChecker().check_model(model_dir)
    assert status.is_complete is False
    assert any("invalid gguf file" in item for item in status.missing_files)
