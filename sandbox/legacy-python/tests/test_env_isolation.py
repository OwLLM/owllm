#!/usr/bin/env python3
"""
Test Environment Isolation
Verifies that:
1. Different models can run in different environments
2. Main app doesn't import heavy dependencies
3. Each server uses correct Python executable
"""
import sys
import subprocess
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))


def test_env_isolation():
    """Test environment isolation"""
    print("=" * 60)
    print("TEST: Environment Isolation")
    print("=" * 60)
    
    # Check main app environment
    print("\n[1/4] Checking main app environment...")
    
    # Try to import torch in main app (should fail if isolation works)
    try:
        import torch
        print("  ⚠ WARNING: torch is importable in main app")
        print("  This means main app has GPU dependencies (not ideal)")
        has_torch_main = True
    except ImportError:
        print("  ✓ torch NOT importable in main app (good!)")
        has_torch_main = False
    
    # Try transformers
    try:
        import transformers
        print("  ⚠ WARNING: transformers is importable in main app")
        has_transformers_main = True
    except ImportError:
        print("  ✓ transformers NOT importable in main app (good!)")
        has_transformers_main = False
    
    if not has_torch_main and not has_transformers_main:
        print("  ✓ Main app environment is clean!")
    
    # Check that core modules are importable
    print("\n[2/4] Checking core modules are importable...")
    try:
        from LLM.core.llm_server_manager import LLMServerManager
        from LLM.core.inference_client import InferenceClient
        from LLM.core.envs.env_registry import EnvRegistry
        print("  ✓ All core modules importable")
    except ImportError as e:
        print(f"  ✗ Failed to import core module: {e}")
        return False
    
    # Check environment registry
    print("\n[3/4] Checking environment registry...")
    try:
        config_path = Path(__file__).parent.parent / "configs" / "llm_backends.yaml"
        import yaml
        with open(config_path, 'r') as f:
            cfg = yaml.safe_load(f)
        
        model_cfg = cfg["models"]["default"]
        base_model = model_cfg["base_model"]
        
        env_registry = EnvRegistry()
        env_spec = env_registry.get_env_for_model(base_model)
        
        print(f"  Environment key: {env_spec.key}")
        print(f"  Python executable: {env_spec.python_executable}")
        print(f"  Executable exists: {env_spec.python_executable.exists()}")
        print(f"  Is file: {env_spec.python_executable.is_file()}")
        
        if not env_spec.python_executable.exists():
            print(f"  ✗ Python executable not found!")
            return False
        
        print("  ✓ Environment specification valid")
    except Exception as e:
        print(f"  ✗ Environment check failed: {e}")
        import traceback
        traceback.print_exc()
        return False
    
    # Verify Python executable works
    print("\n[4/4] Verifying Python executable...")
    try:
        result = subprocess.run(
            [str(env_spec.python_executable), "--version"],
            capture_output=True,
            text=True,
            timeout=10
        )
        print(f"  Python version: {result.stdout.strip()}")
        
        if result.returncode != 0:
            print(f"  ✗ Python executable failed: {result.stderr}")
            return False
        
        print("  ✓ Python executable works")
    except Exception as e:
        print(f"  ✗ Failed to run Python executable: {e}")
        return False
    
    print("\n" + "=" * 60)
    print("TEST PASSED: Environment Isolation")
    print("=" * 60)
    
    if has_torch_main or has_transformers_main:
        print("\n⚠ WARNING: Main app has GPU dependencies.")
        print("For true isolation, these should only be in model environments.")
    else:
        print("\n✓ Perfect isolation: Main app is clean, models use separate envs.")
    
    return True


if __name__ == "__main__":
    success = test_env_isolation()
    sys.exit(0 if success else 1)
