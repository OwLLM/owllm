import subprocess
import sys
from pathlib import Path

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.runtime.runtime_bundle_manager import RuntimeBundleManager


def _cp(returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(args=["x"], returncode=returncode, stdout=stdout, stderr=stderr)


def test_ensure_gguf_runtime_already_ready(monkeypatch):
    mgr = RuntimeBundleManager()
    calls = {"pip": 0}

    def fake_run_python(python_exe, code, timeout=30):
        return _cp(0, "OK\n", "")

    def fake_run_pip(python_exe, args, timeout=300):
        calls["pip"] += 1
        return _cp(0, "", "")

    monkeypatch.setattr(mgr, "_run_python", fake_run_python)
    monkeypatch.setattr(mgr, "_run_pip", fake_run_pip)
    monkeypatch.setattr(mgr, "_llama_version_ok", lambda *_args, **_kwargs: (True, "0.3.16", "0.3.2"))

    ok, err = mgr.ensure_gguf_runtime(Path(sys.executable))
    assert ok is True
    assert err == ""
    assert calls["pip"] == 0


def test_ensure_gguf_runtime_fails_when_no_backend(monkeypatch):
    mgr = RuntimeBundleManager()

    def fake_run_python(python_exe, code, timeout=30):
        if "from ctransformers import AutoModelForCausalLM" in code:
            return _cp(1, "", "no ctransformers")
        return _cp(1, "", "no llama_cpp")

    def fake_run_pip(python_exe, args, timeout=300):
        return _cp(1, "", "pip failed")

    monkeypatch.setattr(mgr, "_run_python", fake_run_python)
    monkeypatch.setattr(mgr, "_run_pip", fake_run_pip)
    monkeypatch.setattr(mgr, "_llama_version_ok", lambda *_args, **_kwargs: (False, None, "0.3.2"))

    ok, err = mgr.ensure_gguf_runtime(Path(sys.executable))
    assert ok is False
    assert "GGUF runtime missing required backend components" in err

