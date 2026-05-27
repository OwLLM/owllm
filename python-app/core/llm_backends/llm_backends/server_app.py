#!/usr/bin/env python3
"""
FastAPI server for persistent LLM inference.
Loads model once at startup and serves generation requests over HTTP.
Provides both native API and OpenAI-compatible endpoints.
"""
import os
import logging
import time
import threading
from typing import Optional, List, Literal, Union, Dict, Any
import json

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# NOTE:
# Keep module import lightweight so Uvicorn can bind quickly and /health responds immediately.
# Heavy imports (torch/transformers) are deferred into the background loader / request handlers.

# Create FastAPI app
app = FastAPI(
    title="LLM Inference Server",
    description="Local LLM server with OpenAI-compatible API",
    version="1.0.0"
)

# Add CORS middleware for external tool access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global model state
tokenizer = None
model = None
processor = None  # For multimodal/vision models (replaces tokenizer for generation)
model_type = "base"
system_prompt = ""
model_name = "local-llm"

# Loading status (so the server can come up immediately)
_load_state: str = "not_started"  # not_started|loading|ready|error
_load_error: str = ""
_load_started_at: float = 0.0
_load_finished_at: float = 0.0

# GPTQ backend selection: "auto-gptq" (default) or "exllamav2" when USE_EXLLAMAV2_GPTQ=true
_gptq_backend: str = "auto-gptq"

# Guardrails by family: cap from capability profile, env overrides applied in get_guardrail_max_tokens.
def _resolve_guardrail_profile_id() -> str:
    """Resolve profile_id from env (BASE_MODEL, USE_4BIT, ADAPTER_DIR, MODEL_NAME) for family-specific guardrails."""
    base_model = (os.environ.get("BASE_MODEL") or "").strip()
    if not base_model:
        return "base"
    try:
        from core.envs.capability_matrix import resolve_capability
        model_cfg = {
            "use_4bit": (os.environ.get("USE_4BIT", "true").strip().lower() == "true"),
            "adapter_dir": os.environ.get("ADAPTER_DIR") or None,
        }
        cap = resolve_capability(
            base_model,
            model_cfg=model_cfg,
            adapter_dir=os.environ.get("ADAPTER_DIR") or None,
            model_id=os.environ.get("MODEL_NAME") or None,
        )
        return cap.get("profile_id") or "base"
    except Exception:
        return "base"


def _get_max_tokens_cap_multimodal() -> int:
    """Family-aware cap for multimodal; env LLM_MAX_NEW_TOKENS_MULTIMODAL overrides profile default."""
    from core.envs.capability_matrix import get_guardrail_max_tokens
    return get_guardrail_max_tokens(_resolve_guardrail_profile_id(), is_multimodal=True)


def _get_max_tokens_cap_text() -> int:
    """Family-aware cap for text; env LLM_MAX_NEW_TOKENS_TEXT overrides profile default."""
    from core.envs.capability_matrix import get_guardrail_max_tokens
    return get_guardrail_max_tokens(_resolve_guardrail_profile_id(), is_multimodal=False)


