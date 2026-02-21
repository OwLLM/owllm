#!/usr/bin/env python3
"""
Strict Windows GGUF E2E proof gate:
load -> health -> inference -> restart -> inference.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

# Add parent directory to path for direct test execution.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from LLM.core.inference_client import InferenceClient
from LLM.core.llm_server_manager import LLMServerManager
from LLM.core.state_store import get_state_store


def _artifacts_dir(model_id: str) -> Path:
    safe_model = model_id.replace("/", "__").replace("\\", "__")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    out = Path(__file__).parent.parent / "logs" / "e2e_proof" / f"{safe_model}_{stamp}"
    out.mkdir(parents=True, exist_ok=True)
    return out


def _write_text(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8", errors="replace")


def _write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=True), encoding="utf-8", errors="replace")


def _capture_windows_snapshots(out_dir: Path, port: int) -> None:
    if sys.platform != "win32":
        return
    for name, cmd in (
        ("tasklist.txt", ["tasklist"]),
        ("netstat.txt", ["netstat", "-ano"]),
        ("netstat_port.txt", ["netstat", "-ano", "-p", "TCP"]),
    ):
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            _write_text(out_dir / name, (proc.stdout or "") + "\n" + (proc.stderr or ""))
        except Exception as e:
            _write_text(out_dir / f"{name}.error.txt", str(e))
    _write_text(out_dir / "target_port.txt", str(port))


def _snapshot_state(model_id: str, out_dir: Path) -> None:
    store = get_state_store()
    payload = {
        "server": store.get_server(model_id),
        "onboarding": store.get_onboarding(model_id),
        "model": store.get_model(model_id),
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
    }
    _write_json(out_dir / "state_snapshot.json", payload)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only GGUF proof gate")
def test_gguf_e2e_windows_proof_gate():
    model_id = os.getenv("GGUF_TEST_MODEL_ID", "").strip()
    if not model_id:
        pytest.skip("Set GGUF_TEST_MODEL_ID to run strict Windows GGUF E2E proof gate.")
    _run_proof_gate_for_model(model_id)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only GGUF proof gate")
def test_gguf_e2e_windows_proof_gate_unsupported():
    model_id = os.getenv("GGUF_TEST_MODEL_ID_UNSUPPORTED", "").strip()
    if not model_id:
        pytest.skip("Set GGUF_TEST_MODEL_ID_UNSUPPORTED to run unsupported-family proof gate.")
    _run_proof_gate_for_model(model_id)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only GGUF proof gate")
def test_gguf_e2e_windows_proof_gate_baseline():
    model_id = os.getenv("GGUF_TEST_MODEL_ID_BASELINE", "").strip()
    if not model_id:
        pytest.skip("Set GGUF_TEST_MODEL_ID_BASELINE to run baseline GGUF proof gate.")
    _run_proof_gate_for_model(model_id)


def _run_proof_gate_for_model(model_id: str) -> None:

    config_path = Path(__file__).parent.parent / "configs" / "llm_backends.yaml"
    manager = LLMServerManager(config_path)
    out_dir = _artifacts_dir(model_id)
    metrics = {
        "model_id": model_id,
        "started_utc": datetime.now(timezone.utc).isoformat(),
    }
    failure_reason = None
    server_port = 0

    _snapshot_state(model_id, out_dir)
    try:
        # Preflight
        cfg = manager.config.get("models", {}).get(model_id, {})
        base_model = cfg.get("base_model", "")
        model_path = Path(base_model)
        assert model_path.exists(), f"Configured model path missing: {model_path}"
        ggufs = list(model_path.rglob("*.gguf")) if model_path.is_dir() else ([] if model_path.suffix.lower() != ".gguf" else [model_path])
        assert ggufs, f"No GGUF files found under {model_path}"
        _write_json(out_dir / "preflight.json", {"base_model": str(model_path), "gguf_files": [str(p) for p in ggufs]})

        # Start + health + inference
        t0 = time.time()
        server_url = manager.ensure_server_running(model_id)
        metrics["startup_seconds"] = round(time.time() - t0, 3)
        client = InferenceClient(server_url)
        assert client.health_check(), "Health check failed after startup"

        t1 = time.time()
        first = client.generate("Reply with exactly: E2E_OK", max_new_tokens=32, temperature=0.0)
        metrics["first_inference_seconds"] = round(time.time() - t1, 3)
        assert isinstance(first, str) and first.strip(), "Inference response was empty on first run"
        _write_text(out_dir / "first_inference.txt", first)

        # Restart + health + inference again
        manager.shutdown_server(model_id)
        time.sleep(2.0)
        t2 = time.time()
        server_url_2 = manager.ensure_server_running(model_id)
        metrics["restart_startup_seconds"] = round(time.time() - t2, 3)
        client2 = InferenceClient(server_url_2)
        assert client2.health_check(), "Health check failed after restart"

        t3 = time.time()
        second = client2.generate("Reply with exactly: E2E_OK_RESTART", max_new_tokens=32, temperature=0.0)
        metrics["second_inference_seconds"] = round(time.time() - t3, 3)
        assert isinstance(second, str) and second.strip(), "Inference response was empty after restart"
        _write_text(out_dir / "second_inference.txt", second)
    except Exception as e:
        failure_reason = str(e)
        raise
    finally:
        metrics["finished_utc"] = datetime.now(timezone.utc).isoformat()
        if failure_reason:
            metrics["failure_reason"] = failure_reason
        _write_json(out_dir / "metrics.json", metrics)
        _snapshot_state(model_id, out_dir)
        try:
            server = get_state_store().get_server(model_id) or {}
            server_port = int(server.get("port") or 0)
        except Exception:
            server_port = 0
        _capture_windows_snapshots(out_dir, server_port)
        manager.shutdown_server(model_id)
