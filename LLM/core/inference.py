from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, List, Callable, Tuple
import subprocess
import sys
import os


def get_app_root() -> Path:
    return Path(__file__).resolve().parents[1]


@dataclass
class InferenceConfig:
    prompt: str
    model_id: str = "default"  # Required for server-based inference
    base_model: Optional[str] = None
    adapter_dir: Optional[Path] = None
    max_new_tokens: int = 256
    temperature: float = 0.7


@dataclass
class ToolEnabledInferenceConfig(InferenceConfig):
    """Extended inference config with tool calling support"""
    enable_tools: bool = True
    tool_server_url: str = "http://127.0.0.1:8763"
    tool_server_token: str = ""
    auto_execute_safe_tools: bool = True
    max_tool_iterations: int = 5  # Prevent infinite loops
    system_prompt: str = ""  # System prompt for tool instructions
    native_executor: Optional[Any] = None  # NativeToolExecutor instance (if using native mode)


def build_run_adapter_cmd(cfg: InferenceConfig) -> List[str]:
    cmd = [sys.executable, "-u", "run_adapter.py", "--prompt", cfg.prompt]
    if cfg.base_model:
        cmd += ["--base-model", cfg.base_model]
    if cfg.adapter_dir:
        cmd += ["--adapter-dir", str(cfg.adapter_dir)]
    cmd += ["--max-new-tokens", str(cfg.max_new_tokens), "--temperature", str(cfg.temperature)]
    return cmd


def run_inference(cfg: InferenceConfig, env: Optional[dict] = None, log_callback: Optional[Callable[[str], None]] = None) -> str:
    """
    Run inference using persistent server.
    
    RUNTIME GATE: Only allows models with onboarding status=READY.
    
    Args:
        cfg: Inference configuration (must include model_id)
        env: Optional environment variables (unused in server mode)
        
    Returns:
        Generated text from the model
    """
    from core.llm_server_manager import get_global_server_manager
    from core.inference_client import InferenceClient, EmptyModelResponseError
    from core.model_onboarding import get_onboarding_service
    
    # RUNTIME GATE: Check onboarding status before attempting server start
    onboarding = get_onboarding_service()
    # cfg.model_id is a server config key in many UI flows (e.g. "zai-org_GLM-4.7"),
    # but onboarding is keyed by HF id (e.g. "zai-org/GLM-4.7"). Resolve when needed.
    onboarding_id = cfg.model_id
    if "/" not in cfg.model_id:
        try:
            from core.state_store import get_state_store
            if get_state_store().get_onboarding(cfg.model_id) is None:
                # Prefer cfg.base_model if provided, else read from llm_backends.yaml via server manager config
                base_model_path = None
                if cfg.base_model:
                    base_model_path = str(cfg.base_model)
                else:
                    mgr = get_global_server_manager()
                    try:
                        mgr._load_config()
                    except Exception:
                        pass
                    if hasattr(mgr, "config") and cfg.model_id in (mgr.config.get("models") or {}):
                        base_model_path = str((mgr.config["models"][cfg.model_id] or {}).get("base_model", "") or "")

                if base_model_path:
                    name = Path(base_model_path).name
                    if "__" in name:
                        derived = name.replace("__", "/")
                        if "/" in derived:
                            onboarding_id = derived
                    elif "/" not in name and "_" in name:
                        parts = name.split("_", 1)
                        if len(parts) == 2:
                            onboarding_id = f"{parts[0]}/{parts[1]}"
        except Exception:
            pass

    status = onboarding.get_onboarding_status(onboarding_id)
    
    # Runtime policy: DO NOT repair/onboard during chat.
    # If the model is not READY, instruct the user to explicitly re-onboard/repair.
    if status is None:
        raise RuntimeError(
            f"Model '{onboarding_id}' has not been onboarded yet (status=None).\n"
            f"Please run onboarding/repair for this model before chatting."
        )

    if status != "READY":
        last_error = ""
        log_path = ""
        try:
            from core.state_store import get_state_store
            entry = get_state_store().get_onboarding(onboarding_id) or {}
            last_error = str(entry.get("last_error") or "")
            log_path = str(entry.get("healthcheck_log_path") or "")
        except Exception:
            pass

        msg = (
            f"Model '{onboarding_id}' is not ready for chat (status={status}).\n"
            f"Please re-onboard/repair this model from the UI before chatting."
        )
        if last_error:
            msg += f"\n\nLast error:\n{last_error}"
        if log_path:
            msg += f"\n\nOnboarding log: {log_path}"
        raise RuntimeError(msg)
    
    # Ensure server is running for this model
    manager = get_global_server_manager()
    server_url = manager.ensure_server_running(cfg.model_id, log_callback=log_callback)
    
    # Call persistent server via HTTP
    client = InferenceClient(server_url)
    try:
        return client.generate(
            prompt=cfg.prompt,
            max_new_tokens=cfg.max_new_tokens,
            temperature=cfg.temperature
        )
    except EmptyModelResponseError as e:
        # Self-heal: this specific case means server returned 200 OK with {"text": ""}.
        # That is almost always a stale/bad server process. Restart once and retry.
        if log_callback:
            log_callback("⚠️ Server returned HTTP 200 with empty text. Restarting server and retrying once...")
        try:
            manager.shutdown_server(cfg.model_id)
        except Exception:
            # Best-effort restart; ignore shutdown errors and continue.
            pass

        # Start (or reuse) server again, then retry once.
        server_url = manager.ensure_server_running(cfg.model_id, log_callback=log_callback)
        client = InferenceClient(server_url)
        return client.generate(
            prompt=cfg.prompt,
            max_new_tokens=cfg.max_new_tokens,
            temperature=cfg.temperature
        )


