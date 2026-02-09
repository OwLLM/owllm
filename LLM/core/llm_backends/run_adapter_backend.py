#!/usr/bin/env python3
"""
Backend module extracted from run_adapter.py
Contains core model loading and text generation logic.

DO NOT MODIFY THE CORE LOGIC - THIS IS A VERBATIM COPY FROM run_adapter.py
"""
import torch
import warnings
import logging
import platform

# Suppress known warnings
warnings.filterwarnings("ignore", message=".*quantization_config.*")
warnings.filterwarnings("ignore", message=".*pkg_resources.*")
warnings.filterwarnings("ignore", message=".*TRANSFORMERS_CACHE.*")
warnings.filterwarnings("ignore", category=FutureWarning, module="transformers")

# Check if running on Windows
IS_WINDOWS = platform.system() == "Windows"

# Check for optional dependencies early
try:
    from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig
except ImportError as e:
    logging.error(f"Missing required package: {e}")
    logging.error("Please run: pip install transformers")
    raise

# Optional vision/processor imports (used only for multimodal models)
def _get_vision_imports():
    out = {}
    try:
        from transformers import AutoProcessor
        out["AutoProcessor"] = AutoProcessor
    except ImportError:
        pass
    # These auto-classes vary by transformers version; import opportunistically.
    try:
        from transformers import AutoModelForVision2Seq  # type: ignore
        out["AutoModelForVision2Seq"] = AutoModelForVision2Seq
    except Exception:
        pass
    try:
        from transformers import AutoModelForImageTextToText  # type: ignore
        out["AutoModelForImageTextToText"] = AutoModelForImageTextToText
    except Exception:
        pass
    try:
        from transformers import AutoModelForConditionalGeneration  # type: ignore
        out["AutoModelForConditionalGeneration"] = AutoModelForConditionalGeneration
    except Exception:
        pass
    return out


def _is_multimodal_config(model_path_str: str) -> bool:
    """Return True if config.json indicates a vision/multimodal model."""
    import json
    import os
    config_path = os.path.join(model_path_str, "config.json")
    if not os.path.isfile(config_path):
        return False
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)
    except Exception:
        return False
    architectures = config.get("architectures") or []
    model_type = (config.get("model_type") or "").lower()
    arch_str = " ".join(architectures).lower()
    # Known vision/multimodal indicators
    vision_hints = (
        "llava", "mllama", "qwen2vl", "qwen2_vl", "vision", "image", "vl",
        "llama3_2_vision", "llama3.2_vision", "idefics", "blip", "git", "pix2struct",
    )
    if any(h in model_type for h in vision_hints):
        return True
    if any(h in arch_str for h in vision_hints):
        return True
    return False


def _load_multimodal_model(model_path_str: str, use_4bit: bool, bnb_ok: bool):
    """Load processor and vision model. Returns (processor, model)."""
    imports = _get_vision_imports()
    AutoProcessor = imports.get("AutoProcessor")
    if AutoProcessor is None:
        raise RuntimeError("Vision model requires transformers with AutoProcessor. Please upgrade: pip install -U transformers")
    processor = AutoProcessor.from_pretrained(model_path_str, trust_remote_code=True)
    # Prefer vision-specific auto class, then conditional generation
    model = None
    for key in ("AutoModelForImageTextToText", "AutoModelForVision2Seq", "AutoModelForConditionalGeneration"):
        cls = imports.get(key)
        if cls is None:
            continue
        try:
            kwargs = dict(trust_remote_code=True, device_map="auto", low_cpu_mem_usage=True)
            if use_4bit and (not IS_WINDOWS or bnb_ok):
                kwargs["quantization_config"] = BitsAndBytesConfig(
                    load_in_4bit=True,
                    bnb_4bit_compute_dtype=torch.float16,
                )
            else:
                kwargs["torch_dtype"] = torch.float16
            model = cls.from_pretrained(model_path_str, **kwargs)
            logging.info(f"Loaded multimodal model with {key}")
            break
        except ImportError as e:
            # Surface missing optional deps clearly (common for vision models)
            error_str = str(e).lower()
            if "timm" in error_str:
                raise RuntimeError("Missing dependency: timm. Install with: pip install timm>=0.9.0") from e
            if "einops" in error_str:
                raise RuntimeError("Missing dependency: einops. Install with: pip install einops>=0.6.0") from e
            if "open_clip" in error_str or "open-clip" in error_str:
                raise RuntimeError("Missing dependency: open-clip-torch. Install with: pip install open-clip-torch>=2.20.0") from e
            raise
        except Exception as e:
            logging.debug(f"{key}.from_pretrained failed: {e}")
            continue
    if model is None:
        raise RuntimeError(
            "Could not load vision model with AutoModelForImageTextToText, AutoModelForVision2Seq, or AutoModelForConditionalGeneration. "
            "This may require a newer transformers version or trust_remote_code support for this architecture."
        )
    return processor, model


def _bitsandbytes_available() -> bool:
    # Allow 4-bit on Windows if bitsandbytes is actually importable.
    # Older code disabled it unconditionally on Windows, which forces FP16 and can make large models "hang".
    try:
        import bitsandbytes  # type: ignore  # noqa: F401
        return True
    except Exception:
        return False


