import argparse
import os
import sys
import json
import re
# IMPORTANT: pick the target GPU BEFORE 'import torch' so the CUDA
# runtime sees only the GPUs we want. Once torch has been imported and
# torch.cuda has been touched, CUDA_VISIBLE_DEVICES is read once and
# cached — setting it later is a silent no-op. This block honours an
# already-set CUDA_VISIBLE_DEVICES (the GUI sets it from the Train
# tab's dropdown) and only auto-picks when nothing was set externally.
def _autoselect_single_gpu_pre_torch() -> None:
    if os.environ.get("CUDA_VISIBLE_DEVICES"):
        return  # respect external selection
    try:
        import subprocess as _sp
        out = _sp.run(
            ["nvidia-smi", "--query-gpu=index,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
            creationflags=(0x08000000 if sys.platform == "win32" else 0),
        )
        if out.returncode != 0 or not out.stdout.strip():
            return
        rows = []
        for line in out.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 2 and parts[0].isdigit():
                try:
                    rows.append((int(parts[0]), int(parts[1])))
                except ValueError:
                    pass
        if not rows:
            return
        if len(rows) == 1:
            return  # single GPU; nothing to choose
        biggest = max(rows, key=lambda r: r[1])
        os.environ["CUDA_VISIBLE_DEVICES"] = str(biggest[0])
        os.environ.setdefault("CUDA_DEVICE_ORDER", "PCI_BUS_ID")
        # Stash a friendly note for main() to log.
        os.environ["_OWLLM_AUTO_GPU_NOTE"] = (
            f"auto-pinned to GPU {biggest[0]} ({biggest[1]} MiB) — "
            f"set CUDA_VISIBLE_DEVICES upstream to override"
        )
    except Exception:
        pass


_autoselect_single_gpu_pre_torch()

import torch
import io
import shutil
import time
from pathlib import Path
from datetime import datetime

# Fix Windows console encoding for emojis and ensure unbuffered output for real-time GUI updates
if sys.platform == "win32":
    # On Windows, we need to ensure the standard streams are using UTF-8
    # and we'll use manual flushing in our print function
    try:
        # Use reconfigure if available (Python 3.7+)
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, io.UnsupportedOperation):
        pass
else:
    # On Unix, ensure unbuffered output
    try:
        sys.stdout.reconfigure(line_buffering=False)
        sys.stderr.reconfigure(line_buffering=False)
    except (AttributeError, io.UnsupportedOperation):
        pass

# Create a print function that always flushes for real-time GUI updates
_original_print = print
def print(*args, **kwargs):
    """Print function that always flushes for real-time GUI updates"""
    _original_print(*args, **kwargs)
    try:
        sys.stdout.flush()
        if 'file' in kwargs and kwargs['file'] is sys.stderr:
            sys.stderr.flush()
    except (AttributeError, io.UnsupportedOperation):
        pass

# Check if bitsandbytes can be used
# Note: bitsandbytes 0.45.5+ fixed the triton.ops compatibility issue
# This check is kept for graceful fallback if bitsandbytes is unavailable
def check_bitsandbytes_available():
    """Check if bitsandbytes can be imported and used"""
    try:
        import bitsandbytes
        # Try a simple import to verify it works
        from bitsandbytes.nn import Linear8bitLt
        return True
    except (ImportError, ModuleNotFoundError, Exception):
        return False

BITSANDBYTES_AVAILABLE = check_bitsandbytes_available()

# Default to offline W&B unless explicitly enabled via --enable-wandb or env var
if "--enable-wandb" not in sys.argv and "WANDB_MODE" not in os.environ:
    os.environ["WANDB_MODE"] = "offline"

# If Weave is available, import it so W&B can enable Weave features locally
try:
    import weave  # type: ignore
    print("Weave imported: enhanced LLM call tracing enabled (local).")
except Exception:
    # weave is optional; continue without it
    pass

# Import unsloth at the top (as requested)
try:
    import unsloth
    from unsloth import FastLanguageModel
    HAS_UNSLOTH = True
except (ImportError, NotImplementedError, Exception) as e:
    HAS_UNSLOTH = False
    FastLanguageModel = None
    # Don't print error here, we'll handle it in main() if unsloth is requested

# Always import transformers classes - we may need them even if unsloth is available (fallback)
from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments, BitsAndBytesConfig
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from trl import SFTTrainer
from datasets import load_dataset
from transformers import TrainerCallback, TrainerState, TrainerControl

# Import compatibility module for runtime capability detection
from core.model_compatibility import (
    detect_model_type,
    check_peft_capabilities,
    check_unsloth_capabilities,
    check_bitsandbytes_capabilities,
    get_compatible_peft_params,
    get_compatible_unsloth_params,
    get_optimal_loading_strategy
)


