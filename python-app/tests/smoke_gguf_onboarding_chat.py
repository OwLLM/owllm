"""
Smoke script: onboarding -> chat flow for a GGUF fixture.
Run from repo root: python -m LLM.tests.smoke_gguf_onboarding_chat
Skips if no GGUF fixture found (tests/fixtures/gguf_smoke/*.gguf or env LLM_GGUF_SMOKE_PATH).
"""
import os
import sys
from pathlib import Path

llm_dir = Path(__file__).resolve().parent.parent
if str(llm_dir) not in sys.path:
    sys.path.insert(0, str(llm_dir))


def _find_gguf_fixture() -> Path | None:
    fixtures = llm_dir / "tests" / "fixtures" / "gguf_smoke"
    env_path = os.environ.get("LLM_GGUF_SMOKE_PATH", "").strip()
    if env_path and Path(env_path).exists():
        p = Path(env_path)
        if p.suffix.lower() == ".gguf":
            return p
        if p.is_dir():
            for f in p.rglob("*.gguf"):
                return f
        return None
    if fixtures.exists():
        for f in fixtures.rglob("*.gguf"):
            return f
    return None


def main() -> int:
    gguf_path = _find_gguf_fixture()
    if not gguf_path:
        print("SKIP: No GGUF fixture (set LLM_GGUF_SMOKE_PATH or add tests/fixtures/gguf_smoke/*.gguf)")
        return 0
    model_dir = gguf_path.parent if gguf_path.suffix.lower() == ".gguf" else gguf_path
    print(f"GGUF fixture: {gguf_path}")

    from core.envs.capability_matrix import (
        resolve_capability,
        get_runtime_required_packages,
        get_runtime_fallback_packages,
    )
    cap = resolve_capability(str(model_dir), model_cfg={}, adapter_dir=None, model_id=None)
    assert cap.get("profile_id") == "llamacpp", cap
    required = get_runtime_required_packages(str(model_dir), model_cfg={}, adapter_dir=None, model_id=None)
    fallback = get_runtime_fallback_packages(str(model_dir), model_cfg={}, adapter_dir=None, model_id=None)
    print(f"  profile_id={cap['profile_id']}, required={required}, fallback={fallback}")

    # Minimal probe: optional import of llama_cpp (no real load)
    try:
        import llama_cpp
        print("  llama_cpp import: OK")
    except ImportError:
        print("  llama_cpp import: skipped (not installed)")

    print("PASS: GGUF smoke (capability + optional import)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
