import sys
from pathlib import Path

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.runtime.self_heal_orchestrator import SelfHealOrchestrator


class _FakeEnvRegistry:
    def __init__(self):
        self.installed = []
        self.probe_calls = 0

    def auto_install_missing_packages(self, python_exe, packages, log_callback=None):
        self.installed.extend(packages)
        return True, ""

    def run_model_load_probe(self, python_exe, model_path, adapter_dir=None, log_callback=None):
        self.probe_calls += 1
        return True, None, None


class _FakeRuntimeBundle:
    def __init__(self, ok=True):
        self.ok = ok
        self.calls = 0

    def ensure_gguf_runtime(self, python_exe, log_callback=None):
        self.calls += 1
        return self.ok, "" if self.ok else "runtime install failed"


def test_normalize_failure_maps_categories():
    orch = SelfHealOrchestrator(max_attempts=1)
    out = orch.normalize_failure("MISSING_PACKAGE", "No module named 'llama_cpp'")
    assert out["category"] == "RUNTIME_MISSING_COMPONENT"


def test_try_repair_probe_failure_installs_and_recovers():
    orch = SelfHealOrchestrator(max_attempts=1)
    fake = _FakeEnvRegistry()
    ok, reason, err = orch.try_repair_probe_failure(
        env_registry=fake,
        python_exe=Path(sys.executable),
        model_path="C:/tmp/model",
        adapter_dir=None,
        reason_code="MISSING_PACKAGE",
        error_message="No module named 'llama_cpp'",
        log_callback=None,
    )
    assert ok is True
    assert reason is None
    assert err is None
    assert "llama-cpp-python" in fake.installed
    assert fake.probe_calls == 1


def test_try_repair_probe_failure_prefers_runtime_bundle_for_gguf(tmp_path):
    model_dir = tmp_path / "gguf_model"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "x.gguf").write_bytes(b"GGUF" + (b"\x00" * 2048))

    orch = SelfHealOrchestrator(max_attempts=1)
    fake = _FakeEnvRegistry()
    fake.runtime_bundle_manager = _FakeRuntimeBundle(ok=True)

    ok, reason, err = orch.try_repair_probe_failure(
        env_registry=fake,
        python_exe=Path(sys.executable),
        model_path=str(model_dir),
        adapter_dir=None,
        reason_code="RUNTIME_MISSING_COMPONENT",
        error_message="llama_cpp unavailable",
        log_callback=None,
    )
    assert ok is True
    assert reason is None
    assert err is None
    assert fake.runtime_bundle_manager.calls == 1