def _decode_images_to_pil(images: List[str]):
    """Decode base64 or data URL strings to PIL Images. Raises HTTPException on invalid input."""
    import base64
    import re
    try:
        from PIL import Image
        import io
    except ImportError:
        raise HTTPException(status_code=500, detail="PIL is required for image input. Install with: pip install Pillow")
    out = []
    for i, s in enumerate(images):
        if not s or not isinstance(s, str):
            raise HTTPException(status_code=400, detail=f"images[{i}] must be a non-empty string (base64 or data URL)")
        s = s.strip()
        raw = None
        if s.startswith("data:"):
            m = re.match(r"data:image/[^;]+;base64,(.+)", s, re.DOTALL)
            if not m:
                raise HTTPException(status_code=400, detail=f"images[{i}] invalid data URL (expected data:image/...;base64,...)")
            raw = base64.b64decode(m.group(1))
        else:
            raw = base64.b64decode(s)
        try:
            img = Image.open(io.BytesIO(raw)).convert("RGB")
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"images[{i}] could not be decoded as image: {e}")
        # Normalize size for VLM stability (avoid extreme aspect/size edge cases).
        try:
            w, h = img.size
            if w <= 0 or h <= 0:
                raise HTTPException(status_code=400, detail=f"images[{i}] has invalid dimensions ({w}x{h})")
            # Upscale tiny images to a minimum side.
            min_side = min(w, h)
            if min_side < 32:
                scale = 32.0 / float(min_side)
                new_w = max(32, int(round(w * scale)))
                new_h = max(32, int(round(h * scale)))
                img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
                w, h = img.size
            # Downscale very large images to keep tokenized vision patches reasonable.
            max_side = max(w, h)
            if max_side > 1344:
                scale = 1344.0 / float(max_side)
                new_w = max(32, int(round(w * scale)))
                new_h = max(32, int(round(h * scale)))
                img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
        except HTTPException:
            raise
        except Exception:
            # Ignore normalization failures and use original decoded image.
            pass
        out.append(img)
    return out


# ============================================================================
# Native API Models
# ============================================================================

class GenerateRequest(BaseModel):
    prompt: str
    max_new_tokens: int = 1024
    temperature: float = 0.7
    images: List[str] = Field(default_factory=list)  # Optional: base64 or data URL strings for vision models


class GenerateResponse(BaseModel):
    text: str

class DebugGenerateResponse(BaseModel):
    status: str
    formatted_prompt_head: str = ""
    input_len: int = 0
    output_len: int = 0
    gen_len: int = 0
    decoded_skip_special: str = ""
    decoded_raw: str = ""
    notes: List[str] = Field(default_factory=list)


# ============================================================================
# OpenAI-Compatible API Models
# ============================================================================

class ChatMessage(BaseModel):
    # Allow extra fields ("name", "tool_calls", "tool_call_id", etc.) so
    # OpenAI-protocol clients like Cline that include them don't 422 here.
    model_config = ConfigDict(extra="ignore")
    role: Literal["system", "user", "assistant", "tool", "function", "developer"]
    # Cline / OpenAI-protocol clients sometimes send ``content`` as a list of
    # parts ([{"type":"text","text":"..."},{"type":"image_url",...}]) instead
    # of a plain string. Accept both; we render to plain text downstream.
    content: Union[str, List[Any], None] = ""


class ChatCompletionRequest(BaseModel):
    # Cline 3.81 (and any modern OpenAI-protocol client) sends a superset of
    # the fields below — ``tools``, ``tool_choice``, ``top_p``,
    # ``response_format``, ``seed``, ``frequency_penalty``,
    # ``presence_penalty``, ``n``, ``user``, ``logprobs``, etc. Pydantic's
    # default behaviour is to reject extras with HTTP 422, which is exactly
    # the symptom we hit ("[openai] 422 status code (no body)"). Switch to
    # ``extra="ignore"`` so unknown fields are silently dropped.
    model_config = ConfigDict(extra="ignore")
    model: str = "local-llm"
    messages: List[ChatMessage]
    temperature: float = 0.7
    max_tokens: int = 1024
    stream: bool = False
    stop: Optional[Union[str, List[str]]] = None
    images: List[str] = Field(default_factory=list)  # Optional: base64 or data URL strings for vision models


class ChatCompletionChoice(BaseModel):
    index: int
    message: ChatMessage
    finish_reason: str


class ChatCompletionUsage(BaseModel):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


class ChatCompletionResponse(BaseModel):
    id: str
    object: str = "chat.completion"
    created: int
    model: str
    choices: List[ChatCompletionChoice]
    usage: ChatCompletionUsage


class ModelInfo(BaseModel):
    id: str
    object: str = "model"
    created: int
    owned_by: str = "local"


class ModelsListResponse(BaseModel):
    object: str = "list"
    data: List[ModelInfo]


# ============================================================================
# Startup & Shutdown
# ============================================================================