def load_model(base_model, adapter_dir, use_4bit=True, offload=True):
    import os
    import sys
    
    # Validate inputs are strings
    if not isinstance(base_model, str) or not base_model:
        raise ValueError(f"base_model must be a non-empty string, got: {type(base_model)} = {base_model!r}")
    
    if adapter_dir is not None and (not isinstance(adapter_dir, str) or not adapter_dir):
        raise ValueError(f"adapter_dir must be None or a non-empty string, got: {type(adapter_dir)} = {adapter_dir!r}")
    
    tokenizer = None
    
    # Normalize base_model path early - ensure it's a proper string
    import os
    from pathlib import Path
    
    # Check if it looks like a local file path (contains path separators or starts with drive letter on Windows)
    is_local_path = os.sep in base_model or (os.name == 'nt' and len(base_model) > 1 and base_model[1] == ':')
    
    if is_local_path:
        # It's a local path - normalize it
        model_path = Path(base_model).resolve()
        if not model_path.exists():
            raise ValueError(f"Model path does not exist: {base_model}")
        if not model_path.is_dir():
            raise ValueError(f"Model path is not a directory: {base_model}")
        # Check for essential model files
        config_file = model_path / "config.json"
        if not config_file.exists():
            raise ValueError(f"Model directory missing config.json: {base_model}")
        base_model = str(model_path)
    
    # Final validation - ensure it's a clean string
    model_path_str = str(base_model).strip()
    if not model_path_str:
        raise ValueError("base_model path is empty after normalization")
    
    # If adapter_dir is None, we're loading base model only
    if adapter_dir is None:
        if not is_local_path:
            logging.info(f"Loading base model from HuggingFace: {model_path_str}")
        else:
            logging.info(f"Loading local base model: {model_path_str}")
        
        # Add defensive diagnostics before tokenizer load
        try:
            import transformers
            logging.info(f"Transformers version: {transformers.__version__}")
        except Exception:
            pass  # Don't fail if version check fails
        
        # Pre-flight checks for local paths
        if is_local_path:
            if not os.path.exists(model_path_str):
                raise FileNotFoundError(
                    f"Model path does not exist: {model_path_str}\n"
                    f"Please verify the model directory exists and is accessible."
                )
            if not os.path.isdir(model_path_str):
                raise ValueError(
                    f"Model path is not a directory: {model_path_str}\n"
                    f"Expected a directory containing model files."
                )
            # Check for tokenizer files (optional - some models might not have these)
            tokenizer_config = os.path.join(model_path_str, "tokenizer_config.json")
            if not os.path.exists(tokenizer_config):
                logging.warning(
                    f"tokenizer_config.json not found at {model_path_str}\n"
                    f"Tokenizer may still load from other files or HuggingFace cache."
                )
            # Multimodal: load processor + vision model instead of tokenizer + causal LM
            if _is_multimodal_config(model_path_str):
                logging.info("Detected multimodal/vision model from config, loading processor and vision model")
                bnb_ok = _bitsandbytes_available()
                processor, model = _load_multimodal_model(model_path_str, use_4bit, bnb_ok)
                return processor, model, processor

        # Non-local (HF model ID): best-effort multimodal detection via AutoConfig.
        # This avoids loading vision checkpoints as plain causal LMs.
        if not is_local_path:
            try:
                from transformers import AutoConfig  # type: ignore
                cfg = AutoConfig.from_pretrained(model_path_str, trust_remote_code=True)
                model_type_attr = (getattr(cfg, "model_type", "") or "").lower()
                architectures = getattr(cfg, "architectures", []) or []
                arch_str = " ".join(architectures).lower()
                vision_hints = ("llava", "mllama", "qwen2vl", "qwen2_vl", "vision", "image", "vl", "idefics", "blip", "pix2struct")
                if any(h in model_type_attr for h in vision_hints) or any(h in arch_str for h in vision_hints):
                    logging.info("Detected multimodal/vision model from AutoConfig, loading processor and vision model")
                    bnb_ok = _bitsandbytes_available()
                    processor, model = _load_multimodal_model(model_path_str, use_4bit, bnb_ok)
                    return processor, model, processor
            except Exception:
                pass
        
        try:
            logging.info(f"Calling AutoTokenizer.from_pretrained('{model_path_str}')...")
            # Use the normalized string path
            # Wrap in try/except to capture ANY exception from transformers
            try:
                tokenizer = AutoTokenizer.from_pretrained(model_path_str)
            except Exception as transformers_ex:
                # Log the actual exception from transformers BEFORE our validation
                import traceback
                logging.error(f"AutoTokenizer.from_pretrained() raised exception: {type(transformers_ex).__name__}: {transformers_ex}")
                logging.error("Full traceback from transformers:")
                logging.error(traceback.format_exc())
                # Re-raise with more context
                raise RuntimeError(
                    f"Failed to load tokenizer from '{model_path_str}': {type(transformers_ex).__name__}: {transformers_ex}\n"
                    f"This is the actual exception from transformers library.\n"
                    f"Please check the server logs above for the full traceback."
                ) from transformers_ex
            
            # Log what we actually got
            logging.info(f"AutoTokenizer.from_pretrained() returned: type={type(tokenizer)}, value={tokenizer!r}")
            
            # Immediate validation: check if tokenizer is actually a tokenizer object
            if tokenizer is None or tokenizer is False:
                # This should NEVER happen - AutoTokenizer.from_pretrained() either returns a tokenizer or raises an exception
                import traceback
                logging.error("CRITICAL: AutoTokenizer.from_pretrained() returned False/None without raising exception!")
                logging.error("This indicates a serious bug. Full context:")
                logging.error(traceback.format_stack())
                raise RuntimeError(
                    f"AutoTokenizer.from_pretrained() returned invalid value: {tokenizer!r}\n"
                    f"Type: {type(tokenizer)}\n"
                    f"Model path: {model_path_str}\n"
                    f"CRITICAL: This should never happen - transformers library should raise an exception, not return False.\n"
                    f"This may indicate:\n"
                    f"  1. A bug in the transformers library\n"
                    f"  2. Corrupted model files\n"
                    f"  3. Missing tokenizer files\n"
                    f"  4. Incompatible transformers version\n"
                    f"Please check the server logs for the full exception traceback above."
                )
            if not hasattr(tokenizer, 'pad_token') and not hasattr(tokenizer, 'eos_token'):
                raise RuntimeError(
                    f"AutoTokenizer.from_pretrained() returned invalid object (type: {type(tokenizer)}).\n"
                    f"Expected AutoTokenizer instance, got: {tokenizer!r}\n"
                    f"Model path: {model_path_str}\n"
                    f"This may indicate corrupted model files or incompatible transformers version."
                )
        except Exception as e:
            # Log full traceback for debugging
            import traceback
            logging.error(f"Exception during tokenizer load from '{model_path_str}': {type(e).__name__}: {e}")
            logging.error("Full traceback:")
            logging.error(traceback.format_exc())
            error_msg = str(e)
            error_lower = error_msg.lower()
            if "not a string" in error_lower:
                # This is a transformers library error - provide more context
                import traceback
                logging.error("Full traceback:")
                logging.error(traceback.format_exc())
                raise ValueError(
                    f"Transformers library error: 'not a string' when loading model.\n"
                    f"Path: {model_path_str!r}\n"
                    f"Path type: {type(model_path_str)}\n"
                    f"Path length: {len(model_path_str)}\n"
                    f"Path exists: {os.path.exists(model_path_str) if is_local_path else 'N/A (HF model ID)'}\n"
                    f"Path is directory: {os.path.isdir(model_path_str) if is_local_path else 'N/A'}\n"
                    f"Original error: {error_msg}\n"
                    f"This may indicate a corrupted model, missing files, or incompatible transformers version."
                )
            raise
        logging.info("Tokenizer loaded from base model")
        
        # Validate tokenizer is actually a tokenizer object
        if tokenizer is None or tokenizer is False:
            raise RuntimeError(
                f"Tokenizer is invalid after loading from base model: {tokenizer!r}\n"
                f"Model path: {model_path_str}\n"
                f"This may indicate a corrupted model, missing tokenizer files, or a transformers library bug."
            )
        if not hasattr(tokenizer, 'pad_token') and not hasattr(tokenizer, 'eos_token'):
            raise RuntimeError(
                f"Tokenizer is not a valid tokenizer object (type: {type(tokenizer)}). "
                f"Expected AutoTokenizer instance, got: {tokenizer!r}\n"
                f"Model path: {model_path_str}\n"
                f"This may indicate corrupted model files or incompatible transformers version."
            )
        
        # Ensure pad token is set
        if tokenizer.pad_token is None:
            tokenizer.pad_token = tokenizer.eos_token
            logging.info(f"Set pad_token to eos_token: {tokenizer.eos_token}")
        
        # Detect GPTQ models early.
        # GPTQ models must be loaded with auto-gptq; they should NOT go through bitsandbytes 4-bit or FP16 fallback.
        is_gptq = False
        try:
            is_gptq = (
                os.path.exists(os.path.join(model_path_str, "quantize_config.json"))
                or os.path.exists(os.path.join(model_path_str, "quantize_config.json".replace("-", "_")))
            )
        except Exception:
            is_gptq = False

        if is_gptq:
            logging.info("GPTQ quantized model detected, using auto-gptq loader (bypassing bitsandbytes/FP16 paths)")
            try:
                from auto_gptq import AutoGPTQForCausalLM

                # Heuristic: prefer safetensors if present
                use_safetensors = False
                try:
                    for fn in os.listdir(model_path_str):
                        if fn.lower().endswith(".safetensors"):
                            use_safetensors = True
                            break
                except Exception:
                    use_safetensors = False

                device = "cuda:0" if torch.cuda.is_available() else "cpu"
                gptq_kwargs = dict(
                    model_name_or_path=model_path_str,
                    device=device,
                    device_map="auto" if torch.cuda.is_available() else None,
                    low_cpu_mem_usage=True,
                    use_triton=False,
                    # Transformers >=4.50 uses a newer LlamaAttention implementation that is not compatible
                    # with auto-gptq's fused attention/mlp injection. Disable these injections.
                    inject_fused_attention=False,
                    inject_fused_mlp=False,
                    use_safetensors=use_safetensors,
                    trust_remote_code=True,
                )
                # When CUDA extension is not installed, ExLLaMA kernels can crash (0xC0000005 on Windows).
                # Disable them to use the stable PyTorch fallback path.
                gptq_kwargs["disable_exllama"] = True
                gptq_kwargs["disable_exllamav2"] = True
                try:
                    model = AutoGPTQForCausalLM.from_quantized(**gptq_kwargs)
                except TypeError:
                    # Older auto-gptq may not support disable_exllama/disable_exllamav2
                    gptq_kwargs.pop("disable_exllama", None)
                    gptq_kwargs.pop("disable_exllamav2", None)
                    model = AutoGPTQForCausalLM.from_quantized(**gptq_kwargs)
                return tokenizer, model, None
            except Exception as gptq_ex:
                logging.error(f"auto-gptq load failed: {type(gptq_ex).__name__}: {gptq_ex}")
                raise RuntimeError(
                    "Failed to load GPTQ model with auto-gptq. "
                    "This model is GPTQ-quantized and cannot be safely loaded via bitsandbytes 4-bit or FP16 fallback. "
                    f"Underlying error: {type(gptq_ex).__name__}: {gptq_ex}"
                ) from gptq_ex

        # Windows: Transformers allocator warmup can request a huge contiguous CUDA allocation and fail with OOM
        # even when the model would otherwise fit. Make it best-effort: if warmup OOMs, continue without warmup.
        def _patch_transformers_allocator_warmup() -> None:
            try:
                import transformers.modeling_utils as modeling_utils  # type: ignore
                if not hasattr(modeling_utils, "caching_allocator_warmup"):
                    return
                orig = modeling_utils.caching_allocator_warmup

                def _wrapped(*args, **kwargs):
                    try:
                        return orig(*args, **kwargs)
                    except Exception as e:
                        msg = str(e).lower()
                        if "out of memory" in msg or "cuda out of memory" in msg:
                            logging.warning(
                                "Transformers caching_allocator_warmup hit OOM; continuing without warmup "
                                "(model may still load successfully)."
                            )
                            return None
                        raise

                modeling_utils.caching_allocator_warmup = _wrapped
            except Exception:
                return

        if IS_WINDOWS:
            _patch_transformers_allocator_warmup()

        def _is_windows_paging_file_too_small(ex: Exception) -> bool:
            if not IS_WINDOWS:
                return False
            try:
                if isinstance(ex, OSError) and getattr(ex, "winerror", None) == 1455:
                    return True
            except Exception:
                pass
            msg = str(ex).lower()
            return ("paging file is too small" in msg) or ("os error 1455" in msg) or ("winerror 1455" in msg)

        def _raise_windows_paging_file_help(ex: Exception) -> None:
            raise RuntimeError(
                "Windows virtual memory (paging file) is too small to load this model (WinError 1455).\n"
                "This typically happens when safetensors memory-maps large checkpoint shards.\n\n"
                "Fix:\n"
                "- Increase your paging file size (System Properties → Advanced → Performance → Settings → Advanced → Virtual memory)\n"
                "- Prefer 'System managed size' or set a larger custom size\n"
                "- Ensure you have enough free disk space on the drive hosting the paging file\n"
                "- Reboot Windows after changing the paging file\n\n"
                f"Underlying error: {type(ex).__name__}: {ex}"
            ) from ex

        # Load base model
        # Previously we disabled bitsandbytes on Windows unconditionally.
        # Now: enable 4-bit on Windows when bitsandbytes is importable (we install/fix it in our environment).
        bnb_ok = _bitsandbytes_available()
        if use_4bit and (not IS_WINDOWS or bnb_ok):
            if IS_WINDOWS:
                logging.info("Windows detected - bitsandbytes available, using 4-bit quantization")
            else:
                logging.info("Loading with 4-bit quantization (non-Windows)")
            bnb_config = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_compute_dtype=torch.float16,
            )
            try:
                model = AutoModelForCausalLM.from_pretrained(
                    model_path_str,
                    quantization_config=bnb_config,
                    trust_remote_code=True,
                )
            except ImportError as e:
                error_str = str(e).lower()
                if "timm" in error_str:
                    logging.error("Vision model requires 'timm' package")
                    logging.error("Please run: pip install timm>=0.9.0")
                    raise RuntimeError("Missing dependency: timm. Install with: pip install timm>=0.9.0")
                elif "einops" in error_str:
                    logging.error("Model requires 'einops' package")
                    logging.error("Please run: pip install einops>=0.6.0")
                    raise RuntimeError("Missing dependency: einops. Install with: pip install einops>=0.6.0")
                elif "open_clip" in error_str or "open-clip" in error_str:
                    logging.error("CLIP-based model requires 'open-clip-torch' package")
                    logging.error("Please run: pip install open-clip-torch>=2.20.0")
                    raise RuntimeError("Missing dependency: open-clip-torch. Install with: pip install open-clip-torch>=2.20.0")
                elif "causal_conv1d" in error_str or "mamba_ssm" in error_str:
                    logging.error("Mamba/SSM architecture model requires 'causal_conv1d' and 'mamba_ssm' packages")
                    logging.error("These packages should have been installed automatically by the installer.")
                    logging.error("If they are missing, please run the installer again or use a model that doesn't require Mamba/SSM.")
                    logging.error("Note: These packages are difficult to install manually on Windows and require CUDA toolkit compilation.")
                    raise RuntimeError("Missing dependency: causal_conv1d/mamba_ssm. These should be installed automatically by the installer. Please run the installer again or use a different model.")
                raise
            except Exception as e:
                if _is_windows_paging_file_too_small(e):
                    _raise_windows_paging_file_help(e)
                # Fallback to non-quantized
                # IMPORTANT: log the underlying cause; otherwise "re-onboarding did nothing" is impossible to debug.
                logging.warning(f"4-bit loading failed ({type(e).__name__}: {e}), falling back to FP16")
                logging.exception("4-bit loading exception details:")
                try:
                    model = AutoModelForCausalLM.from_pretrained(
                        model_path_str,
                        torch_dtype=torch.float16,
                        # Use auto device map to avoid large contiguous allocations when memory is fragmented.
                        device_map="auto",
                        low_cpu_mem_usage=True,
                        trust_remote_code=True,
                    )
                except Exception as fp16_ex:
                    if _is_windows_paging_file_too_small(fp16_ex):
                        _raise_windows_paging_file_help(fp16_ex)
                    raise
        else:
            # No 4-bit: use FP16 on CUDA/CPU
            if IS_WINDOWS and use_4bit and not bnb_ok:
                # IMPORTANT:
                # GPTQ models are already quantized and should NOT fall back to FP16 just because
                # bitsandbytes is unavailable on Windows. Use auto-gptq to load them.
                try:
                    is_gptq = os.path.exists(os.path.join(model_path_str, "quantize_config.json")) or os.path.exists(
                        os.path.join(model_path_str, "quantize_config.json".replace("-", "_"))
                    )
                except Exception:
                    is_gptq = False

                if is_gptq:
                    logging.info("Windows detected - GPTQ quantized model detected, using auto-gptq loader")
                    try:
                        from auto_gptq import AutoGPTQForCausalLM

                        # Heuristic: prefer safetensors if present
                        use_safetensors = False
                        try:
                            for fn in os.listdir(model_path_str):
                                if fn.lower().endswith(".safetensors"):
                                    use_safetensors = True
                                    break
                        except Exception:
                            use_safetensors = False

                        device = "cuda:0" if torch.cuda.is_available() else "cpu"
                        gptq_kwargs = dict(
                            model_name_or_path=model_path_str,
                            device=device,
                            device_map="auto" if torch.cuda.is_available() else None,
                            low_cpu_mem_usage=True,
                            use_triton=False,
                            inject_fused_attention=False,
                            inject_fused_mlp=False,
                            use_safetensors=use_safetensors,
                            trust_remote_code=True,
                        )
                        gptq_kwargs["disable_exllama"] = True
                        gptq_kwargs["disable_exllamav2"] = True
                        try:
                            model = AutoGPTQForCausalLM.from_quantized(**gptq_kwargs)
                        except TypeError:
                            gptq_kwargs.pop("disable_exllama", None)
                            gptq_kwargs.pop("disable_exllamav2", None)
                            model = AutoGPTQForCausalLM.from_quantized(**gptq_kwargs)
                        return tokenizer, model, None
                    except Exception as gptq_ex:
                        logging.error(f"auto-gptq load failed: {type(gptq_ex).__name__}: {gptq_ex}")
                        # IMPORTANT: Do not fall back to FP16 for GPTQ models.
                        # FP16 fallback triggers Transformers' GPTQ quantizer path (optimum.gptq), which is broken
                        # on Windows without gptqmodel. Surface the real auto-gptq failure instead.
                        raise RuntimeError(
                            "Failed to load GPTQ model with auto-gptq. "
                            "This model is GPTQ-quantized and cannot be safely loaded via FP16 fallback on Windows. "
                            f"Underlying error: {type(gptq_ex).__name__}: {gptq_ex}"
                        )

                logging.info("Windows detected - bitsandbytes not available, falling back to FP16")
            else:
                logging.info("Loading without quantization")
            
            try:
                model = AutoModelForCausalLM.from_pretrained(
                    model_path_str,
                    torch_dtype=torch.float16,
                    device_map="cuda" if torch.cuda.is_available() else "cpu",
                    low_cpu_mem_usage=True,
                    trust_remote_code=True,
                )
            except ImportError as e:
                error_str = str(e).lower()
                if "timm" in error_str:
                    logging.error("Vision model requires 'timm' package")
                    logging.error("Please run: pip install timm>=0.9.0")
                    raise RuntimeError("Missing dependency: timm. Install with: pip install timm>=0.9.0")
                elif "einops" in error_str:
                    logging.error("Model requires 'einops' package")
                    logging.error("Please run: pip install einops>=0.6.0")
                    raise RuntimeError("Missing dependency: einops. Install with: pip install einops>=0.6.0")
                elif "open_clip" in error_str or "open-clip" in error_str:
                    logging.error("CLIP-based model requires 'open-clip-torch' package")
                    logging.error("Please run: pip install open-clip-torch>=2.20.0")
                    raise RuntimeError("Missing dependency: open-clip-torch. Install with: pip install open-clip-torch>=2.20.0")
                elif "causal_conv1d" in error_str or "mamba_ssm" in error_str:
                    logging.error("Mamba/SSM architecture model requires 'causal_conv1d' and 'mamba_ssm' packages")
                    logging.error("These packages should have been installed automatically by the installer.")
                    logging.error("If they are missing, please run the installer again or use a model that doesn't require Mamba/SSM.")
                    logging.error("Note: These packages are difficult to install manually on Windows and require CUDA toolkit compilation.")
                    raise RuntimeError("Missing dependency: causal_conv1d/mamba_ssm. These should be installed automatically by the installer. Please run the installer again or use a different model.")
                raise
            except Exception as e:
                if _is_windows_paging_file_too_small(e):
                    _raise_windows_paging_file_help(e)
                raise
        
        return tokenizer, model, None
    
    # Check if adapter_dir is a checkpoint subdirectory and use parent if so
    if "checkpoint-" in adapter_dir and os.path.basename(adapter_dir).startswith("checkpoint-"):
        logging.info(f"Detected checkpoint subdirectory, using parent: {os.path.dirname(adapter_dir)}")
        adapter_dir = os.path.dirname(adapter_dir)
    
    # Check if adapter_dir exists and has required files
    import os
    if not os.path.exists(adapter_dir):
        raise RuntimeError(f"Adapter directory not found: {adapter_dir}")
    
    # Check for adapter files (adapter_model.safetensors, adapter_model.bin, or pytorch_model.bin)
    adapter_files = ["adapter_model.safetensors", "adapter_model.bin", "adapter_config.json"]
    has_adapter_files = any(os.path.exists(os.path.join(adapter_dir, f)) for f in adapter_files)
    
    if not has_adapter_files:
        logging.error(f"Adapter directory '{adapter_dir}' exists but contains no adapter weights!")
        logging.error(f"Expected files: {', '.join(adapter_files)}")
        logging.info(f"Directory contents: {os.listdir(adapter_dir)}")
        raise RuntimeError(
            f"Incomplete adapter checkpoint at '{adapter_dir}'.\n"
            f"The directory exists but contains no model weights.\n"
            f"Please complete the training or select a different checkpoint."
        )
    
    # Try loading tokenizer from adapter dir first, then base model
    try:
        logging.info(f"Loading tokenizer from adapter dir: {adapter_dir}")
        if not isinstance(adapter_dir, str):
            raise ValueError(f"adapter_dir must be a string, got: {type(adapter_dir)} = {adapter_dir!r}")
        
        # Pre-flight check for adapter dir
        if os.path.exists(adapter_dir) and os.path.isdir(adapter_dir):
            tokenizer_config = os.path.join(adapter_dir, "tokenizer_config.json")
            if not os.path.exists(tokenizer_config):
                logging.warning(f"tokenizer_config.json not found in adapter dir: {adapter_dir}")
        
        try:
            logging.info(f"Calling AutoTokenizer.from_pretrained('{adapter_dir}')...")
            # Wrap in try/except to capture ANY exception from transformers
            try:
                tokenizer = AutoTokenizer.from_pretrained(adapter_dir)
            except Exception as transformers_ex:
                # Log the actual exception from transformers BEFORE our validation
                import traceback
                logging.error(f"AutoTokenizer.from_pretrained() raised exception: {type(transformers_ex).__name__}: {transformers_ex}")
                logging.error("Full traceback from transformers:")
                logging.error(traceback.format_exc())
                # Re-raise with more context
                raise RuntimeError(
                    f"Failed to load tokenizer from adapter dir '{adapter_dir}': {type(transformers_ex).__name__}: {transformers_ex}\n"
                    f"This is the actual exception from transformers library.\n"
                    f"Please check the server logs above for the full traceback."
                ) from transformers_ex
            
            # Log what we actually got
            logging.info(f"AutoTokenizer.from_pretrained() returned: type={type(tokenizer)}, value={tokenizer!r}")
            
            # Immediate validation: check if tokenizer is actually a tokenizer object
            if tokenizer is None or tokenizer is False:
                # This should NEVER happen - AutoTokenizer.from_pretrained() either returns a tokenizer or raises an exception
                import traceback
                logging.error("CRITICAL: AutoTokenizer.from_pretrained() returned False/None without raising exception!")
                logging.error("This indicates a serious bug. Full context:")
                logging.error(traceback.format_stack())
                raise RuntimeError(
                    f"AutoTokenizer.from_pretrained() returned invalid value: {tokenizer!r}\n"
                    f"Type: {type(tokenizer)}\n"
                    f"Adapter dir: {adapter_dir}\n"
                    f"CRITICAL: This should never happen - transformers library should raise an exception, not return False.\n"
                    f"This may indicate:\n"
                    f"  1. A bug in the transformers library\n"
                    f"  2. Corrupted adapter files\n"
                    f"  3. Missing tokenizer files\n"
                    f"  4. Incompatible transformers version\n"
                    f"Please check the server logs for the full exception traceback above."
                )
            if not hasattr(tokenizer, 'pad_token') and not hasattr(tokenizer, 'eos_token'):
                raise RuntimeError(
                    f"AutoTokenizer.from_pretrained() returned invalid object (type: {type(tokenizer)}).\n"
                    f"Expected AutoTokenizer instance, got: {tokenizer!r}\n"
                    f"Adapter dir: {adapter_dir}\n"
                    f"This may indicate corrupted adapter files or incompatible transformers version."
                )
            
            logging.info("Tokenizer loaded from adapter dir")
        except Exception as tokenizer_ex:
            # Log full traceback for debugging
            import traceback
            logging.error(f"Exception during tokenizer load from adapter dir '{adapter_dir}': {type(tokenizer_ex).__name__}: {tokenizer_ex}")
            logging.error("Full traceback:")
            logging.error(traceback.format_exc())
            raise  # Re-raise to trigger fallback to base model
            
    except Exception as e:
        logging.warning(f"Could not load tokenizer from adapter dir: {type(e).__name__}: {e}")
        logging.info(f"Loading tokenizer from base model: {model_path_str}")
        try:
            # Pre-flight check for base model path
            if is_local_path:
                if not os.path.exists(model_path_str):
                    raise FileNotFoundError(
                        f"Base model path does not exist: {model_path_str}\n"
                        f"Failed to load from adapter dir, and base model path is also invalid."
                    )
            
            logging.info(f"Calling AutoTokenizer.from_pretrained('{model_path_str}')...")
            # Wrap in try/except to capture ANY exception from transformers
            try:
                tokenizer = AutoTokenizer.from_pretrained(model_path_str)
            except Exception as transformers_ex:
                # Log the actual exception from transformers BEFORE our validation
                import traceback
                logging.error(f"AutoTokenizer.from_pretrained() raised exception: {type(transformers_ex).__name__}: {transformers_ex}")
                logging.error("Full traceback from transformers:")
                logging.error(traceback.format_exc())
                # Re-raise with more context
                raise RuntimeError(
                    f"Failed to load tokenizer from base model '{model_path_str}': {type(transformers_ex).__name__}: {transformers_ex}\n"
                    f"This is the actual exception from transformers library.\n"
                    f"Please check the server logs above for the full traceback."
                ) from transformers_ex
            
            # Log what we actually got
            logging.info(f"AutoTokenizer.from_pretrained() returned: type={type(tokenizer)}, value={tokenizer!r}")
            
            # Immediate validation: check if tokenizer is actually a tokenizer object
            if tokenizer is None or tokenizer is False:
                # This should NEVER happen - AutoTokenizer.from_pretrained() either returns a tokenizer or raises an exception
                import traceback
                logging.error("CRITICAL: AutoTokenizer.from_pretrained() returned False/None without raising exception!")
                logging.error("This indicates a serious bug. Full context:")
                logging.error(traceback.format_stack())
                raise RuntimeError(
                    f"AutoTokenizer.from_pretrained() returned invalid value: {tokenizer!r}\n"
                    f"Type: {type(tokenizer)}\n"
                    f"Base model path: {model_path_str}\n"
                    f"CRITICAL: This should never happen - transformers library should raise an exception, not return False.\n"
                    f"This may indicate:\n"
                    f"  1. A bug in the transformers library\n"
                    f"  2. Corrupted model files\n"
                    f"  3. Missing tokenizer files\n"
                    f"  4. Incompatible transformers version\n"
                    f"Please check the server logs for the full exception traceback above."
                )
            if not hasattr(tokenizer, 'pad_token') and not hasattr(tokenizer, 'eos_token'):
                raise RuntimeError(
                    f"AutoTokenizer.from_pretrained() returned invalid object (type: {type(tokenizer)}).\n"
                    f"Expected AutoTokenizer instance, got: {tokenizer!r}\n"
                    f"Base model path: {model_path_str}\n"
                    f"This may indicate corrupted model files or incompatible transformers version."
                )
            
            logging.info("Tokenizer loaded from base model")
        except Exception as e2:
            # Log full traceback for debugging
            import traceback
            logging.error(f"Exception during tokenizer load from base model '{model_path_str}': {type(e2).__name__}: {e2}")
            logging.error("Full traceback:")
            logging.error(traceback.format_exc())
            
            error_msg = str(e2)
            if "not a string" in error_msg.lower():
                raise ValueError(f"Invalid model path (not a string): base_model={model_path_str!r} (type: {type(model_path_str)}), adapter_dir={adapter_dir!r} (type: {type(adapter_dir)})")
            raise RuntimeError(
                f"Failed to load tokenizer from both adapter dir and base model.\n"
                f"Adapter dir error: {type(e).__name__}: {e}\n"
                f"Base model error: {type(e2).__name__}: {e2}\n"
                f"Please check the server logs for full tracebacks."
            )
    
    # Validate tokenizer is actually a tokenizer object
    if tokenizer is None or tokenizer is False:
        raise RuntimeError(
            f"Tokenizer is invalid after loading from adapter dir and base model: {tokenizer!r}\n"
            f"Adapter dir: {adapter_dir}, Base model: {model_path_str}\n"
            f"This may indicate corrupted files, missing tokenizer files, or a transformers library bug."
        )
    if not hasattr(tokenizer, 'pad_token') and not hasattr(tokenizer, 'eos_token'):
        raise RuntimeError(
            f"Tokenizer is not a valid tokenizer object (type: {type(tokenizer)}). "
            f"Expected AutoTokenizer instance, got: {tokenizer!r}\n"
            f"Adapter dir: {adapter_dir}, Base model: {model_path_str}\n"
            f"This may indicate corrupted files or incompatible transformers version."
        )
    
    # Ensure pad token is set
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
        logging.info(f"Set pad_token to eos_token: {tokenizer.eos_token}")

    # Load base model without device_map to avoid accelerate compatibility issues
    if use_4bit:
        bnb_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.float16,
        )
        # Check if base model already has quantization - if so, just load it
        try:
            base = AutoModelForCausalLM.from_pretrained(
                model_path_str,
                quantization_config=bnb_config,
                trust_remote_code=True,
            )
        except Exception:
            # Fallback: model already quantized, load without config
            base = AutoModelForCausalLM.from_pretrained(
                model_path_str,
                trust_remote_code=True,
            )
    else:
        base = AutoModelForCausalLM.from_pretrained(
            model_path_str,
            trust_remote_code=True,
        )
        # Move to GPU if available and not quantized
        if torch.cuda.is_available():
            base = base.to("cuda")
            logging.info("Moved base model to GPU")

    # Attach adapter (PEFT) to base model if adapter files exist; otherwise
    # treat adapter_dir as a merged model and load directly.
    try:
        # Prefer local-only loading to avoid treating the path as an HF repo id
        # Import peft lazily so base-model loads don't fail when peft/transformers versions differ.
        try:
            from peft import PeftModel  # type: ignore
        except Exception as e:
            raise RuntimeError(
                f"Adapter loading requires 'peft' but it could not be imported: {e}\n"
                f"Please install/repair the environment to include a compatible peft+transformers pair."
            )
        model = PeftModel.from_pretrained(base, adapter_dir, local_files_only=True)
        logging.info("Adapter attached successfully")
        return tokenizer, model, None
    except Exception:
        # Fall back: if adapter_dir is actually a merged model directory, try to load it.
        try:
            # If the merged folder lacks a config, try to fetch config from the provided base_model
            import os
            from transformers import AutoConfig

            config_path = os.path.join(adapter_dir, "config.json")
            if not os.path.exists(config_path):
                # Attempt to read a README front-matter to discover base_model
                base = base_model
                readme_path = os.path.join(adapter_dir, "README.md")
                try:
                    if os.path.exists(readme_path):
                        with open(readme_path, "r", encoding="utf-8") as f:
                            txt = f.read()
                        # crude parse for 'base_model: <name>' in the YAML frontmatter
                        for line in txt.splitlines():
                            line = line.strip()
                            if line.startswith("base_model:"):
                                base = line.split("base_model:", 1)[1].strip()
                                break
                except Exception:
                    pass

                # If we have a base model name, download its config and save locally
                try:
                    cfg = AutoConfig.from_pretrained(base, trust_remote_code=True)
                    cfg.save_pretrained(adapter_dir)
                    logging.info("Fetched and saved config for merged model")
                except Exception:
                    # ignore and try loading directly; the later call will raise a clear error
                    pass

            # Try loading merged model (adapter dir contains full safetensors checkpoint)
            # Prefer CPU-only load to avoid meta-tensor and accelerate version issues
            try:
                merged = AutoModelForCausalLM.from_pretrained(
                    adapter_dir,
                    device_map=None,  # Load on CPU
                    trust_remote_code=True,
                    low_cpu_mem_usage=False,
                )
                # Move to GPU if available
                if torch.cuda.is_available():
                    merged = merged.to("cuda")
                    logging.info("Moved merged model to GPU")
                return tokenizer, merged, None
            except Exception as e:
                # Provide clearer guidance for common environment mismatches
                raise RuntimeError(
                    f"Failed to load merged model from '{adapter_dir}': {e}\n"
                    "Common fixes: Ensure the model checkpoint is complete and compatible with your transformers version.\n"
                )
        except Exception as e:
            # Re-raise original error with context
            raise RuntimeError(f"Failed to load PEFT adapter or merged model from '{adapter_dir}': {e}")


