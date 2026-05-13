#!/usr/bin/env python3
"""
LLM Server Launcher Script
Runs inside a model's isolated Python environment to start the FastAPI server.
"""
import os
import sys
import yaml
import subprocess
from pathlib import Path

_this_dir = Path(__file__).resolve().parent
_llm_root = _this_dir.parent
if str(_llm_root) not in sys.path:
    sys.path.insert(0, str(_llm_root))

# Do not hide child console windows.
_SUBPROCESS_FLAGS = {}

def main():
    # Validate arguments
    if len(sys.argv) < 2:
        print("Usage: python llm_server_start.py <model_id>", file=sys.stderr)
        print("Example: python llm_server_start.py default", file=sys.stderr)
        sys.exit(1)

    model_id = sys.argv[1]

    # Resolve config path relative to script location
    script_dir = Path(__file__).parent
    config_file = script_dir.parent / "configs" / "llm_backends.yaml"

    if not config_file.exists():
        print(f"ERROR: Config file not found: {config_file}", file=sys.stderr)
        sys.exit(1)

    # Load configuration
    try:
        with open(config_file, 'r', encoding='utf-8') as f:
            cfg = yaml.safe_load(f)
    except Exception as e:
        print(f"ERROR: Failed to load config: {e}", file=sys.stderr)
        sys.exit(1)

    # Validate model_id
    if "models" not in cfg or model_id not in cfg["models"]:
        print(f"ERROR: Model '{model_id}' not found in config", file=sys.stderr)
        if "models" in cfg:
            print(f"Available models: {list(cfg['models'].keys())}", file=sys.stderr)
        sys.exit(1)

    model_cfg = cfg["models"][model_id]

    # Set environment variables for server_app.py to read
    runtime_base_model = str(os.environ.get("LLM_RUNTIME_BASE_MODEL", "")).strip()
    runtime_model_name = str(os.environ.get("LLM_RUNTIME_MODEL_NAME", "")).strip()
    os.environ["BASE_MODEL"] = runtime_base_model or model_cfg["base_model"]
    # Make /health identify the configured runtime slot (helps detect variant-specific reuse)
    os.environ["MODEL_NAME"] = runtime_model_name or model_id
    
    if model_cfg.get("adapter_dir"):
        os.environ["ADAPTER_DIR"] = model_cfg["adapter_dir"]
    
    os.environ["MODEL_TYPE"] = model_cfg.get("model_type", "base")
    os.environ["USE_4BIT"] = str(model_cfg.get("use_4bit", True)).lower()
    runtime_backend = str(os.environ.get("LLM_RUNTIME_BACKEND", model_cfg.get("runtime_backend", "") or "")).strip()

    # AUTO-ROUTE GGUF MODELS TO THE BUNDLED LLAMA-SERVER PROXY.
    # The python wheel ``llama-cpp-python`` ships its own bundled
    # ``llama.dll`` that drifts months behind upstream llama.cpp — wheel
    # 0.3.23 (current latest as of 2026-05-13) returns Windows error
    # 0xc000001d (STATUS_ILLEGAL_INSTRUCTION) on architectures it doesn't
    # know like ``gemma4``. Meanwhile the in-tree
    # ``LLM/runtime/llama.cpp/llama-server.exe`` (build 8648) DOES know
    # them and loads the same file fine. The fix is to route any GGUF
    # base model through ``bundled_proxy_server`` (which spawns the
    # in-tree binary) instead of ``server_app`` (which loads via the
    # wheel). The YAML can still override this by setting an explicit
    # ``runtime_backend`` — we only auto-set when nothing is configured.
    if not runtime_backend:
        try:
            base_path = Path(os.environ["BASE_MODEL"])
            is_gguf = (
                (base_path.is_file() and base_path.suffix.lower() == ".gguf")
                or (base_path.is_dir() and any(base_path.rglob("*.gguf")))
            )
            if is_gguf:
                runtime_backend = "llama_cpp_server"
                print(
                    "Auto-routing GGUF base to bundled llama-server "
                    "(wheel-based loaders lag upstream archs)."
                )
        except Exception:
            pass

    if runtime_backend:
        os.environ["LLM_RUNTIME_BACKEND"] = runtime_backend

    # GPTQ backend: "auto-gptq" (default) or "exllamav2" when explicitly selected
    if model_cfg.get("gptq_backend") == "exllamav2":
        os.environ["USE_EXLLAMAV2_GPTQ"] = "true"
    
    if model_cfg.get("system_prompt"):
        os.environ["SYSTEM_PROMPT"] = model_cfg["system_prompt"]

    # Port can be overridden by environment variable (for auto-reassignment)
    port = int(os.environ.get("SERVER_PORT", model_cfg.get("port", 9100)))

    print(f"Starting LLM server for model: {model_id}")
    print(f"Port: {port}")
    print(f"Base model: {os.environ['BASE_MODEL']}")
    if model_cfg.get("adapter_dir"):
        print(f"Adapter: {model_cfg['adapter_dir']}")
    print(f"Model type: {os.environ['MODEL_TYPE']}")
    print(f"4-bit quantization: {os.environ['USE_4BIT']}")
    print("-" * 50)

    # We're running from LLM directory, so use relative import.
    # If routed backend is bundled llama.cpp, launch proxy server app instead.
    if runtime_backend == "llama_cpp_server":
        import_path = "core.llm_backends.bundled_proxy_server:app"
        print("Runtime backend route: bundled llama.cpp proxy")
    else:
        import_path = "core.llm_backends.server_app:app"
    
    # Set PYTHONPATH to ensure imports work
    app_root = script_dir.parent  # LLM directory
    env = os.environ.copy()
    if "PYTHONPATH" in env:
        env["PYTHONPATH"] = str(app_root) + os.pathsep + env["PYTHONPATH"]
    else:
        env["PYTHONPATH"] = str(app_root)
    
    requested_python = str(os.environ.get("LLM_SERVER_PYTHON", "")).strip()
    server_python = sys.executable
    if requested_python:
        try:
            req_path = Path(requested_python).resolve()
            cur_path = Path(sys.executable).resolve()
            req_low = str(req_path).lower()
            cur_low = str(cur_path).lower()
            # Safety: if launcher already runs inside a model env, do not jump to system python.
            # This prevents environment drift (e.g., accidentally launching uvicorn on Python 3.12).
            if ".envs" in cur_low and ".envs" not in req_low:
                print(
                    f"[WARN] Ignoring LLM_SERVER_PYTHON outside model env: {req_path}. "
                    f"Using current interpreter: {cur_path}"
                )
            elif req_path.exists():
                server_python = str(req_path)
            else:
                print(
                    f"[WARN] LLM_SERVER_PYTHON does not exist: {req_path}. "
                    f"Using current interpreter: {cur_path}"
                )
        except Exception as e:
            print(f"[WARN] Could not validate LLM_SERVER_PYTHON ({requested_python}): {e}")
            print(f"[WARN] Falling back to current interpreter: {sys.executable}")
    # Keep child Python unbuffered so uvicorn/app tracebacks are emitted immediately
    # to the parent startup log when startup fails.
    env["PYTHONUNBUFFERED"] = "1"
    print(f"Launching uvicorn with: {server_python} -m uvicorn {import_path}")
    print(f"Working directory: {app_root}")
    print(f"PYTHONPATH: {env['PYTHONPATH']}")
    
    # Launch FastAPI server using -m uvicorn (module-safe, avoids PATH issues)
    try:
        subprocess.run([
            server_python, "-m", "uvicorn",
            import_path,
            "--host", "127.0.0.1",
            "--port", str(port),
            "--log-level", "info"
        ], check=True, cwd=str(app_root), env=env, **_SUBPROCESS_FLAGS)
    except KeyboardInterrupt:
        print("\nServer stopped by user")
        sys.exit(0)
    except subprocess.CalledProcessError as e:
        print(f"ERROR: Server process failed with exit code {e.returncode}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: Failed to start server: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