@app.on_event("startup")
async def startup_event():
    """
    Start model loading in background.
    IMPORTANT: Do not block startup, or Uvicorn won't bind the port and /health will fail.
    """
    global tokenizer, model, model_type, system_prompt, model_name
    global _load_state, _load_error, _load_started_at, _load_finished_at
    
    logger.info("Starting LLM server...")
    
    # Read configuration from environment variables
    base_model = os.environ.get("BASE_MODEL")
    if not base_model:
        raise RuntimeError("BASE_MODEL environment variable is required")
    
    adapter_dir = os.environ.get("ADAPTER_DIR")
    model_type = os.environ.get("MODEL_TYPE", "base")
    system_prompt = os.environ.get("SYSTEM_PROMPT", "")
    model_name = os.environ.get("MODEL_NAME", "local-llm")
    use_4bit_str = os.environ.get("USE_4BIT", "true").lower()
    use_4bit = use_4bit_str in ("true", "1", "yes")
    
    # Kick off background load (server binds immediately)
    _load_state = "loading"
    _load_error = ""
    _load_started_at = time.time()
    _load_finished_at = 0.0

    logger.info(f"Queued model load: {base_model}")
    if adapter_dir:
        logger.info(f"With adapter: {adapter_dir}")
    logger.info(f"Model type: {model_type}")
    logger.info(f"Model name: {model_name}")
    logger.info(f"Quantization (4-bit): {use_4bit}")

    # GPTQ backend selection: ExLlamaV2 when USE_EXLLAMAV2_GPTQ=true and model is GPTQ (no adapter)
    use_exllamav2_gptq = os.environ.get("USE_EXLLAMAV2_GPTQ", "").lower() in ("true", "1", "yes")
    is_gptq = False
    try:
        from pathlib import Path
        base_path = Path(base_model)
        if base_path.exists() and base_path.is_dir():
            is_gptq = (base_path / "quantize_config.json").exists()
    except Exception:
        pass
    # ExLlamaV2 does not support adapters; use auto-gptq when adapter_dir is set
    gptq_backend = "exllamav2" if (
        use_exllamav2_gptq and is_gptq and not adapter_dir
    ) else "auto-gptq"
    if is_gptq:
        logger.info(f"GPTQ model detected; backend: {gptq_backend}")

    def _loader():
        nonlocal base_model, adapter_dir, use_4bit, gptq_backend
        global tokenizer, model, processor, _gptq_backend
        global _load_state, _load_error, _load_finished_at
        _gptq_backend = gptq_backend
        try:
            logger.info("Background model load started...")
            if gptq_backend == "exllamav2":
                from core.llm_backends.exllama_backend import load_model
            else:
                from core.llm_backends.run_adapter_backend import load_model
            result = load_model(
                base_model=base_model,
                adapter_dir=adapter_dir,
                use_4bit=use_4bit,
                offload=True
            )
            tok_or_proc = result[0] if len(result) > 0 else None
            model = result[1] if len(result) > 1 else None
            proc = result[2] if len(result) > 2 else None
            # Important: for multimodal models, keep tokenizer unset and use processor.
            if proc is not None:
                processor = proc
                tokenizer = None
            else:
                tokenizer = tok_or_proc
                processor = None
            _load_state = "ready"
            _load_finished_at = time.time()
            logger.info("Model loaded successfully!")
        except Exception as e:
            _load_state = "error"
            # Store both exception type and message separately for better diagnostics
            _load_error = f"{type(e).__name__}: {e}"
            _load_finished_at = time.time()
            # Log full exception details including traceback
            logger.error(f"Failed to load model: {type(e).__name__}")
            logger.error(f"Exception message: {e}")
            logger.exception("Full traceback:")

    threading.Thread(target=_loader, daemon=True).start()


# ============================================================================
# Native API Endpoints
# ============================================================================