def detect_file_format(file_path: str) -> str:
    """Detect if file is JSON or JSONL format.
    Returns: 'json', 'jsonl', or 'auto'
    """
    # Check extension first
    ext = Path(file_path).suffix.lower()
    if ext == '.jsonl':
        return 'jsonl'
    if ext == '.json':
        # Try to parse as JSON first
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                json.load(f)
            return 'json'
        except (json.JSONDecodeError, ValueError):
            # If JSON fails, assume JSONL
            return 'jsonl'
    # Default: try JSON first, fallback to JSONL
    return 'auto'


def load_jsonl(file_path: str, skip_errors: bool = True) -> list:
    """Load JSONL file (one JSON object per line).
    
    Args:
        file_path: Path to JSONL file
        skip_errors: If True, skip malformed lines with warning. If False, raise on first error.
    
    Returns:
        List of parsed JSON objects
    """
    data = []
    with open(file_path, 'r', encoding='utf-8') as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:  # Skip empty lines
                continue
            try:
                obj = json.loads(line)
                data.append(obj)
            except json.JSONDecodeError as e:
                if skip_errors:
                    print(f"⚠ Warning: Skipping malformed line {line_num}: {e}")
                    continue
                else:
                    raise ValueError(f"Malformed JSON on line {line_num}: {e}") from e
    return data


def cleanup_old_adapters(adapters_dir: Path, keep_latest: int = 10):
    """
    Clean up old adapters, keeping only the N latest successful ones.
    
    Args:
        adapters_dir: Directory containing adapters
        keep_latest: Number of latest adapters to keep (default: 10)
    """
    if not adapters_dir.exists():
        return
    
    # Get all valid adapters sorted by modification time
    adapters = []
    for adapter_dir in adapters_dir.iterdir():
        if not adapter_dir.is_dir():
            continue
        
        # Check if it's a valid adapter (has required files)
        adapter_config = adapter_dir / "adapter_config.json"
        adapter_model = adapter_dir / "adapter_model.safetensors"
        if not adapter_model.exists():
            adapter_model = adapter_dir / "adapter_model.bin"
        
        if adapter_config.exists() and adapter_model.exists():
            # Get modification time from the adapter model file
            mtime = adapter_model.stat().st_mtime
            adapters.append((mtime, adapter_dir))
    
    if len(adapters) <= keep_latest:
        return  # Nothing to clean up
    
    # Sort by modification time (newest first)
    adapters.sort(reverse=True)
    
    # Remove old adapters (keep only latest N)
    removed_count = 0
    for mtime, adapter_dir in adapters[keep_latest:]:
        try:
            print(f"[CLEANUP] Removing old adapter: {adapter_dir.name}")
            shutil.rmtree(adapter_dir)
            removed_count += 1
        except Exception as e:
            print(f"[CLEANUP] Warning: Failed to remove {adapter_dir.name}: {e}")
    
    if removed_count > 0:
        print(f"[CLEANUP] Cleaned up {removed_count} old adapter(s), kept {keep_latest} latest")


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--model-name", default="unsloth/llama-3.2-3b-instruct-unsloth-bnb-4bit")
    p.add_argument("--max-seq-length", type=int, default=2048)
    p.add_argument("--data-path", default="train_data.jsonl")
    p.add_argument("--output-dir", default="./fine_tuned")
    p.add_argument("--lora-r", type=int, default=8)
    p.add_argument("--lora-alpha", type=int, default=16)
    p.add_argument("--lora-dropout", type=float, default=0.05)
    p.add_argument("--batch-size", type=int, default=1)
    p.add_argument("--grad-accum", type=int, default=8)
    p.add_argument("--epochs", type=int, default=1)
    p.add_argument("--learning-rate", type=float, default=2e-4, help="Learning rate for training")
    p.add_argument("--max-examples", type=int, default=None, help="Limit dataset for quick runs")
    p.add_argument("--use-unsloth", action="store_true", default=True, help="Use unsloth for faster training (if available)")
    p.add_argument("--no-unsloth", dest="use_unsloth", action="store_false", help="Disable unsloth even if available")
    p.add_argument("--strict-jsonl", action="store_true", default=False,
                   help="Fail on malformed JSONL lines instead of skipping")
    return p.parse_args()