def run_inference_with_tools(
    cfg: ToolEnabledInferenceConfig,
    tool_callback: Optional[Callable[[str, dict, any], None]] = None,
    approval_callback: Optional[Callable[[str, dict], bool]] = None,
    env: Optional[dict] = None,
    log_callback: Optional[Callable[[str], None]] = None
) -> Tuple[str, List[dict]]:
    """
    Run inference with tool calling support.
    
    Iterative loop:
    1. Generate response from LLM
    2. Detect tool calls in output
    3. Execute tools (with approval if needed)
    4. Feed results back to LLM
    5. Repeat until no more tool calls or max iterations
    
    Args:
        cfg: Tool-enabled inference configuration
        tool_callback: Called with (tool_name, args, result) for each tool execution
        approval_callback: Called with (tool_name, args), returns True if approved
        env: Optional environment variables
        
    Returns:
        Tuple of (final_output, tool_execution_log)
        tool_execution_log is list of dicts with tool execution details
    """
    from core.tool_calling import (
        ToolCallDetector,
        ToolExecutor,
        ToolApprovalManager,
        format_tool_result_for_llm
    )
    
    if not cfg.enable_tools:
        # Tools disabled, run normal inference
        output = run_inference(cfg, env, log_callback=log_callback)
        return output, []
    
    # Initialize tool infrastructure
    # Check if native executor provided (native mode)
    if cfg.native_executor is not None:
        executor = cfg.native_executor
    else:
        # HTTP mode - use ToolExecutor
        executor = ToolExecutor(cfg.tool_server_url, cfg.tool_server_token)
    
    approval_manager = ToolApprovalManager(cfg.auto_execute_safe_tools)
    detector = ToolCallDetector()
    
    tool_log = []
    conversation_history = cfg.prompt
    
    # Add system prompt if provided
    if cfg.system_prompt:
        conversation_history = f"{cfg.system_prompt}\n\n{conversation_history}"
    
    iteration = 0
    final_output = ""
    
    while iteration < cfg.max_tool_iterations:
        iteration += 1
        
        # Run inference with current conversation
        inference_cfg = InferenceConfig(
            prompt=conversation_history,
            model_id=cfg.model_id,  # Pass model_id to InferenceConfig
            base_model=cfg.base_model,
            adapter_dir=cfg.adapter_dir,
            max_new_tokens=cfg.max_new_tokens,
            temperature=cfg.temperature
        )
        
        # Call LLM
        assistant_text = run_inference(inference_cfg, env, log_callback=log_callback)
        final_output = assistant_text
        
        # Append assistant output ONCE (before tool loop)
        conversation_history += "\n" + assistant_text
        
        # Detect tool calls in output
        tool_calls = detector.detect(assistant_text)
        
        if not tool_calls:
            # No more tool calls, we're done
            break
        
        # Process each tool call
        any_executed = False
        for tool_call in tool_calls:
            # Check if approval is needed
            requires_approval = approval_manager.requires_approval(tool_call.name)
            
            if requires_approval and approval_callback:
                approved = approval_callback(tool_call.name, tool_call.arguments)
                if not approved:
                    # Tool denied, skip execution
                    tool_log.append({
                        "tool": tool_call.name,
                        "args": tool_call.arguments,
                        "status": "denied",
                        "iteration": iteration
                    })
                    continue
            
            # Execute the tool
            result = executor.execute(tool_call)
            any_executed = True
            
            # Log execution
            log_entry = {
                "tool": tool_call.name,
                "args": tool_call.arguments,
                "status": "success" if result.success else "error",
                "result": result.result if result.success else None,
                "error": result.error if not result.success else None,
                "iteration": iteration
            }
            tool_log.append(log_entry)
            
            # Call tool callback if provided
            if tool_callback:
                tool_callback(tool_call.name, tool_call.arguments, result.result if result.success else result.error)
            
            # Format result for LLM and append to history
            result_text = format_tool_result_for_llm(tool_call, result)
            conversation_history += "\n" + result_text
        
        if not any_executed:
            # No tools were executed (all denied or errored), stop iteration
            break
        
        # Update prompt with full history for next iteration
        cfg.prompt = conversation_history
    
    return final_output, tool_log