@app.get("/health")
async def health_check():
    """Health check endpoint with strict validation"""
    # Strict health gate: model and (tokenizer or processor) must be valid
    has_tokenizer = (
        tokenizer is not None and
        hasattr(tokenizer, 'encode') and
        hasattr(tokenizer, 'decode')
    )
    has_processor = processor is not None
    is_ready = (
        _load_state == "ready" and
        model is not None and
        (has_tokenizer or has_processor)
    )
    
    payload: Dict[str, Any] = {
        "status": "ok" if is_ready else _load_state,
        "model": model_name,
    }
    
    if _load_state == "error":
        payload["error"] = _load_error
        # Include full error details for debugging
        if _load_error:
            payload["error_details"] = _load_error
    
    if _load_started_at:
        payload["loading_seconds"] = round((time.time() - _load_started_at), 1)
    
    # If model/tokenizer/processor exist but are invalid, report as error
    if _load_state == "ready" and not is_ready:
        payload["status"] = "error"
        payload["error"] = "Model or tokenizer/processor is invalid (missing required attributes)"
        payload["model_valid"] = model is not None
        payload["tokenizer_valid"] = has_tokenizer
        payload["processor_valid"] = has_processor
    
    return payload


@app.post("/generate", response_model=GenerateResponse)
async def generate(request: GenerateRequest):
    """Generate text from prompt (native API) with strict health gate"""
    # Strict health gate: validate model and tokenizer before inference
    if _load_state != "ready":
        detail = "Model not ready"
        if _load_state == "error" and _load_error:
            detail = f"Model load failed: {_load_error}"
        raise HTTPException(status_code=503, detail=detail)
    
    if model is None:
        raise HTTPException(
            status_code=503,
            detail="Model is None. Model load may have failed silently."
        )
    
    try:
        # ExLlamaV2 is text-only
        if _gptq_backend == "exllamav2" and request.images:
            raise HTTPException(status_code=400, detail="This backend does not support images (GPTQ ExLlamaV2).")

        # Apply configurable caps (env: LLM_MAX_NEW_TOKENS_MULTIMODAL, LLM_MAX_NEW_TOKENS_TEXT)
        max_tokens_cap = _get_max_tokens_cap_multimodal() if processor is not None else _get_max_tokens_cap_text()
        effective_max_tokens = min(request.max_new_tokens, max_tokens_cap)
        if request.max_new_tokens > max_tokens_cap:
            logger.info(
                f"max_new_tokens capped: requested={request.max_new_tokens}, cap={max_tokens_cap} "
                f"({'multimodal' if processor else 'text'}). Set LLM_MAX_NEW_TOKENS_* env to change."
            )
            logger.info(
                "RUNTIME_EVENT guardrail_cap_used cap=%s requested=%s multimodal=%s",
                max_tokens_cap, request.max_new_tokens, processor is not None,
            )
        logger.debug(f"Generation request: prompt_len={len(request.prompt)}, max_tokens={effective_max_tokens}, temp={request.temperature}")

        # Multimodal path (processor)
        if processor is not None:
            from core.llm_backends.run_adapter_backend import generate_multimodal, generate_text
            pil_images = _decode_images_to_pil(request.images) if request.images else []
            mm_prompt = (system_prompt + "\n\n" if system_prompt else "") + request.prompt
            # Vision models can still receive text-only turns in normal chat.
            # Avoid processor/image tensor crashes by routing text-only turns through tokenizer path.
            if not pil_images:
                text_tokenizer = getattr(processor, "tokenizer", None)
                if text_tokenizer is None and tokenizer is not None and hasattr(tokenizer, "encode") and hasattr(tokenizer, "decode"):
                    text_tokenizer = tokenizer
                if text_tokenizer is None:
                    raise HTTPException(
                        status_code=400,
                        detail="Vision model received no images and no text tokenizer fallback is available."
                    )
                text = generate_text(
                    tokenizer=text_tokenizer,
                    model=model,
                    prompt=mm_prompt,
                    max_new_tokens=effective_max_tokens,
                    temperature=request.temperature,
                    model_type=model_type,
                    system_prompt="",
                )
            else:
                try:
                    text = generate_multimodal(
                        processor=processor,
                        model=model,
                        prompt=mm_prompt,
                        images=pil_images,
                        max_new_tokens=effective_max_tokens,
                        temperature=request.temperature,
                    )
                except RuntimeError as e:
                    # Known multimodal shape edge-case: retry once with a safer token budget.
                    msg = str(e)
                    if "expanded size of the tensor" in msg or "Tensor sizes:" in msg:
                        retry_tokens = min(effective_max_tokens, 256)
                        logger.warning(
                            "Multimodal generate runtime shape mismatch; retrying with safer max_new_tokens=%s",
                            retry_tokens,
                        )
                        text = generate_multimodal(
                            processor=processor,
                            model=model,
                            prompt=mm_prompt,
                            images=pil_images,
                            max_new_tokens=retry_tokens,
                            temperature=request.temperature,
                        )
                    else:
                        raise
        else:
            if tokenizer is None:
                raise HTTPException(status_code=503, detail="Tokenizer/processor missing. Model load may have failed.")
            # Additional validation: ensure tokenizer is actually a tokenizer object
            if not (hasattr(tokenizer, 'encode') and hasattr(tokenizer, 'decode')):
                raise HTTPException(
                    status_code=503,
                    detail=f"Tokenizer is invalid (type: {type(tokenizer)}). Missing required methods (encode/decode)."
                )
            # Use the same backend that loaded the model
            if _gptq_backend == "exllamav2":
                from core.llm_backends.exllama_backend import generate_text
            else:
                from core.llm_backends.run_adapter_backend import generate_text
            # Call generation function
            text = generate_text(
                tokenizer=tokenizer,
                model=model,
                prompt=request.prompt,
                max_new_tokens=effective_max_tokens,
                temperature=request.temperature,
                model_type=model_type,
                system_prompt=system_prompt
            )
        
        logger.debug(f"generate_text returned: type={type(text)}, len={len(str(text)) if text else 0}, text_preview={repr(str(text)[:100]) if text else 'None'}")
        
        # Safety check: Never return empty text (generate_text should raise, but double-check)
        if not text or not str(text).strip():
            error_msg = f"generate_text returned empty text (this should not happen - it should raise RuntimeError). Type: {type(text)}, Value: {repr(text)}"
            logger.error(error_msg)
            raise HTTPException(
                status_code=500,
                detail=f"Generation returned empty output. {error_msg} This indicates the server code may need to be restarted to pick up error handling fixes."
            )
        
        # Return ONLY the clean text
        return GenerateResponse(text=text)
        
    except HTTPException:
        # Re-raise HTTP exceptions as-is
        raise
    except Exception as e:
        error_type = type(e).__name__
        error_msg = str(e)
        logger.error(f"Generation failed: {error_type}: {error_msg}")
        import traceback
        logger.error(traceback.format_exc())
        detail = f"Generation failed: {error_type}: {error_msg}"
        if "out of memory" in error_msg.lower() or ("cuda" in error_msg.lower() and "memory" in error_msg.lower()):
            detail += " Try: free VRAM, switch GPU in app settings, or reduce max_new_tokens."
        raise HTTPException(status_code=500, detail=detail)

