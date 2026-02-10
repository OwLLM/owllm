from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, List, Callable, Tuple
import subprocess
import sys
import os
import re
import json


def get_app_root() -> Path:
    return Path(__file__).resolve().parents[1]


_SIDE_EFFECT_TOOLS = {"write_file", "run_shell"}
_GREETING_PATTERN = re.compile(r"^(hi|hello|hey|yo|sup|good (morning|afternoon|evening)|hola|ciao)[!. ]*$", re.IGNORECASE)
_ACTION_KEYWORDS = (
    "read ", "open ", "list ", "show ", "check ", "inspect ", "search ", "find ",
    "write ", "create ", "edit ", "modify ", "update ", "run ", "execute ", "git ",
    "status", "file", "files", "folder", "folders", "directory", "directories", "path", "command", "shell"
)


def _extract_last_user_message(prompt: str) -> str:
    """Best-effort extraction of the most recent user turn from common chat templates."""
    if not prompt:
        return ""

    patterns = [
        r"USER:\s*(.*?)(?:\nASSISTANT:|$)",
        r"<\|im_start\|>user\s*(.*?)\s*<\|im_end\|>",
        r"\[INST\]\s*(.*?)\s*\[/INST\]",
    ]
    for pattern in patterns:
        matches = re.findall(pattern, prompt, flags=re.IGNORECASE | re.DOTALL)
        if matches:
            last = (matches[-1] or "").strip()
            # Strip llama SYS wrapper when present in [INST] block
            last = re.sub(r"<<SYS>>.*?<</SYS>>", "", last, flags=re.DOTALL).strip()
            if last:
                return last
    return prompt.strip()[-500:]


# Relaxed greeting/small-talk pattern: typos and short casual openers (e.g. "hey whatsaop?")
_GREETING_LIKE_PATTERN = re.compile(
    r"^(hi|hello|hey|yo|sup|hola|ciao|whatsapp|whatsaop|what\'?s up|how are you|how ya doin)[\s!?.]*$",
    re.IGNORECASE,
)


def _is_low_intent_message(user_msg: str) -> bool:
    text = (user_msg or "").strip().lower()
    if not text:
        return True
    if len(text) <= 80 and re.match(r"^(hi|hello|hey|yo|sup|hola|ciao)\b", text):
        return True
    if _GREETING_PATTERN.match(text):
        return True
    if _GREETING_LIKE_PATTERN.match(text):
        return True
    if len(text) <= 24 and text in {"hello", "hi", "hey", "yo", "sup", "thanks", "thank you", "ok", "okay"}:
        return True
    return False


def _is_action_request(user_msg: str) -> bool:
    text = (user_msg or "").strip().lower()
    if not text:
        return False
    return any(keyword in text for keyword in _ACTION_KEYWORDS)


def _strip_tool_instruction_block(prompt: str) -> str:
    """
    Remove embedded tool-instruction block from the prompt when we intentionally bypass tool execution.
    Keeps user/system context, but strips the long XML tool guide that some models tend to parrot.
    """
    if not prompt:
        return ""
    start_marker = "You are a helpful AI assistant with access to tools."
    end_marker = "Only call tools when necessary."
    start_idx = prompt.find(start_marker)
    if start_idx < 0:
        return prompt
    end_idx = prompt.find(end_marker, start_idx)
    if end_idx < 0:
        return prompt
    end_idx += len(end_marker)
    cleaned = (prompt[:start_idx] + prompt[end_idx:]).strip()
    return re.sub(r"\n{3,}", "\n\n", cleaned)


