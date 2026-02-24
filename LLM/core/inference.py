from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, List, Callable, Tuple, Any
import subprocess
import sys
import os
import re
import json
import time


def get_app_root() -> Path:
    return Path(__file__).resolve().parents[1]


_SIDE_EFFECT_TOOLS = {"write_file", "run_shell"}
_GREETING_PATTERN = re.compile(r"^(hi|hello|hey|yo|sup|good (morning|afternoon|evening)|hola|ciao)[!. ]*$", re.IGNORECASE)
_ACTION_KEYWORDS = (
    "read ", "open ", "list ", "show ", "check ", "inspect ", "search ", "find ",
    "write ", "create ", "edit ", "modify ", "update ", "run ", "execute ", "git ",
    "status", "file", "files", "folder", "folders", "directory", "directories", "path", "command", "shell",
    "read_file", "tool"
)
_ACTION_INTENT_PATTERN = re.compile(
    r"\b(read[_ ]file|use (the )?tool|open (the )?file|read (the )?file|show (me )?(the )?file)\b",
    re.IGNORECASE,
)

_TRANSIENT_RUNTIME_FAILURE_MARKERS = (
    "server failed to become healthy within",
    "process died during startup",
    "stale starting state",
    "recovered stale starting state",
    "connection refused",
    "read timed out",
    "timed out",
    "startup log:",
    "gguf runtime backend failed for this model",
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
    # Action intent must always win over greeting heuristics.
    if _is_action_request(text):
        return False
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
    if any(keyword in text for keyword in _ACTION_KEYWORDS):
        return True
    return bool(_ACTION_INTENT_PATTERN.search(text))


def _is_contextual_tool_followup(user_msg: str, prompt: str) -> bool:
    """
    Treat follow-up turns as action-capable when they clearly reference previous tool/file context.
    This prevents non-action bypass for turns like "where did you look for it?".
    """
    text = (user_msg or "").strip().lower()
    if not text:
        return False
    prompt_low = str(prompt or "").lower()
    has_tool_context = "<tool_result" in prompt_low or "<tool_call>" in prompt_low
    # In UI flows the history may contain clean assistant text only, so infer file/tool context
    # from role-formatted turns as well.
    has_file_context = any(
        marker in prompt_low for marker in (
            "read the file",
            "read_file",
            "file path",
            "directory",
            ".py",
            ".txt",
            "/",
            "\\",
        )
    )
    if not (has_tool_context or has_file_context):
        return False
    followup_markers = (
        "where did you look",
        "which location",
        "which directory",
        "what location",
        "where are you looking",
        "look for it",
        "that file",
        "the file",
        "path",
        "location",
        "it is there",
        "it's there",
        "it is in",
        "it's in",
        "why you do not find",
        "why don't you find",
    )
    if any(m in text for m in followup_markers):
        return True
    # Path-only follow-up messages like "LLM/LAUNCHER.py" should remain actionable.
    if re.fullmatch(r"[A-Za-z0-9_.\-\\/]+\.[A-Za-z0-9]{1,16}", text.strip()):
        return True
    # Path-bearing follow-up phrases like "it's in LLM/Dios.txt for the ..."
    if re.search(r"\b[A-Za-z0-9_.\-\\/]+\.[A-Za-z0-9]{1,16}\b", text):
        return True
    return False


def _is_transient_runtime_failure(last_error: str) -> bool:
    low = (last_error or "").strip().lower()
    if not low:
        return False
    return any(marker in low for marker in _TRANSIENT_RUNTIME_FAILURE_MARKERS)


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


def clean_display_answer(text: str) -> str:
    """
    Strip tool transcript noise from model output for clean chat display.

    This intentionally keeps only the human-readable answer and removes
    tool-call/result scaffolding that belongs in unfiltered/log views.
    """
    cleaned = str(text or "")

    # Remove echoed tool-instruction block when model parrots system text.
    cleaned = re.sub(
        r"You are a helpful AI assistant with access to tools\..*?Only call tools when necessary\.",
        "",
        cleaned,
        flags=re.DOTALL,
    )

    # Remove XML tool calls/results and repeated stop tokens.
    cleaned = re.sub(r"<tool_call>.*?</\s*tool_call\s*>", "", cleaned, flags=re.DOTALL | re.IGNORECASE)
    cleaned = re.sub(r"<tool_result[^>]*>.*?</\s*tool_result\s*>", "", cleaned, flags=re.DOTALL | re.IGNORECASE)
    # Also remove malformed one-line tool tags that may miss proper closing shape.
    cleaned = re.sub(r"(?im)^\s*`{0,3}\s*<\s*tool_call\b.*$", "", cleaned)
    cleaned = re.sub(r"(?im)^\s*`{0,3}\s*<\s*/\s*tool_call\s*>\s*`{0,3}\s*$", "", cleaned)
    # Remove malformed forms missing opening '<', e.g. ```tool_call>read_file(...)</tool_call>
    cleaned = re.sub(r"(?is)tool_call>\s*\w+\s*\(.*?\)\s*</\s*tool_call\s*>", "", cleaned)
    cleaned = cleaned.replace("</s>", " ")

    # Drop quoted/plain tool transcript blocks the model may echo.
    marker_re = re.compile(r'^\s*"?\s*[🔧✓✗]\s*(?:Calling|Tool Result)\b', re.IGNORECASE)
    kept_lines: List[str] = []
    in_tool_block = False
    brace_depth = 0
    for line in cleaned.splitlines():
        if not in_tool_block and marker_re.search(line or ""):
            in_tool_block = True
            brace_depth = 0
            continue

        if in_tool_block:
            brace_depth += line.count("{") - line.count("}")
            line_strip = line.strip()
            # Most leaked blocks are quoted JSON dumps; end when quote closes and braces are balanced.
            if brace_depth <= 0 and (line_strip.endswith('"') or not line_strip):
                in_tool_block = False
            continue

        kept_lines.append(line)
    cleaned = "\n".join(kept_lines)
    cleaned = re.sub(r"(?im)^\s*\[Tools Used:\s*\d+\]\s*$", "", cleaned)

    # Remove role scaffolding.
    cleaned = re.sub(r"<\|im_start\|>system.*?<\|im_end\|>", "", cleaned, flags=re.DOTALL | re.IGNORECASE)
    cleaned = re.sub(r"<\|im_start\|>user.*?<\|im_end\|>", "", cleaned, flags=re.DOTALL | re.IGNORECASE)

    # If role transcript exists, keep only final assistant turn.
    assistant_role_blocks = re.findall(
        r"(?:^|\n)ASSISTANT:\s*(.*?)(?=\n(?:SYSTEM:|USER:|ASSISTANT:)|\Z)",
        cleaned,
        flags=re.DOTALL | re.IGNORECASE,
    )
    if assistant_role_blocks:
        cleaned = (assistant_role_blocks[-1] or "").strip()

    chatml_assistant_blocks = re.findall(
        r"<\|im_start\|>assistant\s*(.*?)\s*<\|im_end\|>",
        cleaned,
        flags=re.DOTALL | re.IGNORECASE,
    )
    if chatml_assistant_blocks:
        cleaned = (chatml_assistant_blocks[-1] or "").strip()

    cleaned = re.sub(r"(?im)^\s*(SYSTEM|USER|ASSISTANT)\s*:\s*$", "", cleaned)
    cleaned = re.sub(r"(?im)^\s*(SYSTEM|USER)\s*:.*$", "", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    cleaned = cleaned.strip()
    return cleaned or "(No clean answer produced.)"


_REFUSAL_PATTERNS = (
    "i can't assist with that",
    "i cannot assist with that",
    "i'm sorry, but i can't assist",
    "i'm sorry, i can't help",
    "i cannot help with that",
    "can't help with that",
)


def _is_unusable_final_answer(text: str) -> bool:
    cleaned = clean_display_answer(text or "").strip()
    if not cleaned or cleaned == "(No clean answer produced.)":
        return True
    # Treat mostly-empty/whitespace-noise outputs as unusable.
    if not re.sub(r"[\s\r\n\t]+", "", cleaned):
        return True
    # Some models emit literal escaped whitespace sequences like "\\n\\n\\r\\n".
    if re.fullmatch(r"(?:\\[rnt]|\\u000a|\\u000d|[\s\r\n\t])+", cleaned):
        return True
    low = cleaned.lower()
    if any(p in low for p in _REFUSAL_PATTERNS):
        return True
    return False


def _derive_answer_from_tool_log(tool_log: List[dict], user_msg: str) -> str:
    """
    Deterministic fallback answer from successful tool results.
    Primarily used when model output after tool execution is blank/refusal.
    """
    for entry in reversed(tool_log or []):
        if str((entry or {}).get("status", "")).lower() != "success":
            continue
        tool = str((entry or {}).get("tool", "") or "")
        result = (entry or {}).get("result")
        if tool == "read_file" and isinstance(result, dict):
            content = str(result.get("content") or "")
            if not content.strip():
                continue
            lines = content.splitlines()
            if not lines:
                continue
            args = (entry or {}).get("args") or {}
            requested_path = str(args.get("path") or "requested file")
            # Match user intent "show first lines" with a short deterministic preview.
            wanted = 12 if "first line" in (user_msg or "").lower() else 20
            preview = "\n".join(lines[:wanted]).strip()
            if preview:
                return (
                    f"Here are the first lines from `{requested_path}`:\n\n"
                    f"```python\n{preview}\n```"
                )
    return ""


def _derive_read_file_error_answer_from_tool_log(tool_log: List[dict]) -> str:
    """
    Deterministic error explanation for repeated read_file failures.
    """
    last_read_err = None
    for entry in reversed(tool_log or []):
        if str((entry or {}).get("tool", "")).lower() != "read_file":
            continue
        if str((entry or {}).get("status", "")).lower() != "error":
            continue
        last_read_err = entry
        break
    if not last_read_err:
        return ""

    args = (last_read_err or {}).get("args") or {}
    requested_path = str(args.get("path") or "").strip() or "the requested file"
    err = str((last_read_err or {}).get("error") or "File not found")
    looked_in = ""
    m = re.search(r"looked in:\s*([^)]+)\)?", err, flags=re.IGNORECASE)
    if m:
        looked_in = (m.group(1) or "").strip()

    suggestion = ""
    if "/" not in requested_path and "\\" not in requested_path:
        try_path = get_app_root() / requested_path
        if try_path.exists():
            suggestion = f" Try `LLM/{requested_path}`."

    location_msg = f" I looked in: `{looked_in}`." if looked_in else ""
    return (
        f"I could not read `{requested_path}` because it was not found.{location_msg}"
        f"{suggestion}"
    ).strip()


def _is_generic_non_answer(text: str) -> bool:
    low = str(text or "").strip().lower()
    if not low:
        return True
    generic_markers = (
        "please provide more information",
        "please provide more details",
        "please provide context",
        "could you please provide",
        "your query seems to be incomplete",
        "i need more information",
        "clarify your request",
    )
    return any(m in low for m in generic_markers)


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
    from core.model_id_resolver import resolve_onboarding_identity
    model_cfg = None
    if get_global_server_manager():
        try:
            mgr = get_global_server_manager()
            mgr._load_config()
            model_cfg = (mgr.config.get("models") or {}).get(cfg.model_id) if hasattr(mgr, "config") else None
        except Exception:
            pass
    if not model_cfg and cfg.base_model:
        model_cfg = {"base_model": str(cfg.base_model)}
    identity = resolve_onboarding_identity(
        cfg.model_id,
        model_cfg=model_cfg,
        get_status=onboarding.get_onboarding_status,
        strict=True,
    )
    onboarding_id = identity["onboarding_id"] or cfg.model_id
    status = identity["status"]
    
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

        # Allow one runtime recovery attempt for transient startup failures.
        # Keep strict blocking for real onboarding issues (missing runtime/components/corrupt files).
        if str(status).upper() == "BROKEN" and _is_transient_runtime_failure(last_error):
            if log_callback:
                log_callback(
                    f"Model '{onboarding_id}' is BROKEN due to a transient startup failure; "
                    "attempting runtime recovery..."
                )
        else:
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
    if log_callback:
        log_callback(f"Server ready: {server_url}")
    
    # Call persistent server via HTTP
    client = InferenceClient(server_url)
    t0 = time.time()
    try:
        if log_callback:
            log_callback("Sending generation request to model server...")
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
    finally:
        if log_callback:
            try:
                log_callback(f"Model server request completed in {time.time() - t0:.1f}s")
            except Exception:
                pass


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
    explicit_action_request = _is_action_request(user_msg) or _is_contextual_tool_followup(user_msg, cfg.prompt)

    # Global default-safe behavior:
    # - For non-action prompts (including greetings), use plain model inference (no tool loop).
    if not explicit_action_request:
        safe_prompt = _strip_tool_instruction_block(cfg.prompt)
        safe_max_new_tokens = cfg.max_new_tokens
        # Keep non-action chat turns responsive by default.
        # Override via env if longer non-action completions are desired.
        try:
            non_action_cap = int(os.getenv("LLM_MAX_NEW_TOKENS_NON_ACTION", "256"))
            if non_action_cap > 0 and safe_max_new_tokens > non_action_cap:
                safe_max_new_tokens = non_action_cap
                log(
                    f"[ToolGuard] Capping non-action max_new_tokens to {safe_max_new_tokens} "
                    "(set LLM_MAX_NEW_TOKENS_NON_ACTION to override)"
                )
        except Exception:
            pass
        inference_cfg = InferenceConfig(
            prompt=safe_prompt,
            model_id=cfg.model_id,
            base_model=cfg.base_model,
            adapter_dir=cfg.adapter_dir,
            max_new_tokens=safe_max_new_tokens,
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
    forced_finalize = False

    def _force_finalize_without_tools(reason: str) -> str:
        """Force a final assistant reply after tool guard interruption."""
        safe_prompt = _strip_tool_instruction_block(conversation_history)
        finalize_prompt = (
            safe_prompt
            + "\n\n[Tool execution note]\n"
            + f"Tool execution was stopped: {reason}.\n"
            + "Now provide your best final answer to the user without calling tools. "
            + "If required data is missing, say exactly what is missing in one short sentence."
        )
        inference_cfg = InferenceConfig(
            prompt=finalize_prompt,
            model_id=cfg.model_id,
            base_model=cfg.base_model,
            adapter_dir=cfg.adapter_dir,
            max_new_tokens=cfg.max_new_tokens,
            temperature=cfg.temperature,
            images=cfg.images,
        )
        return run_inference(inference_cfg, env, log_callback=log_callback)

    def _force_finalize_from_tool_results() -> str:
        """
        Ask model to synthesize a direct user answer from already-captured tool results.
        No additional tool use should happen in this pass.
        """
        safe_prompt = _strip_tool_instruction_block(conversation_history)
        finalize_prompt = (
            safe_prompt
            + "\n\n[Finalization directive]\n"
            + "Use the latest tool results already present in the conversation.\n"
            + "Do not call tools again.\n"
            + "Answer the user request directly and concisely."
        )
        inference_cfg = InferenceConfig(
            prompt=finalize_prompt,
            model_id=cfg.model_id,
            base_model=cfg.base_model,
            adapter_dir=cfg.adapter_dir,
            max_new_tokens=cfg.max_new_tokens,
            temperature=cfg.temperature,
            images=cfg.images,
        )
        return run_inference(inference_cfg, env, log_callback=log_callback)
    
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
            try:
                final_output = _force_finalize_without_tools(f"blocked_policy:{reason}")
                forced_finalize = True
            except Exception as finalize_ex:
                log(f"[ToolGuard] Finalize-after-policy-block failed: {finalize_ex}")
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
            try:
                final_output = _force_finalize_without_tools("repeated_tool_signature")
                forced_finalize = True
            except Exception as finalize_ex:
                log(f"[ToolGuard] Finalize-after-loop-stop failed: {finalize_ex}")
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
                tool_callback(
                    tool_call.name,
                    tool_call.arguments,
                    {
                        "success": result.success,
                        "result": result.result,
                        "error": result.error,
                    },
                )
            
            # Format result for LLM and append to history
            result_text = format_tool_result_for_llm(tool_call, result)
            conversation_history += "\n" + result_text
        
        if not any_executed:
            # No tools were executed (all denied or errored), stop iteration
            try:
                final_output = _force_finalize_without_tools("no_tools_executed")
                forced_finalize = True
            except Exception as finalize_ex:
                log(f"[ToolGuard] Finalize-after-no-executed failed: {finalize_ex}")
            break
        
        # Update prompt with full history for next iteration
        cfg.prompt = conversation_history
    
    # If loop exited without a forced finalization and the output still contains tool tags,
    # make one best-effort final response so users never get a silent/non-answer stop.
    if not forced_finalize and isinstance(final_output, str) and "<tool_call>" in final_output:
        try:
            final_output = _force_finalize_without_tools("tool_call_left_in_output")
        except Exception as finalize_ex:
            log(f"[ToolGuard] Final fallback finalize failed: {finalize_ex}")

    # Hard guarantee for tool-enabled turns: if tools succeeded but final answer is blank/refusal,
    # synthesize once from tool results; if still unusable, produce deterministic fallback from logs.
    had_successful_tools = any(str((e or {}).get("status", "")).lower() == "success" for e in (tool_log or []))
    if had_successful_tools and _is_unusable_final_answer(final_output):
        try:
            model_synth = _force_finalize_from_tool_results()
            if not _is_unusable_final_answer(model_synth):
                final_output = model_synth
        except Exception as finalize_ex:
            log(f"[ToolGuard] Tool-result synthesis finalize failed: {finalize_ex}")
        if _is_unusable_final_answer(final_output):
            deterministic = _derive_answer_from_tool_log(tool_log, user_msg)
            if deterministic:
                final_output = deterministic

    # If read_file repeatedly fails, avoid generic/non-contextual replies.
    # Return a deterministic explanation including looked-up location and likely corrected path.
    read_file_failure_answer = _derive_read_file_error_answer_from_tool_log(tool_log)
    if read_file_failure_answer and (_is_unusable_final_answer(final_output) or _is_generic_non_answer(final_output)):
        final_output = read_file_failure_answer
    return final_output, tool_log