def generate_text(tokenizer, model, prompt, max_new_tokens=128, temperature=0.7, model_type="base", system_prompt=""):
    """Generate text with proper formatting based on model type
    
    Args:
        tokenizer: The tokenizer
        model: The model
        prompt: The user's input text
        max_new_tokens: Maximum tokens to generate
        temperature: Sampling temperature
        model_type: "instruct" or "base" - determines prompt formatting
        system_prompt: Optional system prompt for instruct models
    """
    model.eval()
    device = next(model.parameters()).device
    
    # Check if this is a NemotronH model that requires a cache
    is_nemotron_h = False
    nemotron_cache = None
    try:
        model_class_name = model.__class__.__name__
        config_class_name = model.config.__class__.__name__ if hasattr(model, 'config') else ""
        model_type_attr = getattr(model.config, 'model_type', '').lower() if hasattr(model, 'config') else ""
        architectures = getattr(model.config, 'architectures', []) if hasattr(model, 'config') else []
        arch_str = " ".join(architectures).lower() if architectures else ""
        
        # Check for NemotronH models (various naming conventions)
        # Check model class, config class, model_type, and architectures
        # Also check if the warning message appears (which indicates it's a NemotronH model)
        is_nemotron_model = (
            "nemotron" in model_class_name.lower() or 
            "nemotron" in config_class_name.lower() or 
            "nemotron" in model_type_attr or
            "nemotron" in arch_str or
            "NemotronH" in model_class_name or 
            "NemotronH" in config_class_name or
            "NemotronH" in arch_str
        )
        
        if is_nemotron_model:
            is_nemotron_h = True
            logging.debug(f"Detected Nemotron model: class={model_class_name}, config={config_class_name}, type={model_type_attr}, arch={arch_str}")
            
            # Try multiple import paths for the cache - start with model's own module
            nemotron_cache_class = None
            
            # First: try to get it from the model's own module (most reliable)
            # Nemotron models often have the cache class in their custom modeling file
            try:
                model_module = model.__class__.__module__
                logging.debug(f"Model module: {model_module}")
                if model_module:
                    # The cache class is likely in the same module or a cache_utils submodule
                    # Try multiple strategies to find it
                    
                    # Strategy 1: Check if it's in the same module as the model class
                    try:
                        modeling_module = __import__(model_module, fromlist=["NemotronHHybridDynamicCache"])
                        nemotron_cache_class = getattr(modeling_module, "NemotronHHybridDynamicCache", None)
                        if nemotron_cache_class:
                            logging.info(f"Found NemotronHHybridDynamicCache in model module {model_module}")
                    except (ImportError, AttributeError):
                        pass
                    
                    # Strategy 2: Try cache_utils in various locations relative to the model module
                    if nemotron_cache_class is None:
                        base_module = model_module.rsplit('.', 1)[0]
                        # Try different cache_utils paths
                        cache_paths = [
                            base_module + '.cache_utils',
                            model_module + '.cache_utils',  # Same level as modeling
                        ]
                        # Also try parent packages
                        if '.' in base_module:
                            cache_paths.append(base_module.rsplit('.', 1)[0] + '.cache_utils')
                        # Add standard transformers paths
                        cache_paths.extend([
                            'transformers.models.nemotron_h.cache_utils',
                            'transformers.cache_utils',
                        ])
                        
                        for cache_module_path in cache_paths:
                            try:
                                logging.debug(f"Trying to import from {cache_module_path}")
                                module = __import__(cache_module_path, fromlist=["NemotronHHybridDynamicCache"])
                                nemotron_cache_class = getattr(module, "NemotronHHybridDynamicCache", None)
                                if nemotron_cache_class:
                                    logging.info(f"Found NemotronHHybridDynamicCache in {cache_module_path}")
                                    break
                            except (ImportError, AttributeError) as import_err:
                                logging.debug(f"Failed to import from {cache_module_path}: {import_err}")
                                continue
                    
                    # Strategy 3: Use inspect to find the cache class in the model's module
                    if nemotron_cache_class is None:
                        try:
                            import inspect
                            # Get all members of the modeling module
                            modeling_module = __import__(model_module, fromlist=[])
                            for name, obj in inspect.getmembers(modeling_module):
                                if (inspect.isclass(obj) and 
                                    'NemotronHHybridDynamicCache' in name and 
                                    'Cache' in name):
                                    nemotron_cache_class = obj
                                    logging.info(f"Found cache class via inspect: {name} in {model_module}")
                                    break
                        except Exception as inspect_err:
                            logging.debug(f"Inspect method failed: {inspect_err}")
                    
                    # Strategy 4: Try to get it from the model's config or by inspecting the model class
                    if nemotron_cache_class is None:
                        try:
                            # Some models define the cache class as a class attribute or in the config
                            if hasattr(model.config, 'cache_class'):
                                cache_class_name = model.config.cache_class
                                if cache_class_name:
                                    # Try to import it dynamically
                                    parts = cache_class_name.split('.')
                                    module_name = '.'.join(parts[:-1])
                                    class_name = parts[-1]
                                    if module_name:
                                        cache_module = __import__(module_name, fromlist=[class_name])
                                        nemotron_cache_class = getattr(cache_module, class_name, None)
                                        if nemotron_cache_class:
                                            logging.info(f"Found cache class from config: {cache_class_name}")
                        except Exception:
                            pass
                    
                    # Strategy 5: Try importing from the exact module path that the warning suggests
                    if nemotron_cache_class is None:
                        try:
                            # The warning format suggests: transformers_modules.nvidia.NVIDIA-Nemotron-Nano-9B-v2.xxx.modeling_nemotron_h
                            # Try to construct cache_utils path from modeling path
                            if 'modeling_nemotron' in model_module or 'modeling' in model_module:
                                # Replace 'modeling' with 'cache_utils'
                                cache_module_path = model_module.replace('modeling_nemotron', 'cache_utils').replace('modeling', 'cache_utils')
                                if cache_module_path != model_module:
                                    try:
                                        cache_module = __import__(cache_module_path, fromlist=["NemotronHHybridDynamicCache"])
                                        nemotron_cache_class = getattr(cache_module, "NemotronHHybridDynamicCache", None)
                                        if nemotron_cache_class:
                                            logging.info(f"Found cache class in constructed path: {cache_module_path}")
                                    except (ImportError, AttributeError):
                                        pass
                        except Exception:
                            pass
                            
            except Exception as e:
                logging.debug(f"Error checking model module for cache: {e}")
                import traceback
                logging.debug(traceback.format_exc())
            
            # Second: try standard transformers locations
            if nemotron_cache_class is None:
                import_paths = [
                    "transformers.cache_utils",
                    "transformers.models.nemotron_h.cache_utils",
                    "transformers",
                ]
                
                for import_path in import_paths:
                    try:
                        if import_path == "transformers":
                            from transformers import NemotronHHybridDynamicCache
                        else:
                            module = __import__(import_path, fromlist=["NemotronHHybridDynamicCache"])
                            NemotronHHybridDynamicCache = getattr(module, "NemotronHHybridDynamicCache")
                        nemotron_cache_class = NemotronHHybridDynamicCache
                        logging.info(f"Found NemotronHHybridDynamicCache in {import_path}")
                        break
                    except (ImportError, AttributeError):
                        continue
            
            if nemotron_cache_class is not None:
                try:
                    # Initialize cache with proper parameters
                    # Try with all required parameters first
                    try:
                        nemotron_cache = nemotron_cache_class(
                            config=model.config,
                            max_batch_size=1,  # Single batch for inference
                            max_cache_len=2048,  # Reasonable cache length
                            device=device,
                            dtype=next(model.parameters()).dtype
                        )
                    except TypeError:
                        # If that fails, try with just config
                        try:
                            nemotron_cache = nemotron_cache_class(config=model.config)
                        except TypeError:
                            # If that also fails, try minimal initialization
                            nemotron_cache = nemotron_cache_class()
                    logging.info(f"Initialized NemotronHHybridDynamicCache for {model_class_name}")
                except Exception as e:
                    logging.warning(f"Failed to initialize NemotronHHybridDynamicCache: {e}")
                    import traceback
                    logging.warning(traceback.format_exc())
            else:
                logging.warning("NemotronHHybridDynamicCache class not found - trying alternative methods")
                # Alternative: Check if model has a method to create cache
                try:
                    if hasattr(model, 'create_cache') or hasattr(model, '_create_cache'):
                        cache_method = getattr(model, 'create_cache', None) or getattr(model, '_create_cache', None)
                        if cache_method:
                            try:
                                nemotron_cache = cache_method()
                                logging.info("Created cache using model's create_cache method")
                            except Exception as e:
                                logging.debug(f"Model's create_cache failed: {e}")
                except Exception:
                    pass
                
                # Last resort: Try to find and instantiate from model's __dict__ or class attributes
                if nemotron_cache is None:
                    try:
                        # Check if cache class is a class attribute of the model
                        for attr_name in dir(model.__class__):
                            if 'cache' in attr_name.lower() and 'class' in attr_name.lower():
                                attr = getattr(model.__class__, attr_name)
                                if isinstance(attr, type) and 'Nemotron' in str(attr):
                                    try:
                                        nemotron_cache = attr(config=model.config)
                                        logging.info(f"Created cache from model class attribute {attr_name}")
                                        break
                                    except Exception:
                                        pass
                    except Exception:
                        pass
                
                if nemotron_cache is None:
                    logging.warning("Could not create NemotronHHybridDynamicCache - generation may show warnings")
    except Exception as e:
        logging.debug(f"Error detecting NemotronH model: {e}")
        import traceback
        logging.debug(traceback.format_exc())
    
    # Format prompt based on model type
    if model_type == "instruct":
        # Use chat template for instruct models
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})
        
        try:
            # Use tokenizer's built-in chat template
            # For most models, the template includes the BOS token if needed
            formatted_prompt = tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True
            )
        except Exception as e:
            # Fallback if tokenizer doesn't have chat template - manually format
            logging.warning(f"Chat template not available: {e}. Using manual formatting.")
            if system_prompt:
                formatted_prompt = f"{system_prompt}\n\n{prompt}"
            else:
                formatted_prompt = prompt
    else:
        # Base model - use plain prompt, but prepend system prompt if provided
        if system_prompt:
            formatted_prompt = f"{system_prompt}\n\n{prompt}"
        else:
            formatted_prompt = prompt
    
    # Tokenization strategy:
    # - Instruct/chat templates should generally NOT add special tokens again.
    #   Some tokenizers add an EOS token when add_special_tokens=True, and if the
    #   *last input token is EOS* then HF generation will produce 0 new tokens.
    # - Base models usually should add specials (BOS) for best results.
    add_specials = (model_type != "instruct")
    
    inputs = tokenizer(formatted_prompt, return_tensors="pt", add_special_tokens=add_specials)
    # Safety: if the tokenizer (or template) still caused the prompt to end with EOS,
    # trim it so generation isn't considered "already finished".
    try:
        eos_id = tokenizer.eos_token_id
        if eos_id is not None and inputs.get("input_ids") is not None and inputs["input_ids"].shape[1] > 0:
            if int(inputs["input_ids"][0, -1].item()) == int(eos_id):
                inputs["input_ids"] = inputs["input_ids"][:, :-1]
                if "attention_mask" in inputs and inputs["attention_mask"] is not None and inputs["attention_mask"].shape[1] > 0:
                    inputs["attention_mask"] = inputs["attention_mask"][:, :-1]
    except Exception:
        pass
    inputs = {k: v.to(device) for k, v in inputs.items()}
    
    input_len = inputs["input_ids"].shape[1]
    
    gen_kwargs = {
        "max_new_tokens": max_new_tokens,
        "pad_token_id": tokenizer.pad_token_id if tokenizer.pad_token_id is not None else tokenizer.eos_token_id,
        "eos_token_id": tokenizer.eos_token_id,
        "use_cache": True,  # Enable caching
    }
    
    # Add cache for NemotronH models (must use 'cache' parameter, not 'past_key_values')
    if is_nemotron_h:
        if nemotron_cache is not None:
            gen_kwargs["cache"] = nemotron_cache
            logging.info("Using NemotronHHybridDynamicCache for generation")
        else:
            # If we couldn't create the cache, the model will show a warning but should still work
            # The warning is just informational - the model will work without explicit cache
            logging.warning("NemotronH cache not initialized - model will use default caching (may show warning)")
            # Don't set cache=None as that might cause issues - let the model handle it
    
    # Only add sampling parameters if temperature > 0
    if temperature > 0:
        gen_kwargs["do_sample"] = True
        gen_kwargs["temperature"] = temperature
    else:
        gen_kwargs["do_sample"] = False
    
    with torch.no_grad():
        try:
            out = model.generate(**inputs, **gen_kwargs)
        except Exception as e:
            # Never silently return empty output; propagate so the UI can show the real failure.
            logging.error(f"Generation failed: {e}")
            import traceback
            logging.error(traceback.format_exc())
            try:
                # Best-effort cleanup after CUDA OOM so subsequent attempts can work.
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
            # Improve common CUDA OOM into a concise actionable error.
            try:
                msg = str(e)
                if torch.cuda.is_available() and ("out of memory" in msg.lower() or "cuda out of memory" in msg.lower()):
                    gpu_idx = None
                    try:
                        if hasattr(device, "type") and device.type == "cuda":
                            gpu_idx = int(device.index) if device.index is not None else None
                    except Exception:
                        gpu_idx = None
                    if gpu_idx is None:
                        try:
                            gpu_idx = int(torch.cuda.current_device())
                        except Exception:
                            gpu_idx = 0
                    total_gb = None
                    try:
                        total_gb = torch.cuda.get_device_properties(gpu_idx).total_memory / (1024**3)
                    except Exception:
                        total_gb = None
                    extra = f"GPU {gpu_idx}" + (f" ({total_gb:.1f} GB)" if total_gb else "")
                    raise RuntimeError(
                        f"CUDA out of memory during generation on {extra}. "
                        f"This GPTQ 33B model typically requires ~18.5GB VRAM for inference. "
                        f"Use a smaller model or ensure more VRAM/offloading is available."
                    ) from e
            except RuntimeError:
                raise
            except Exception:
                pass
            raise
    
    # Return only newly generated tokens (exclude prompt)
    gen_ids = out[0][input_len:]
    
    # Detailed diagnostics for empty generation
    num_new_tokens = len(gen_ids)
    total_tokens = len(out[0])
    
    # Decode with and without special tokens for diagnostics
    text_with_specials = tokenizer.decode(gen_ids, skip_special_tokens=False)
    text = tokenizer.decode(gen_ids, skip_special_tokens=True)
    
    # If the model still somehow included the prompt, remove it
    # We do a case-insensitive check and also strip whitespace
    text_clean = text.strip()
    
    # Debug: Check if output is empty
    if not text_clean:
        # Get token IDs for diagnostics
        gen_token_ids = gen_ids.tolist() if hasattr(gen_ids, 'tolist') else list(gen_ids)
        eos_id = tokenizer.eos_token_id
        pad_id = tokenizer.pad_token_id
        
        # Count special tokens in output
        special_count = 0
        if eos_id is not None:
            special_count += gen_token_ids.count(int(eos_id))
        if pad_id is not None and pad_id != eos_id:
            special_count += gen_token_ids.count(int(pad_id))
        
        # Build detailed error message
        error_details = [
            f"Input tokens: {input_len}",
            f"Total output tokens: {total_tokens}",
            f"New tokens generated: {num_new_tokens}",
            f"Special tokens in output: {special_count}",
        ]
        
        if num_new_tokens == 0:
            error_details.append("Generation produced 0 new tokens (model stopped immediately)")
        elif num_new_tokens > 0:
            error_details.append(f"Decoded with specials: {repr(text_with_specials[:200])}")
            error_details.append(f"Decoded without specials: {repr(text[:200])}")
            if eos_id is not None and eos_id in gen_token_ids:
                error_details.append(f"Output contains EOS token (ID: {eos_id})")
            if pad_id is not None and pad_id in gen_token_ids:
                error_details.append(f"Output contains PAD token (ID: {pad_id})")
        
        logging.error(f"Empty generation detected. {' | '.join(error_details)}")
        
        # Do not silently return empty output; propagate to server/UI so it is visible.
        raise RuntimeError(
            f"Empty generation: model produced no visible output.\n\n"
            f"Diagnostics:\n" + "\n".join(f"  • {detail}" for detail in error_details) + "\n\n"
            f"Possible causes:\n"
            f"  • Generation produced 0 new tokens (model stopped immediately)\n"
            f"  • All output tokens were special tokens (EOS/PAD) that were stripped\n"
            f"  • Model ran out of VRAM and silently failed\n"
            f"  • Tokenizer/template issue causing immediate stopping\n\n"
            f"Try:\n"
            f"  • Increasing max_new_tokens (current: {max_new_tokens})\n"
            f"  • Changing the prompt\n"
            f"  • Using a smaller model\n"
            f"  • Checking server logs for CUDA OOM errors"
        )

    return text_clean