@app.post("/debug_generate", response_model=DebugGenerateResponse)
async def debug_generate(request: GenerateRequest):
    """
    Debug endpoint to diagnose 'empty reply' issues.
    Returns token lengths and decoded outputs (truncated).
    """
    if _load_state != "ready" or model is None or (tokenizer is None and processor is None):
        detail = "Model not ready"
        if _load_state == "error" and _load_error:
            detail = f"Model load failed: {_load_error}"
        return DebugGenerateResponse(status=detail)

    if _gptq_backend == "exllamav2":
        return DebugGenerateResponse(status="ExLlamaV2 backend: debug_generate not implemented")
    if processor is not None:
        return DebugGenerateResponse(status="Vision backend: debug_generate not implemented")

    notes: List[str] = []
    try:
        # Build prompt similarly to generate_text()
        if model_type == "instruct":
            messages = []
            if system_prompt:
                messages.append({"role": "system", "content": system_prompt})
            messages.append({"role": "user", "content": request.prompt})
            try:
                formatted_prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            except Exception as e:
                notes.append(f"apply_chat_template_failed: {type(e).__name__}: {e}")
                formatted_prompt = (system_prompt + "\n\n" if system_prompt else "") + request.prompt
            add_specials = False
        else:
            formatted_prompt = (system_prompt + "\n\n" if system_prompt else "") + request.prompt
            add_specials = True

        inputs = tokenizer(formatted_prompt, return_tensors="pt", add_special_tokens=add_specials)
        # Trim EOS if present at end (see generate_text)
        try:
            eos_id = tokenizer.eos_token_id
            if eos_id is not None and int(inputs["input_ids"][0, -1].item()) == int(eos_id):
                notes.append("trimmed_trailing_eos")
                inputs["input_ids"] = inputs["input_ids"][:, :-1]
                if "attention_mask" in inputs:
                    inputs["attention_mask"] = inputs["attention_mask"][:, :-1]
        except Exception:
            pass

        import torch
        device = next(model.parameters()).device
        inputs = {k: v.to(device) for k, v in inputs.items()}
        input_len = int(inputs["input_ids"].shape[1])

        gen_kwargs = {
            "max_new_tokens": request.max_new_tokens,
            "pad_token_id": tokenizer.pad_token_id if tokenizer.pad_token_id is not None else tokenizer.eos_token_id,
            "eos_token_id": tokenizer.eos_token_id,
            "use_cache": True,
        }
        if request.temperature > 0:
            gen_kwargs["do_sample"] = True
            gen_kwargs["temperature"] = request.temperature
        else:
            gen_kwargs["do_sample"] = False

        with torch.no_grad():
            out = model.generate(**inputs, **gen_kwargs)

        output_len = int(out.shape[1])
        gen_ids = out[0][input_len:]
        gen_len = int(gen_ids.shape[0])
        decoded_skip = tokenizer.decode(gen_ids, skip_special_tokens=True)
        decoded_raw = tokenizer.decode(gen_ids, skip_special_tokens=False)

        if gen_len == 0:
            notes.append("gen_len_zero")
        if decoded_skip.strip() == "":
            notes.append("decoded_skip_empty")

        return DebugGenerateResponse(
            status="ok",
            formatted_prompt_head=formatted_prompt[:600],
            input_len=input_len,
            output_len=output_len,
            gen_len=gen_len,
            decoded_skip_special=decoded_skip[:800],
            decoded_raw=decoded_raw[:800],
            notes=notes,
        )
    except Exception as e:
        logger.exception("debug_generate failed")
        return DebugGenerateResponse(status=f"error: {type(e).__name__}: {e}", notes=notes)