def _should_use_bf16() -> bool:
    """True when the active CUDA device supports bf16 natively.

    Ampere (compute capability >= 8.0) supports bf16 in hardware. Older
    cards (Pascal, Volta, Turing) fall back to fp32 emulation if bf16
    is requested, which is slower and pointless. Default OFF on those.
    """
    try:
        if not torch.cuda.is_available():
            return False
        if torch.cuda.device_count() == 0:
            return False
        major, _ = torch.cuda.get_device_capability(0)
        return major >= 8
    except Exception:
        return False


def main():
    args = parse_args()

    # Determine if we should use unsloth
    use_unsloth = HAS_UNSLOTH and args.use_unsloth
    if not use_unsloth:
        if args.use_unsloth and not HAS_UNSLOTH:
            print("[INFO] Unsloth requested but not found. Falling back to standard PEFT.")
        else:
            print("[INFO] Using standard PEFT training.")
    else:
        print("[INFO] Using Unsloth for optimized training.")

    MODEL_NAME = args.model_name
    MAX_SEQ_LENGTH = args.max_seq_length
    DATASET_PATH = args.data_path
    OUTPUT_DIR = args.output_dir

    # GPU enumeration AFTER pre-torch auto-select has already had its
    # say. CUDA_VISIBLE_DEVICES was set (by the GUI's gpu_select widget,
    # OR by our nvidia-smi pre-torch fallback). torch.cuda's view of
    # devices below already reflects that.
    auto_note = os.environ.pop("_OWLLM_AUTO_GPU_NOTE", "")
    if auto_note:
        print(f"[INFO] {auto_note}")
    try:
        cuda_vis = os.environ.get("CUDA_VISIBLE_DEVICES", "(not set)")
        cuda_order = os.environ.get("CUDA_DEVICE_ORDER", "(not set)")
        print(f"[INFO] CUDA_VISIBLE_DEVICES={cuda_vis} | CUDA_DEVICE_ORDER={cuda_order}")
        if torch.cuda.is_available():
            dev_count = torch.cuda.device_count()
            print(f"[INFO] torch sees {dev_count} CUDA device(s) "
                  f"(post CUDA_VISIBLE_DEVICES filter)")
            for i in range(dev_count):
                name = torch.cuda.get_device_name(i)
                try:
                    mem_total = torch.cuda.get_device_properties(i).total_memory
                    mem_gb = mem_total / (1024 ** 3)
                    print(f"[INFO]   cuda:{i} -> {name} ({mem_gb:.1f} GB)")
                except Exception:
                    print(f"[INFO]   cuda:{i} -> {name}")
            print(f"[INFO] Default torch device: cuda:0 => {torch.cuda.get_device_name(0)}")
        else:
            print("[INFO] torch.cuda.is_available() == False")
    except Exception as e:
        print(f"[WARN] Failed to log CUDA devices: {e}")

    LORA_R = args.lora_r
    LORA_ALPHA = args.lora_alpha
    LORA_DROPOUT = args.lora_dropout
    BATCH_SIZE = args.batch_size
    GRADIENT_ACCUMULATION = args.grad_accum
    LEARNING_RATE = args.learning_rate

    if not os.path.exists(DATASET_PATH):
        print(f"[ERROR] Dataset file not found: {DATASET_PATH}")
        sys.exit(1)

    print(f"[INFO] Loading model and tokenizer: {MODEL_NAME}")

    # Use compatibility module to detect model type and capabilities
    model_info = detect_model_type(MODEL_NAME)
    peft_caps = check_peft_capabilities()
    unsloth_caps = check_unsloth_capabilities()
    bnb_caps = check_bitsandbytes_capabilities()
    
    # Determine optimal loading strategy
    strategy, strategy_info = get_optimal_loading_strategy(MODEL_NAME)
    
    # Configure quantization based on model requirements and capabilities
    if bnb_caps["functional"] and model_info["requires_quantization"]:
        bnb_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.float16,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            llm_int8_enable_fp32_cpu_offload=True,
        )
    else:
        bnb_config = None  # No quantization - use FP16
        if model_info["requires_quantization"] and not bnb_caps["functional"]:
            print("[WARNING] Model requires quantization but bitsandbytes is not available/functional")
            print("[WARNING] Will attempt to load base model without quantization")
            MODEL_NAME = model_info["base_model_name"]
            if MODEL_NAME != model_info["original_name"]:
                print(f"[INFO] Using base model: {MODEL_NAME}")

    # Disable Unsloth path to avoid FP16 grad-scaler crashes on this setup
    should_try_unsloth = False
    if args.use_unsloth and unsloth_caps["functional"]:
        print("[INFO] Skipping Unsloth path; using standard PEFT (more stable on this system).")
    
    if should_try_unsloth:
        try:
            print(f"[INFO] Using Unsloth for optimized training (peft {peft_caps['version']})")
            
            model, tokenizer = FastLanguageModel.from_pretrained(
                model_name=MODEL_NAME,
                max_seq_length=MAX_SEQ_LENGTH,
                dtype=None,
                device_map="auto",
                quantization_config=bnb_config,
            )

            # Get version-aware parameters for unsloth
            unsloth_params = get_compatible_unsloth_params(
                r=LORA_R,
                lora_alpha=LORA_ALPHA,
                lora_dropout=LORA_DROPOUT,
                target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
                use_gradient_checkpointing="unsloth",
                capabilities=peft_caps
            )
            
            model = FastLanguageModel.get_peft_model(model, **unsloth_params)
            
            # Ensure model is in training mode and parameters require gradients
            model.train()
            for param in model.parameters():
                if param.requires_grad is False:
                    param.requires_grad = True
            
        except (TypeError, AttributeError, ImportError) as e:
            # Unsloth failed due to version incompatibility
            error_msg = str(e).lower()
            if "ensure_weight_tying" in error_msg or "unexpected keyword argument" in error_msg or "loraconfig" in error_msg:
                print(f"[WARNING] Unsloth failed due to version incompatibility: {e}")
                print(f"[WARNING] peft version {peft_caps.get('version', 'unknown')} may not support all unsloth features")
                print("[INFO] Automatically falling back to standard PEFT training (slower but compatible)")
                MODEL_NAME = model_info["base_model_name"]
                should_try_unsloth = False
            else:
                # Re-raise if it's a different error
                raise
        except Exception as e:
            # Other unsloth errors - also fall back gracefully
            print(f"[WARNING] Unsloth failed: {e}")
            print("[INFO] Automatically falling back to standard PEFT training")
            MODEL_NAME = model_info["base_model_name"]
            should_try_unsloth = False
    
    if not should_try_unsloth:
        # Standard PEFT Loading
        tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
        if tokenizer.pad_token is None:
            tokenizer.pad_token = tokenizer.eos_token
        
        # Three load tiers, in preference order:
        #   1. bitsandbytes 4-bit if available  (~4 GB for a 7B model)
        #   2. bf16 on Ampere+ GPUs             (~14 GB for a 7B model;
        #      same dynamic range as fp32, NO GradScaler needed —
        #      different from fp16's quirks)
        #   3. fp32 fallback                    (~28 GB for a 7B model)
        #
        # Tier 2 is what should run on a 4090 / A100 / H100 when
        # bitsandbytes' CUDA backend isn't loadable. Previously we fell
        # straight from tier 1 to tier 3, which caused the disk safe_open
        # to mmap a 16 GB file into 32 GB of fp32 tensors — Windows
        # rejected the resulting page-file commit with
        # 'OSError 1455 paging file too small' even on a machine with
        # 24 GB VRAM and 64 GB RAM.
        #
        # low_cpu_mem_usage=True tells transformers to load weights
        # lazily into the device, avoiding a full state-dict copy in
        # CPU RAM during the safe_open mmap pass.
        # device_map='auto' lets accelerate split the model across all
        # visible GPUs. With CUDA_VISIBLE_DEVICES already constrained
        # to a single GPU (either via GUI selector or our pre-torch
        # auto-select), 'auto' would also work — but explicit is
        # better than implicit, and it guarantees no model parts ever
        # land on cuda:1+ even if a future code path adds another
        # device. device_map=0 = 'put the entire model on cuda:0',
        # which is what we want for LoRA fine-tuning.
        load_kwargs = {
            "device_map": 0,
            "trust_remote_code": True,
            "low_cpu_mem_usage": True,
        }

        if bnb_config is not None:
            load_kwargs["quantization_config"] = bnb_config
            print("[INFO] Loading with 4-bit quantization (bitsandbytes).")
        elif _should_use_bf16():
            load_kwargs["torch_dtype"] = torch.bfloat16
            print(
                "[INFO] Loading in bf16 (Ampere+ GPU). Half the memory "
                "of fp32, full fp32 dynamic range, no GradScaler needed."
            )
        else:
            load_kwargs["torch_dtype"] = torch.float32
            print(
                "[WARNING] No quantization and GPU does not support bf16 "
                "— falling back to fp32 (high memory)."
            )
        
        try:
            model = AutoModelForCausalLM.from_pretrained(MODEL_NAME, **load_kwargs)
            # Prepare for k-bit training (only if using quantization)
            if BITSANDBYTES_AVAILABLE and bnb_config is not None:
                model = prepare_model_for_kbit_training(model)
        except (RuntimeError, AttributeError, ImportError, ModuleNotFoundError) as e:
            error_str = str(e).lower()
            if "triton.ops" in error_str or "bitsandbytes" in error_str or "quantization" in error_str:
                print("[WARNING] bitsandbytes/quantization failed")
                print("[WARNING] Falling back to FP16 (requires more VRAM)")
                # Retry without quantization - try base model if quantization model was used
                load_kwargs.pop("quantization_config", None)
                load_kwargs["torch_dtype"] = torch.float16
                try_model_name = MODEL_NAME
                if "-bnb-" in MODEL_NAME or "-4bit" in MODEL_NAME or "-8bit" in MODEL_NAME:
                    base_name = MODEL_NAME.replace("-bnb-4bit", "").replace("-bnb-8bit", "").replace("-4bit", "").replace("-8bit", "")
                    if base_name != MODEL_NAME:
                        print(f"[INFO] Trying base model: {base_name}")
                        try_model_name = base_name
                model = AutoModelForCausalLM.from_pretrained(try_model_name, **load_kwargs)
            else:
                raise
        
        # Configure LoRA with version-aware parameters
        if not peft_caps["available"]:
            raise RuntimeError("PEFT is required but not available. Please install peft.")
        
        # Choose target modules. Default is the standard Llama-style
        # projection names. Gemma 4 wraps every Linear in a custom
        # ``Gemma4ClippableLinear(linear=Linear(...))`` for output
        # clipping; PEFT's ``_create_new_module`` rejects the wrapper
        # because it's not a ``torch.nn.Linear``. Detect that and aim
        # one level deeper at the inner ``.linear`` so PEFT attaches
        # LoRA to the actual Linear weights — the clipping wrapper
        # stays in place around the LoRA-augmented output.
        default_targets = ["q_proj", "k_proj", "v_proj", "o_proj",
                           "gate_proj", "up_proj", "down_proj"]
        gemma4_clippable_present = False
        try:
            for module in model.modules():
                if type(module).__name__ == "Gemma4ClippableLinear":
                    gemma4_clippable_present = True
                    break
        except Exception:
            gemma4_clippable_present = False
        if gemma4_clippable_present:
            print(
                "[INFO] Detected Gemma4ClippableLinear wrappers — targeting "
                "inner '.linear' modules so PEFT can attach LoRA.",
                flush=True,
            )
            target_modules = [f"{name}.linear" for name in default_targets]
        else:
            target_modules = default_targets

        peft_params = get_compatible_peft_params(
            r=LORA_R,
            lora_alpha=LORA_ALPHA,
            lora_dropout=LORA_DROPOUT,
            target_modules=target_modules,
            bias="none",
            task_type="CAUSAL_LM",
            capabilities=peft_caps
        )

        peft_config = LoraConfig(**peft_params)

        # Apply LoRA
        model = get_peft_model(model, peft_config)
        
        # Ensure model is in training mode and parameters require gradients
        model.train()
        for param in model.parameters():
            if param.requires_grad is False:
                param.requires_grad = True
        
        # Enable gradient checkpointing if supported
        if hasattr(model, "gradient_checkpointing_enable"):
            model.gradient_checkpointing_enable()

    print(f"[INFO] Preparing dataset...")
    
    # Smart dataset loader - handles JSON and JSONL automatically
    import tempfile
    
    file_format = detect_file_format(DATASET_PATH)
    
    if file_format == 'jsonl' or (file_format == 'auto' and DATASET_PATH.endswith('.jsonl')):
        print(f"[INFO] ✓ Detected JSONL format")
        raw_data = load_jsonl(DATASET_PATH, skip_errors=not args.strict_jsonl)
    else:
        # Standard JSON loading
        print(f"[INFO] ✓ Detected JSON format")
        with open(DATASET_PATH, 'r', encoding='utf-8') as f:
            raw_data = json.load(f)
    
    # Step 1: Convert to list if needed
    if isinstance(raw_data, dict):
        # Try common keys that contain the actual data
        for key in ['data', 'examples', 'train', 'dataset', 'items', 'conversations', 'entries']:
            if key in raw_data and isinstance(raw_data[key], list):
                raw_data = raw_data[key]
                print(f"[INFO] ✓ Extracted data from '{key}' field")
                break
        else:
            # If still a dict, treat as single example
            raw_data = [raw_data]
            print("[INFO] ✓ Converted single dict to list")
    
    if not isinstance(raw_data, list):
        raise ValueError(f"Dataset must be a list or dict with data field. Got: {type(raw_data)}")
    
    print(f"[INFO] ✓ Found {len(raw_data)} examples")
    
    # Step 2: Normalize field names (handle various formats)
    normalized_data = []
    
    # Detect format from first item
    if len(raw_data) > 0:
        first = raw_data[0]
        
        # Determine instruction/output field names
        instruction_key = None
        output_key = None
        
        # Common field name mappings (including customer_message/assistant_response)
        instruction_fields = ['instruction', 'prompt', 'input', 'question', 'query', 'text', 'user', 'human', 
                              'customer_message', 'customer', 'message', 'query_text']
        output_fields = ['output', 'response', 'completion', 'answer', 'reply', 'assistant', 'gpt', 'bot',
                        'assistant_response', 'assistant', 'response_text', 'answer_text']
        
        # Find matching fields
        for key in instruction_fields:
            if key in first:
                instruction_key = key
                break
        
        for key in output_fields:
            if key in first:
                output_key = key
                break
        
        # Handle chat/messages format (like ShareGPT, OpenAI)
        if 'messages' in first or 'conversations' in first:
            print("[INFO] ✓ Detected chat/messages format")
            msg_key = 'messages' if 'messages' in first else 'conversations'
            for item in raw_data:
                messages = item[msg_key]
                # Extract user/assistant pairs
                instruction = ""
                output = ""
                # Capture the FIRST user/assistant pair so multi-turn
                # datasets train on the initial exchange (the rest is
                # context for future fine-tunes if needed). Roles cover
                # the conventions actually seen in the wild:
                #   user-side:      'user', 'human'
                #   assistant-side: 'assistant', 'gpt', 'bot', 'model'
                # 'model' is Gemma's convention — without it, every
                # Gemma-format chat dataset normalises to zero rows.
                # 'system' role is intentionally skipped (it sets
                # context but isn't part of the input/output pair).
                for msg in messages:
                    role = msg.get('role', msg.get('from', '')).lower()
                    content = msg.get('content', msg.get('value', ''))
                    if role in ('user', 'human'):
                        if not instruction:
                            instruction = content
                    elif role in ('assistant', 'gpt', 'bot', 'model'):
                        if not output:
                            output = content
                if instruction and output:
                    normalized_data.append({'instruction': instruction, 'output': output})
        
        # Handle standard formats
        elif instruction_key and output_key:
            print(f"[INFO] ✓ Detected format: '{instruction_key}' -> '{output_key}'")
            for item in raw_data:
                normalized_data.append({
                    'instruction': str(item.get(instruction_key, '')),
                    'output': str(item.get(output_key, ''))
                })
        
        # Handle Alpaca format with optional input field
        elif 'instruction' in first:
            print("[INFO] ✓ Detected Alpaca format (instruction + optional input)")
            for item in raw_data:
                instruction = item.get('instruction', '')
                inp = item.get('input', '')
                output = item.get('output', item.get('response', ''))
                # Combine instruction and input if present
                if inp:
                    full_instruction = f"{instruction}\n\nInput: {inp}"
                else:
                    full_instruction = instruction
                normalized_data.append({'instruction': full_instruction, 'output': output})
        
        else:
            raise ValueError(f"Could not detect dataset format. First item keys: {list(first.keys())}\n"
                           f"Expected one of: {instruction_fields} -> {output_fields}, or 'messages' format")
    
    if not normalized_data:
        raise ValueError("No valid examples found in dataset")
    
    print(f"[INFO] ✓ Normalized {len(normalized_data)} examples")
    
    # Step 3: Write to JSONL format for reliable loading
    temp_file = tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False, encoding='utf-8')
    for item in normalized_data:
        temp_file.write(json.dumps(item, ensure_ascii=False) + '\n')
    temp_file.close()
    
    # Step 4: Load with HuggingFace datasets
    dataset = load_dataset("json", data_files=temp_file.name, split="train")
    print(f"[INFO] ✓ Loaded dataset with {len(dataset)} examples")
    
    if args.max_examples:
        dataset = dataset.select(range(min(args.max_examples, len(dataset))))

    def formatting_func(example):
        text = f"### Instruction:\n{example['instruction']}\n\n### Response:\n{example['output']}"
        return {"text": text}

    dataset = dataset.map(formatting_func, remove_columns=dataset.column_names)

    # Training bookkeeping for ETA/speed
    total_samples = len(dataset)
    num_batches = (total_samples + BATCH_SIZE - 1) // BATCH_SIZE
    total_steps = ((num_batches + GRADIENT_ACCUMULATION - 1) // GRADIENT_ACCUMULATION) * args.epochs
    effective_bs = BATCH_SIZE * GRADIENT_ACCUMULATION
    print(f"[INFO] Training set size: {total_samples} examples | batches/epoch: {num_batches} | total optimizer steps: {total_steps}")

    class DashboardCallback(TrainerCallback):
        """Emit compact JSON logs for dashboard (step/loss/lr/speed/eta)."""
        def __init__(self, total_steps: int, effective_bs: int, start_time: float) -> None:
            self.total_steps = total_steps
            self.effective_bs = effective_bs
            self.start_time = start_time
            self.last_emitted_step = -1

        def _emit(self, state: TrainerState, logs: dict | None):
            step = state.global_step
            # Only emit for step > 0 to avoid initialization noise in the graph
            if step <= 0:
                return
            
            # Don't emit twice for the same step unless we have new logs (loss)
            has_loss = logs and "loss" in logs
            if step == self.last_emitted_step and not has_loss:
                return
                
            self.last_emitted_step = step
            elapsed = max(time.time() - self.start_time, 1e-6)
            samples = step * self.effective_bs
            samples_per_sec = samples / elapsed
            remaining_steps = max(self.total_steps - step, 0)
            eta_sec = remaining_steps * (elapsed / step) if step > 0 else 0
            
            payload = {
                "step": step,
                "total_steps": self.total_steps,
                "epoch": logs.get("epoch") if logs else state.epoch,
                "loss": logs.get("loss") if logs else None,
                "learning_rate": logs.get("learning_rate") if logs else None,
                "samples_per_sec": samples_per_sec,
                "eta_sec": eta_sec,
            }
            try:
                # Use a prefix to make it easier to identify and harder to mis-parse
                print(f"DASHBOARD_METRICS: {json.dumps(payload)}")
            except Exception:
                pass

        def on_log(self, args, state: TrainerState, control: TrainerControl, logs=None, **kwargs):
            if logs is None:
                return
            self._emit(state, logs)

        def on_step_end(self, args, state: TrainerState, control: TrainerControl, **kwargs):
            # Ensure at least one emit per step even if Trainer log is skipped
            self._emit(state, logs={})

    print("[INFO] Starting training...")
    
    # Configure tqdm for real-time progress updates in GUI
    # Set environment variable to ensure tqdm flushes immediately
    os.environ["TQDM_DISABLE"] = "0"
    os.environ["TQDM_MININTERVAL"] = "0.1"  # Update at least every 0.1 seconds
    
    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset,
        dataset_text_field="text",
        max_seq_length=MAX_SEQ_LENGTH,
        args=TrainingArguments(
            per_device_train_batch_size=BATCH_SIZE,
            gradient_accumulation_steps=GRADIENT_ACCUMULATION,
            warmup_steps=5,
            num_train_epochs=args.epochs,
            learning_rate=LEARNING_RATE,  # Use the configurable learning rate
            # bf16 halves memory vs fp32 with NONE of fp16's GradScaler
            # unscale-NaN issues — bf16 has the same dynamic range as
            # fp32 (8-bit exponent), only the mantissa is reduced. All
            # current NVIDIA datacenter / consumer GPUs from Ampere
            # onward (RTX 30/40 series, A100, H100) support it natively.
            # On older Pascal/Volta (Tesla P100, V100) bf16 falls back
            # to fp32; we detect that below.
            fp16=False,
            bf16=_should_use_bf16(),
            max_grad_norm=0.0,  # keep clipping disabled
            logging_steps=1,
            logging_strategy="steps",
            output_dir=OUTPUT_DIR,
            optim="adamw_8bit",
            seed=3407,
            # Disable Hugging Face Trainer intermediate checkpoints (creates `checkpoint-<step>` dirs)
            save_strategy="no",
            # Keep a small number if you enable saving later
            save_total_limit=2,
        ),
    )
    trainer.add_callback(DashboardCallback(total_steps=total_steps, effective_bs=effective_bs, start_time=time.time()))

    # Train and capture training state
    print("[INFO] Starting training loop...")
    train_result = trainer.train()
    
    # Verify training actually happened
    if train_result.metrics:
        print(f"[INFO] Training completed successfully!")
        print(f"[INFO] Final metrics: {train_result.metrics}")
        if 'train_loss' in train_result.metrics:
            print(f"[INFO] Final training loss: {train_result.metrics['train_loss']:.4f}")
        if 'train_runtime' in train_result.metrics:
            print(f"[INFO] Training runtime: {train_result.metrics['train_runtime']:.2f} seconds")
    else:
        print("[WARNING] Training completed but no metrics were recorded!")
        print("[WARNING] This might indicate training did not actually run.")

    # Define unique adapter path with timestamp for this run
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    adapter_path = Path(OUTPUT_DIR) / f"adapter_{timestamp}"
    
    print(f"[INFO] Saving LoRA adapter to: {adapter_path.absolute()}")

    # Ensure adapter_path exists
    adapter_path.mkdir(parents=True, exist_ok=True)
    
    try:
        # Save adapter (this saves adapter_config.json and adapter_model.safetensors/.bin)
        # Use a more robust saving method if using unsloth
        if should_try_unsloth and hasattr(model, "save_pretrained_lora"):
            print("[INFO] Using unsloth-optimized saving...")
            model.save_pretrained_lora(str(adapter_path))
        else:
            print("[INFO] Using standard PEFT saving...")
            model.save_pretrained(str(adapter_path))
            
        # Explicitly save tokenizer as well to the adapter dir (useful for loading)
        tokenizer.save_pretrained(str(adapter_path))
        print("[INFO] Tokenizer saved to adapter directory")
        
    except Exception as e:
        print(f"[ERROR] Failed to save model: {e}")
        import traceback
        traceback.print_exc()
        # Don't stop here, let's see if we can at least save the metadata
    
    # Verify adapter files were saved
    adapter_config = adapter_path / "adapter_config.json"
    adapter_model = adapter_path / "adapter_model.safetensors"
    if not adapter_model.exists():
        adapter_model = adapter_path / "adapter_model.bin"
    
    # If still not found, check for any .safetensors or .bin in the directory
    if not adapter_model.exists():
        bin_files = list(adapter_path.glob("*.bin"))
        safe_files = list(adapter_path.glob("*.safetensors"))
        if bin_files:
            adapter_model = bin_files[0]
        elif safe_files:
            adapter_model = safe_files[0]
    
    if adapter_config.exists() and adapter_model.exists():
        adapter_size = adapter_model.stat().st_size
        print(f"[INFO] ✓ LoRA adapter saved successfully ({adapter_size / 1024 / 1024:.2f} MB)")
        print(f"[INFO] ✓ Adapter location: {adapter_path.absolute()}")
        
        # List files for verification in logs
        print(f"[INFO] Files in adapter directory:")
        for f in adapter_path.iterdir():
            print(f"  - {f.name} ({f.stat().st_size / 1024:.1f} KB)")
    else:
        print(f"[WARNING] LoRA adapter files not found! Check {adapter_path.absolute()}")
        if not adapter_config.exists():
            print(f"[ERROR] Missing: {adapter_config}")
        if not adapter_model.exists():
            print(f"[ERROR] Missing: {adapter_model}")
        
        # List whatever IS there
        if adapter_path.exists():
            print(f"[INFO] Directory {adapter_path} contains:")
            for f in adapter_path.iterdir():
                print(f"  - {f.name}")
    
    # Save training metadata
    training_info = {
        "base_model": MODEL_NAME,
        "dataset": str(DATASET_PATH),
        "training_params": {
            "epochs": args.epochs,
            "batch_size": BATCH_SIZE,
            "gradient_accumulation": GRADIENT_ACCUMULATION,
            "learning_rate": LEARNING_RATE,
            "max_seq_length": MAX_SEQ_LENGTH,
            "lora_r": LORA_R,
            "lora_alpha": LORA_ALPHA,
            "lora_dropout": LORA_DROPOUT,
        },
        "created_at": datetime.now().isoformat(),
        "train_result": {
            "train_loss": train_result.metrics.get("train_loss", None) if train_result.metrics else None,
            "train_runtime": train_result.metrics.get("train_runtime", None) if train_result.metrics else None,
        } if train_result.metrics else None
    }
    
    try:
        with open(adapter_path / "training_info.json", "w", encoding="utf-8") as f:
            json.dump(training_info, f, indent=2)
        print("[INFO] Training metadata saved")
    except Exception as e:
        print(f"[WARNING] Failed to save metadata: {e}")
    
    # Remove tokenizer files - base model already has them, no need to duplicate
    # Only if they were successfully saved elsewhere or if we want to save space
    # BUT keeping them is safer for loading in some tools
    """
    tokenizer_files = [
        "tokenizer.json", "tokenizer_config.json", "vocab.json", 
        "merges.txt", "special_tokens_map.json", "tokenizer.model"
    ]
    for tokenizer_file in tokenizer_files:
        tokenizer_path = adapter_path / tokenizer_file
        if tokenizer_path.exists():
            tokenizer_path.unlink()
    """
    
    print(f"[INFO] Finetuning complete! Adapter saved to: {adapter_path.absolute()}")

    # Clean up old adapters in the output directory (keep latest 10)
    try:
        cleanup_old_adapters(Path(OUTPUT_DIR), keep_latest=10)
    except Exception as e:
        print(f"[WARNING] Cleanup failed: {e}")


if __name__ == "__main__":
    main()