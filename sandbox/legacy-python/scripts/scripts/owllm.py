#!/usr/bin/env python3
"""
OWLLM CLI - Command-line interface for environment and model testing.

PHASE 3: Testing & smoke tests for environments, models, and tools.
"""
import sys
import argparse
import json
from pathlib import Path
from typing import Optional

# Add LLM directory to path
llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))


def env_test(env_key: str) -> dict:
    """
    Test environment health.
    
    Args:
        env_key: Environment key to test
    
    Returns:
        Dict with test results
    """
    from core.envs.env_registry import EnvRegistry
    from core.state_store import get_state_store
    
    registry = EnvRegistry()
    state_store = get_state_store()
    
    result = {
        "env_key": env_key,
        "status": "UNKNOWN",
        "python_path": None,
        "torch_version": None,
        "cuda_available": False,
        "errors": []
    }
    
    # Check StateStore
    env_state = state_store.get_env(env_key)
    if env_state:
        result["status"] = env_state["status"]
        result["python_path"] = env_state.get("python_path")
        result["torch_version"] = env_state.get("torch_version")
        
        if env_state.get("last_error"):
            result["errors"].append(env_state["last_error"])
    
    # Check filesystem
    python_exe = registry._get_env_python_executable(env_key)
    if python_exe and python_exe.exists():
        result["python_path"] = str(python_exe)
        
        # Run health check
        profile_data = registry._get_active_profile_data()
        if registry._health_check_env(python_exe, profile_data):
            result["status"] = "PASS"
            
            # Get torch info
            torch_ver, cuda_ok = registry._get_torch_info(python_exe)
            result["torch_version"] = torch_ver
            result["cuda_available"] = cuda_ok
        else:
            result["status"] = "FAIL"
            result["errors"].append("Health check failed")
    else:
        result["status"] = "NOT_FOUND"
        result["errors"].append(f"Python executable not found: {python_exe}")
    
    return result


def model_smoke(model_id: str) -> dict:
    """
    Smoke test for model (start server, test /health and /generate).
    
    Args:
        model_id: Model identifier from config
    
    Returns:
        Dict with test results
    """
    import time
    import requests
    from core.llm_server_manager import get_llm_server_manager
    from core.inference import get_app_root
    
    result = {
        "model_id": model_id,
        "status": "UNKNOWN",
        "server_started": False,
        "health_ok": False,
        "generate_ok": False,
        "errors": []
    }
    
    try:
        # Get server manager
        config_path = get_app_root() / "configs" / "llm_backends.yaml"
        manager = get_llm_server_manager(config_path)
        
        # Start server
        try:
            manager.start_server(model_id)
            result["server_started"] = True
        except Exception as e:
            result["errors"].append(f"Failed to start server: {e}")
            result["status"] = "FAIL"
            return result
        
        # Test /health
        server_url = manager._get_server_url(model_id)
        try:
            response = requests.get(f"{server_url}/health", timeout=5)
            if response.status_code == 200:
                data = response.json()
                if data.get("status") == "ok":
                    result["health_ok"] = True
                else:
                    result["errors"].append(f"Health status: {data.get('status')}")
        except Exception as e:
            result["errors"].append(f"Health check failed: {e}")
        
        # Test /generate with tiny prompt
        if result["health_ok"]:
            try:
                response = requests.post(
                    f"{server_url}/generate",
                    json={"prompt": "Hello", "max_new_tokens": 5},
                    timeout=30
                )
                if response.status_code == 200:
                    data = response.json()
                    if "generated_text" in data or "text" in data:
                        result["generate_ok"] = True
                    else:
                        result["errors"].append(f"Generate response missing text: {data}")
                else:
                    result["errors"].append(f"Generate HTTP {response.status_code}")
            except Exception as e:
                result["errors"].append(f"Generate failed: {e}")
        
        # Determine overall status
        if result["server_started"] and result["health_ok"] and result["generate_ok"]:
            result["status"] = "PASS"
        else:
            result["status"] = "FAIL"
        
        # Shutdown server
        try:
            manager.shutdown_server(model_id)
        except:
            pass
        
    except Exception as e:
        result["errors"].append(f"Smoke test error: {e}")
        result["status"] = "ERROR"
    
    return result