# ============================================================================
# OpenAI-Compatible API Endpoints
# ============================================================================

@app.get("/v1/models", response_model=ModelsListResponse)
async def list_models():
    """List available models (OpenAI-compatible)"""
    return ModelsListResponse(
        data=[
            ModelInfo(
                id=model_name,
                created=int(time.time())
            )
        ]
    )


@app.post("/v1/chat/completions")
async def chat_completions(request: ChatCompletionRequest):
    """Chat completions endpoint (OpenAI-compatible).

    Supports both blocking responses (``stream=false``) and Server-Sent
    Events streaming (``stream=true``). Streaming is required by Cline 3.81
    and most modern OpenAI-protocol clients — without it they get HTTP 400.

    Streaming implementation: we still generate the full text in one shot
    (the underlying transformers/exllama backends here are not
    incremental), then break the result into chunked SSE events on the way
    out. Token-level streaming is a future enhancement; chunk-level keeps
    Cline happy and feels responsive enough for short replies.
    """
    if model is None or (tokenizer is None and processor is None) or _load_state != "ready":
        detail = "Model not ready"
        if _load_state == "error" and _load_error:
            detail = f"Model load failed: {_load_error}"
        raise HTTPException(status_code=503, detail=detail)

    def _flatten_content(c) -> str:
        """OpenAI-protocol clients (Cline 3.81 included) sometimes send
        ``content`` as a list of parts like
        ``[{"type":"text","text":"..."},{"type":"image_url","image_url":{...}}]``
        instead of a plain string. Concatenate text parts and drop the rest
        — image parts are routed through ``request.images`` separately for
        models that support them."""
        if c is None:
            return ""
        if isinstance(c, str):
            return c
        if isinstance(c, list):
            out = []
            for part in c:
                if isinstance(part, dict):
                    t = part.get("type")
                    if t == "text" and isinstance(part.get("text"), str):
                        out.append(part["text"])
                elif isinstance(part, str):
                    out.append(part)
            return "\n".join(out)
        return str(c)

    try:
        # Build prompt from messages
        prompt_parts = []

        # Add system messages
        system_messages = [_flatten_content(msg.content) for msg in request.messages if msg.role == "system"]
        if system_messages:
            prompt_parts.append(system_messages[0])  # Use first system message
        elif system_prompt:
            prompt_parts.append(system_prompt)

        # Add conversation history
        for msg in request.messages:
            text = _flatten_content(msg.content)
            if msg.role == "user":
                prompt_parts.append(f"User: {text}")
            elif msg.role == "assistant":
                prompt_parts.append(f"Assistant: {text}")
        
        # Add final prompt
        prompt_parts.append("Assistant:")
        
        full_prompt = "\n\n".join(prompt_parts)

        # ExLlamaV2 is text-only
        if _gptq_backend == "exllamav2" and request.images:
            raise HTTPException(status_code=400, detail="This backend does not support images (GPTQ ExLlamaV2).")

        completion_id = f"chatcmpl-{int(time.time())}"
        created_ts = int(time.time())
        prompt_tok = len(full_prompt.split())

        # ---- Streaming branch (REAL token-level streaming) ------------
        # The previous implementation ran model.generate() to completion
        # before yielding anything, then chopped the finished string into
        # SSE-shaped chunks. With Cline-style 12k-token prompts, that's
        # several minutes of total silence and Cline's UI gives up before
        # the first byte arrives. For the transformers / llama-cpp paths
        # we now use generate_text_streaming(), which yields each token
        # as the model emits it. Multimodal + ExLlamaV2 still use the
        # old path because they don't expose token-level streaming yet.
        can_stream_real = (
            request.stream
            and processor is None
            and _gptq_backend != "exllamav2"
        )
        if can_stream_real:
            from core.llm_backends.run_adapter_backend import generate_text_streaming

            def _sse_iter_real():
                # First chunk advertises the assistant role.
                first = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created_ts,
                    "model": request.model,
                    "choices": [
                        {"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}
                    ],
                }
                yield f"data: {json.dumps(first)}\n\n"

                produced_words = 0
                try:
                    for piece in generate_text_streaming(
                        tokenizer=tokenizer,
                        model=model,
                        prompt=full_prompt,
                        max_new_tokens=request.max_tokens,
                        temperature=request.temperature,
                        model_type=model_type,
                        system_prompt="",
                    ):
                        if not piece:
                            continue
                        produced_words += len(piece.split())
                        msg = {
                            "id": completion_id,
                            "object": "chat.completion.chunk",
                            "created": created_ts,
                            "model": request.model,
                            "choices": [
                                {"index": 0, "delta": {"content": piece}, "finish_reason": None}
                            ],
                        }
                        yield f"data: {json.dumps(msg)}\n\n"
                except Exception as gen_err:
                    logger.error(f"Streaming generation error: {gen_err}")
                    err_payload = {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created_ts,
                        "model": request.model,
                        "choices": [
                            {"index": 0, "delta": {"content": f"\n[server error: {gen_err}]"}, "finish_reason": "stop"}
                        ],
                    }
                    yield f"data: {json.dumps(err_payload)}\n\n"
                    yield "data: [DONE]\n\n"
                    return

                final = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created_ts,
                    "model": request.model,
                    "choices": [
                        {"index": 0, "delta": {}, "finish_reason": "stop"}
                    ],
                    "usage": {
                        "prompt_tokens": prompt_tok,
                        "completion_tokens": produced_words,
                        "total_tokens": prompt_tok + produced_words,
                    },
                }
                yield f"data: {json.dumps(final)}\n\n"
                yield "data: [DONE]\n\n"

            return StreamingResponse(_sse_iter_real(), media_type="text/event-stream")

        # ---- Non-streaming generation (and multimodal/ExLlamaV2) ------
        if processor is not None:
            from core.llm_backends.run_adapter_backend import generate_multimodal
            pil_images = _decode_images_to_pil(request.images) if request.images else []
            generated_text = generate_multimodal(
                processor=processor,
                model=model,
                prompt=full_prompt,
                images=pil_images,
                max_new_tokens=request.max_tokens,
                temperature=request.temperature,
            )
        else:
            # Use the same backend that loaded the model
            if _gptq_backend == "exllamav2":
                from core.llm_backends.exllama_backend import generate_text
            else:
                from core.llm_backends.run_adapter_backend import generate_text
            # Generate response
            generated_text = generate_text(
                tokenizer=tokenizer,
                model=model,
                prompt=full_prompt,
                max_new_tokens=request.max_tokens,
                temperature=request.temperature,
                model_type=model_type,
                system_prompt=""  # Already included in prompt
            )

        text = generated_text.strip()
        completion_tok = len(text.split())

        # Multimodal/ExLlamaV2 still go through the old chunked-streaming
        # path (their backends don't expose per-token streaming yet).
        if request.stream:
            def _sse_iter_chunked():
                first = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created_ts,
                    "model": request.model,
                    "choices": [
                        {"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}
                    ],
                }
                yield f"data: {json.dumps(first)}\n\n"

                CHUNK = 64
                for i in range(0, len(text), CHUNK):
                    piece = text[i : i + CHUNK]
                    msg = {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created_ts,
                        "model": request.model,
                        "choices": [
                            {"index": 0, "delta": {"content": piece}, "finish_reason": None}
                        ],
                    }
                    yield f"data: {json.dumps(msg)}\n\n"

                final = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created_ts,
                    "model": request.model,
                    "choices": [
                        {"index": 0, "delta": {}, "finish_reason": "stop"}
                    ],
                    "usage": {
                        "prompt_tokens": prompt_tok,
                        "completion_tokens": completion_tok,
                        "total_tokens": prompt_tok + completion_tok,
                    },
                }
                yield f"data: {json.dumps(final)}\n\n"
                yield "data: [DONE]\n\n"

            return StreamingResponse(_sse_iter_chunked(), media_type="text/event-stream")

        # ---- Non-streaming branch ------------------------------------
        response = ChatCompletionResponse(
            id=completion_id,
            created=created_ts,
            model=request.model,
            choices=[
                ChatCompletionChoice(
                    index=0,
                    message=ChatMessage(role="assistant", content=text),
                    finish_reason="stop"
                )
            ],
            usage=ChatCompletionUsage(
                prompt_tokens=prompt_tok,
                completion_tokens=completion_tok,
                total_tokens=prompt_tok + completion_tok,
            )
        )
        return response

    except Exception as e:
        logger.error(f"Chat completion failed: {e}")
        raise HTTPException(status_code=500, detail=f"Chat completion failed: {str(e)}")


@app.get("/")
async def root():
    """Root endpoint with API information"""
    return {
        "name": "LLM Inference Server",
        "version": "1.0.0",
        "model": model_name,
        "endpoints": {
            "health": "GET /health",
            "native_generate": "POST /generate",
            "openai_chat": "POST /v1/chat/completions",
            "openai_models": "GET /v1/models"
        },
        "status": "ready" if model is not None else "loading"
    }


def _schedule_process_exit(delay_s: float = 0.2) -> None:
    def _exit() -> None:
        time.sleep(max(0.0, float(delay_s)))
        os._exit(0)

    threading.Thread(target=_exit, daemon=True).start()


@app.post("/shutdown")
async def shutdown_server():
    _schedule_process_exit()
    return {"status": "shutting_down", "model": model_name}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "9100"))
    uvicorn.run(app, host="127.0.0.1", port=port)