@dataclass
class InferenceConfig:
    prompt: str
    model_id: str = "default"  # Required for server-based inference
    base_model: Optional[str] = None
    adapter_dir: Optional[Path] = None
    max_new_tokens: int = 512
    temperature: float = 0.7
    images: List[str] = field(default_factory=list)


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
    if "/" not in (cfg.model_id or ""):
        # IMPORTANT:
        # The UI/config often uses filesystem-safe keys like "org_repo", but onboarding is stored under HF ids "org/repo".
        # If a stale onboarding row exists for the filesystem-safe key (e.g. BROKEN), it must NOT block chat when the HF id is READY.
        derived_id = None
        try:
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
                    d = name.replace("__", "/")
                    if "/" in d:
                        derived_id = d
                elif "/" not in name and "_" in name:
                    parts = name.split("_", 1)
                    if len(parts) == 2:
                        derived_id = f"{parts[0]}/{parts[1]}"
        except Exception:
            derived_id = None

        # Prefer the derived HF id when it is READY (even if cfg.model_id has a stale BROKEN row).
        try:
            cfg_status = onboarding.get_onboarding_status(cfg.model_id)
        except Exception:
            cfg_status = None
        try:
            derived_status = onboarding.get_onboarding_status(derived_id) if derived_id else None
        except Exception:
            derived_status = None

        if derived_id and derived_status == "READY":
            onboarding_id = derived_id
        elif cfg_status == "READY":
            onboarding_id = cfg.model_id
        elif derived_id and derived_status is not None:
            onboarding_id = derived_id

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
            temperature=cfg.temperature,
            images=cfg.images,
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
            temperature=cfg.temperature,
            images=cfg.images,
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

    def log(msg: str) -> None:
        if log_callback:
            log_callback(msg)
    
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
    user_msg = _extract_last_user_message(cfg.prompt)
    low_intent = _is_low_intent_message(user_msg)
    explicit_action_request = _is_action_request(user_msg)

    # Global default-safe behavior:
    # - For non-action prompts (including greetings), use plain model inference (no tool loop).
    if not explicit_action_request:
        safe_prompt = _strip_tool_instruction_block(cfg.prompt)
        inference_cfg = InferenceConfig(
            prompt=safe_prompt,
            model_id=cfg.model_id,
            base_model=cfg.base_model,
            adapter_dir=cfg.adapter_dir,
            max_new_tokens=cfg.max_new_tokens,
            temperature=cfg.temperature,
            images=cfg.images,
        )
        reason = "low_intent_prompt" if low_intent else "missing_explicit_action_request"
        log(f"[ToolGuard] Bypassing tool mode ({reason})")
        output = run_inference(inference_cfg, env, log_callback=log_callback)
        return output, []
    
    # Add system prompt if provided
    if cfg.system_prompt:
        conversation_history = f"{cfg.system_prompt}\n\n{conversation_history}"
    
    iteration = 0
    final_output = ""
    previous_tool_signature: Optional[Tuple[str, ...]] = None
    repeated_signature_count = 0
    
    while iteration < cfg.max_tool_iterations:
        iteration += 1
        
        # Run inference with current conversation
        inference_cfg = InferenceConfig(
            prompt=conversation_history,
            model_id=cfg.model_id,  # Pass model_id to InferenceConfig
            base_model=cfg.base_model,
            adapter_dir=cfg.adapter_dir,
            max_new_tokens=cfg.max_new_tokens,
            temperature=cfg.temperature,
            images=cfg.images,
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

        # Policy guardrails (model-agnostic):
        # - Never execute tools on casual/greeting turns
        # - Require explicit user action intent before executing tool calls
        if low_intent or not explicit_action_request:
            reason = "low_intent_prompt" if low_intent else "missing_explicit_action_request"
            tool_names = ", ".join(sorted({tc.name for tc in tool_calls}))
            log(f"[ToolGuard] Blocked tool execution ({reason}) for tools: {tool_names}")
            for tc in tool_calls:
                tool_log.append({
                    "tool": tc.name,
                    "args": tc.arguments,
                    "status": "blocked_policy",
                    "reason": reason,
                    "iteration": iteration,
                })
            break

        # Loop breaker: stop repeated identical tool-call sets across iterations.
        signature = tuple(sorted(
            f"{tc.name}:{json.dumps(tc.arguments, sort_keys=True, ensure_ascii=True)}"
            for tc in tool_calls
        ))
        if signature == previous_tool_signature:
            repeated_signature_count += 1
        else:
            repeated_signature_count = 0
        previous_tool_signature = signature
        if repeated_signature_count >= 1:
            tool_names = ", ".join(sorted({tc.name for tc in tool_calls}))
            log(f"[ToolGuard] Stopped repeated tool-call loop for tools: {tool_names}")
            for tc in tool_calls:
                tool_log.append({
                    "tool": tc.name,
                    "args": tc.arguments,
                    "status": "blocked_loop",
                    "reason": "repeated_tool_signature",
                    "iteration": iteration,
                })
            break
        
        # Process each tool call
        any_executed = False
        for tool_call in tool_calls:
            # Check if approval is needed
            requires_approval = approval_manager.requires_approval(tool_call.name) or tool_call.name in _SIDE_EFFECT_TOOLS
            if requires_approval:
                if not approval_callback:
                    # Safe-by-default: deny dangerous/warning tools when no approval channel exists.
                    log(f"[ToolGuard] Denied '{tool_call.name}' (approval callback not available)")
                    tool_log.append({
                        "tool": tool_call.name,
                        "args": tool_call.arguments,
                        "status": "denied",
                        "reason": "approval_required_no_callback",
                        "iteration": iteration
                    })
                    continue
                approved = approval_callback(tool_call.name, tool_call.arguments)
                if not approved:
                    # Tool denied, skip execution
                    log(f"[ToolGuard] Denied '{tool_call.name}' by user approval callback")
                    tool_log.append({
                        "tool": tool_call.name,
                        "args": tool_call.arguments,
                        "status": "denied",
                        "reason": "approval_denied",
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