def generate_multimodal(processor, model, prompt, images, max_new_tokens=128, temperature=0.7):
    """Generate text from prompt and images using a vision model and processor.

    Args:
        processor: The processor (e.g. from AutoProcessor).
        model: The vision model.
        prompt: User text prompt.
        images: List of PIL.Image (or single image).
        max_new_tokens: Maximum tokens to generate.
        temperature: Sampling temperature (0 = greedy).
    Returns:
        Decoded text string.
    """
    model.eval()
    device = next(model.parameters()).device
    if not isinstance(images, (list, tuple)):
        images = [images]
    # Processor API: text and images (many VLMs use this)
    try:
        inputs = processor(text=prompt, images=images if images else None, return_tensors="pt")
    except TypeError:
        # Some processors expect images= for a single image or different signature
        inputs = processor(text=[prompt], images=images if images else None, return_tensors="pt")
    inputs = {k: v.to(device) for k, v in inputs.items() if hasattr(v, "to")}
    pad_id = getattr(processor, "pad_token_id", None) or getattr(processor.tokenizer, "pad_token_id", None) if hasattr(processor, "tokenizer") else None
    eos_id = getattr(processor, "eos_token_id", None) or getattr(processor.tokenizer, "eos_token_id", None) if hasattr(processor, "tokenizer") else None
    gen_kwargs = {
        "max_new_tokens": max_new_tokens,
        "pad_token_id": pad_id or eos_id,
        "eos_token_id": eos_id,
        "do_sample": temperature > 0,
    }
    if temperature > 0:
        gen_kwargs["temperature"] = temperature
    with torch.no_grad():
        out = model.generate(**inputs, **gen_kwargs)
    # Decode: processor may have decode or tokenizer
    if hasattr(processor, "decode"):
        text = processor.decode(out[0], skip_special_tokens=True)
    elif hasattr(processor, "batch_decode"):
        text = processor.batch_decode(out, skip_special_tokens=True)[0]
    elif hasattr(processor, "tokenizer"):
        text = processor.tokenizer.decode(out[0], skip_special_tokens=True)
    else:
        text = str(out[0].tolist())
    return text.strip()
