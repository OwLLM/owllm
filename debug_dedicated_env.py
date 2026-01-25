#!/usr/bin/env python3
"""
Debug script to check if the dedicated environment has torch installed.
"""
import sys
import os
from pathlib import Path

# Add LLM to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'LLM'))

from core.envs.env_registry import EnvRegistry
from core.state_store import StateStore

def main():
    workspace_root = Path(__file__).parent.resolve()
    llm_root = workspace_root / "LLM"
    
    # Ensure db directory exists
    db_dir = llm_root / "db"
    db_dir.mkdir(exist_ok=True)
    
    state_store = StateStore(llm_root)
    env_registry = EnvRegistry(llm_root, state_store)
    
    # Find the dedicated environment for the GPTQ model
    model_id = "TheBloke/deepseek-coder-33B-instruct-GPTQ"
    
    # Check state store for onboarding record
    onboarding = state_store.get_onboarding(model_id)
    if not onboarding:
        print(f"[FAIL] No onboarding record found for {model_id}")
        return
    
    env_key = onboarding.get("env_key")
    print(f"[OK] Found onboarding record")
    print(f"     env_key: {env_key}")
    print(f"     status: {onboarding.get('status')}")
    print(f"     last_error: {onboarding.get('last_error', 'None')[:500]}")
    
    if not env_key:
        print(f"[FAIL] No env_key in onboarding record")
        return
    
    # Check if environment exists
    python_exe = env_registry._get_env_python_executable(env_key)
    print(f"\n[OK] Python executable path: {python_exe}")
    print(f"     exists: {python_exe.exists() if python_exe else False}")
    
    if not python_exe or not python_exe.exists():
        print(f"[FAIL] Python executable not found")
        return
    
    # Check for torch
    print(f"\n[OK] Checking for torch in {env_key}...")
    missing = env_registry.check_missing_packages(python_exe, ["torch", "transformers", "optimum", "auto-gptq"])
    
    print(f"     torch: {'[MISSING]' if 'torch' in missing else '[OK]'}")
    print(f"     transformers: {'[MISSING]' if 'transformers' in missing else '[OK]'}")
    print(f"     optimum: {'[MISSING]' if 'optimum' in missing else '[OK]'}")
    print(f"     auto-gptq: {'[MISSING]' if 'auto-gptq' in missing else '[OK]'}")
    
    if 'torch' in missing:
        print(f"\n[FAIL] TORCH IS MISSING IN DEDICATED ENVIRONMENT!")
        print(f"       This is the bug - the dedicated env should have torch from the base env.")
    
    # Check the base environment too
    if "--dedicated--" in env_key:
        base_env_key = env_key.split("--dedicated--")[0]
        print(f"\n[OK] Checking base environment: {base_env_key}")
        base_python_exe = env_registry._get_env_python_executable(base_env_key)
        print(f"     base python exe: {base_python_exe}")
        print(f"     exists: {base_python_exe.exists() if base_python_exe else False}")
        
        if base_python_exe and base_python_exe.exists():
            base_missing = env_registry.check_missing_packages(base_python_exe, ["torch", "transformers"])
            print(f"     torch in base: {'[MISSING]' if 'torch' in base_missing else '[OK]'}")
            print(f"     transformers in base: {'[MISSING]' if 'transformers' in base_missing else '[OK]'}")

if __name__ == "__main__":
    main()