def tools_smoke(model_id: str) -> dict:
    """
    Smoke test for tool calling (end-to-end tool execution).
    
    Args:
        model_id: Model identifier from config
    
    Returns:
        Dict with test results
    """
    import requests
    from core.llm_server_manager import get_llm_server_manager
    from core.inference import get_app_root
    
    result = {
        "model_id": model_id,
        "status": "UNKNOWN",
        "server_started": False,
        "tool_server_ok": False,
        "tool_call_detected": False,
        "tool_executed": False,
        "errors": []
    }
    
    try:
        # Get server manager
        config_path = get_app_root() / "configs" / "llm_backends.yaml"
        manager = get_llm_server_manager(config_path)
        
        # Start LLM server
        try:
            manager.start_server(model_id)
            result["server_started"] = True
        except Exception as e:
            result["errors"].append(f"Failed to start server: {e}")
            result["status"] = "FAIL"
            return result
        
        # Check tool server
        try:
            tool_server_url = "http://localhost:8763"  # Default tool server port
            response = requests.get(f"{tool_server_url}/health", timeout=2)
            if response.status_code == 200:
                result["tool_server_ok"] = True
            else:
                result["errors"].append(f"Tool server health returned {response.status_code}")
        except Exception as e:
            result["errors"].append(f"Tool server not reachable: {e}")
        
        # Test tool calling with inference
        if result["server_started"] and result["tool_server_ok"]:
            from core.inference import run_inference_with_tools
            from core.inference import InferenceConfig, ToolEnabledInferenceConfig
            
            try:
                # Force a tool call with a prompt that should trigger calculator
                config = ToolEnabledInferenceConfig(
                    model_id=model_id,
                    prompt="Calculate 42 * 17 using the calculator tool.",
                    max_new_tokens=100,
                    temperature=0.1,
                    tools_enabled=True,
                    tool_server_url=tool_server_url,
                    auto_approve_tools=True  # For smoke test
                )
                
                outputs = []
                for chunk in run_inference_with_tools(config):
                    outputs.append(chunk)
                    if "tool_call" in str(chunk).lower():
                        result["tool_call_detected"] = True
                    if "tool_result" in str(chunk).lower():
                        result["tool_executed"] = True
                
                if not result["tool_call_detected"]:
                    result["errors"].append("No tool call detected in output")
                
            except Exception as e:
                result["errors"].append(f"Tool inference failed: {e}")
        
        # Determine overall status
        if (result["server_started"] and result["tool_server_ok"] and 
            result["tool_call_detected"] and result["tool_executed"]):
            result["status"] = "PASS"
        else:
            result["status"] = "FAIL"
        
        # Shutdown server
        try:
            manager.shutdown_server(model_id)
        except:
            pass
        
    except Exception as e:
        result["errors"].append(f"Tools smoke test error: {e}")
        result["status"] = "ERROR"
    
    return result


def main():
    """Main CLI entry point"""
    parser = argparse.ArgumentParser(
        prog="owllm",
        description="OWLLM CLI - Test environments, models, and tools"
    )
    
    subparsers = parser.add_subparsers(dest="command", help="Command to run")
    
    # env test
    env_parser = subparsers.add_parser("env", help="Test environment health")
    env_sub = env_parser.add_subparsers(dest="env_command")
    env_test_parser = env_sub.add_parser("test", help="Test environment")
    env_test_parser.add_argument("env_key", help="Environment key (e.g., torch-cu121-transformers-bnb)")
    
    # model smoke
    model_parser = subparsers.add_parser("model", help="Model smoke tests")
    model_sub = model_parser.add_subparsers(dest="model_command")
    model_smoke_parser = model_sub.add_parser("smoke", help="Run smoke test")
    model_smoke_parser.add_argument("model_id", help="Model ID from config")
    
    # tools smoke
    tools_parser = subparsers.add_parser("tools", help="Tool calling smoke tests")
    tools_sub = tools_parser.add_subparsers(dest="tools_command")
    tools_smoke_parser = tools_sub.add_parser("smoke", help="Run tool smoke test")
    tools_smoke_parser.add_argument("model_id", help="Model ID from config")
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        return 1
    
    # Dispatch commands
    try:
        if args.command == "env" and args.env_command == "test":
            result = env_test(args.env_key)
            print(json.dumps(result, indent=2))
            return 0 if result["status"] == "PASS" else 1
        
        elif args.command == "model" and args.model_command == "smoke":
            result = model_smoke(args.model_id)
            print(json.dumps(result, indent=2))
            return 0 if result["status"] == "PASS" else 1
        
        elif args.command == "tools" and args.tools_command == "smoke":
            result = tools_smoke(args.model_id)
            print(json.dumps(result, indent=2))
            return 0 if result["status"] == "PASS" else 1
        
        else:
            parser.print_help()
            return 1
            
    except Exception as e:
        print(json.dumps({"error": str(e), "status": "ERROR"}, indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
