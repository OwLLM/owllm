"""
PHASE 3: pytest test suite for environment health checks.
"""
import pytest
import sys
from pathlib import Path

# Add LLM to path
llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))


@pytest.fixture
def env_registry():
    """Get EnvRegistry instance"""
    from core.envs.env_registry import EnvRegistry
    return EnvRegistry()


@pytest.fixture
def state_store():
    """Get StateStore instance"""
    from core.state_store import get_state_store
    return get_state_store()


def test_env_registry_initialization(env_registry):
    """Test that EnvRegistry initializes correctly"""
    assert env_registry is not None
    assert env_registry.envs_dir.exists()
    assert env_registry.constraints_dir.exists()


def test_env_key_resolver():
    """Test environment key resolution"""
    from core.envs.env_key_resolver import EnvKeyResolver
    
    resolver = EnvKeyResolver()
    
    # Test basic resolution
    env_key = resolver.resolve_env_key(
        backend="transformers",
        use_quantization=True
    )
    
    assert env_key is not None
    assert "torch" in env_key
    assert "transformers" in env_key
    
    # Test parsing
    parsed = resolver.parse_env_key(env_key)
    assert parsed["backend"] == "transformers"


@pytest.mark.skipif(not Path(__file__).parent.parent / ".envs", reason="No environments created yet")
def test_existing_envs_health(env_registry, state_store):
    """Test health of existing environments"""
    # Get all environments from StateStore
    envs = state_store.list_envs(status="READY")
    
    if not envs:
        pytest.skip("No ready environments found")
    
    for env in envs:
        env_key = env["env_key"]
        python_exe = env_registry._get_env_python_executable(env_key)
        
        if python_exe and python_exe.exists():
            profile_data = env_registry._get_active_profile_data()
            health_ok = env_registry._health_check_env(python_exe, profile_data)
            
            assert health_ok, f"Environment {env_key} failed health check"


def test_env_key_display_name():
    """Test environment key display name generation"""
    from core.envs.env_key_resolver import EnvKeyResolver
    
    resolver = EnvKeyResolver()
    
    # Test various env keys
    test_cases = [
        ("torch-cu121-transformers-bnb", "Transformers + Quantization (CUDA 12.1)"),
        ("torch-cu124-transformers", "Transformers (CUDA 12.4)"),
        ("torch-cpu-transformers", "Transformers (CPU)"),
        ("vllm-cu121", "vLLM (CUDA 12.1)"),
    ]
    
    for env_key, expected_substr in test_cases:
        display = resolver.get_env_key_display_name(env_key)
        assert expected_substr in display or display.startswith(expected_substr.split()[0])


@pytest.mark.gpu
@pytest.mark.skipif(sys.platform != "win32" or not Path("C:/Program Files/NVIDIA Corporation/NVSMI/nvidia-smi.exe").exists(),
                    reason="GPU not available")
def test_cuda_torch_in_gpu_env(env_registry):
    """Test that GPU environments have CUDA torch"""
    profile_data = env_registry._get_active_profile_data()
    
    if not profile_data:
        pytest.skip("No profile data available")
    
    torch_spec = str(profile_data.get("packages", {}).get("torch", ""))
    if "+cu" not in torch_spec:
        pytest.skip("CPU profile detected")
    
    # Get any CUDA env
    envs = env_registry.state_store.list_envs(status="READY")
    cuda_envs = [e for e in envs if "cu" in e["env_key"] and e["env_key"] != "cpu"]
    
    if not cuda_envs:
        pytest.skip("No CUDA environments found")
    
    for env in cuda_envs:
        python_exe = env_registry._get_env_python_executable(env["env_key"])
        if python_exe and python_exe.exists():
            torch_ver, cuda_ok = env_registry._get_torch_info(python_exe)
            assert "+cu" in torch_ver, f"Environment {env['env_key']} has CPU torch: {torch_ver}"
            assert cuda_ok, f"Environment {env['env_key']} has torch but CUDA not available"


def test_is_torch_vcredist_failure_detection(env_registry):
    """_is_torch_vcredist_failure identifies VC++/DLL-related torch import failures (Windows)."""
    # Positive: WinError 126
    assert env_registry._is_torch_vcredist_failure("winerror 126: the specified module could not be found")
    assert env_registry._is_torch_vcredist_failure("OSError: [WinError 126]")
    # Positive: generic DLL not found
    assert env_registry._is_torch_vcredist_failure("the specified module could not be found")
    # Positive: torch _load_dll_libraries
    assert env_registry._is_torch_vcredist_failure(
        "File \"...\\torch\\__init__.py\", line 245, in _load_dll_libraries"
    )
    # Negative: other errors
    assert not env_registry._is_torch_vcredist_failure("winerror 1455 paging file")
    assert not env_registry._is_torch_vcredist_failure("No module named 'foo'")
    assert not env_registry._is_torch_vcredist_failure("")
    assert not env_registry._is_torch_vcredist_failure("CUDA out of memory")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
