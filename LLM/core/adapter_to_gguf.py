"""LoRA adapter → GGUF conversion pipeline.

Why this module exists:

The OWLLM training stack produces PEFT/LoRA adapters that only run on
the HuggingFace Transformers backend (PyTorch). That backend is 3-8x
slower than llama.cpp on the same weights — fine for prototyping, bad
for chat / agents / phone bridges where every token of latency matters.

This module converts a trained adapter into a standalone GGUF chat
model the llama-server backend can serve. Three stages:

    1. **Merge.** Load the base in fp16 with PEFT, attach the adapter,
       call ``merge_and_unload`` so the LoRA matrices fold into the
       base linear weights. Save the merged model in standard HF
       format (``model.safetensors`` shards + tokenizer).

    2. **Convert.** Run llama.cpp's ``convert_hf_to_gguf.py`` against
       the merged dir, producing a single fp16 GGUF.

    3. **Quantize (optional).** Run ``llama-quantize.exe`` to drop the
       fp16 GGUF down to Q5_K_M (or another quant). Q5_K_M is the
       sweet spot — ~5x smaller than fp16 with negligible quality
       loss for instruct models.

The final GGUF lands in ``models/<adapter_name>__gguf/<name>.gguf``
and gets registered in the onboarding state store as status=READY,
so it appears in every dropdown immediately.

Designed to run as a subprocess (the GUI calls it via QProcess just
like training) so that the Python that does the merging is the
training env, not the desktop env.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

logger = logging.getLogger(__name__)


# Quant presets — labels match llama.cpp's --type argument exactly so we
# can pass them through. Keys are user-facing labels; values are
# (quant_type, approx_size_label, description).
QUANT_PRESETS = {
    "Q4_K_M": ("Q4_K_M", "~4-bit", "Smallest viable quant. ~6x smaller than fp16. Best for low VRAM."),
    "Q5_K_M": ("Q5_K_M", "~5-bit", "Sweet spot — recommended default. ~5x smaller, near-fp16 quality."),
    "Q6_K":   ("Q6_K",   "~6-bit", "Higher fidelity. ~3.5x smaller than fp16."),
    "Q8_0":   ("Q8_0",   "8-bit",  "Near-lossless. ~2x smaller than fp16."),
    "F16":    ("F16",    "fp16",   "No quantisation — full precision. Largest size."),
}


@dataclass
class ConvertConfig:
    """All inputs for one adapter → GGUF run."""

    base_model: str
    """Path to the HF base model directory (the same one the adapter
    was trained on)."""

    adapter_dir: str
    """Path to the PEFT adapter directory (must contain
    adapter_config.json and adapter_model.safetensors)."""

    output_dir: str
    """Where to write the final .gguf. Conventionally
    LLM/models/<adapter_name>__gguf/."""

    quant: str = "Q5_K_M"
    """Quant preset key (see QUANT_PRESETS)."""

    keep_merged: bool = False
    """When False, delete the intermediate merged HF model after the
    GGUF is built. Saves ~16 GB for an 8B model."""

    convert_script: Optional[str] = None
    """Path to convert_hf_to_gguf.py. If None, auto-discovered from
    the bundled llamacpp env."""

    quantize_exe: Optional[str] = None
    """Path to llama-quantize.exe. If None, auto-discovered from
    LLM/runtime/llama.cpp/."""

    log_callback: Optional[callable] = field(default=None, repr=False)


# ---------------------------------------------------------------------------
# Step 1 — merge LoRA into base
# ---------------------------------------------------------------------------


def _merge_adapter(cfg: ConvertConfig, merged_dir: Path) -> None:
    """Load base + adapter, merge LoRA in, save plain HF format.

    CPU-only by design: merge is just ``W += B @ A``, doesn't need a
    GPU, and avoiding CUDA here sidesteps the same Windows-specific
    0xC0000005 access violation we hit during training (CUDA + bf16 +
    Gemma 4's Clippable wrappers + transformers' kernelize() teardown
    interact badly on Windows). Loading on CPU in fp32 burns RAM, not
    VRAM, and the merge math is identical.
    """
    import os as _os
    # Force-disable CUDA for this process. The merge runs entirely on
    # CPU; this also kills the transformers / accelerate "device_map=auto"
    # path that splits the model and triggers the meta-device warning.
    _os.environ["CUDA_VISIBLE_DEVICES"] = ""

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import PeftModel

    log = cfg.log_callback or (lambda m: print(f"[merge] {m}"))
    log(f"loading base from {cfg.base_model} (CPU-only, fp16)")
    base = AutoModelForCausalLM.from_pretrained(
        cfg.base_model,
        torch_dtype=torch.float16,
        device_map={"": "cpu"},
        trust_remote_code=True,
        low_cpu_mem_usage=True,
    )

    # Apply the SAME stability shims the trainer uses:
    #
    # 1) Multimodal Gemma 4 wraps every Linear in Gemma4ClippableLinear,
    #    whose torch.clamp during forward corrupts gradient flow AND
    #    interacts badly with merge_and_unload. Disable the wrapper.
    # 2) transformers' new kernelize() path swaps fused C++ kernels in
    #    on .train() / .to() — on Windows + Gemma 4 it scribbles into
    #    sub-module dicts. Disable it everywhere.
    try:
        n_clipped = 0
        for sub in base.modules():
            if hasattr(sub, "use_clipped_linears"):
                try:
                    sub.use_clipped_linears = False
                    n_clipped += 1
                except Exception:
                    pass
        if n_clipped:
            log(f"disabled clipped-linear wrappers on {n_clipped} module(s) "
                f"(Gemma 4 multimodal stability shim)")
    except Exception as exc:
        log(f"WARN: clipped-linear shim failed: {exc}")
    try:
        n_kernels = 0
        for sub in base.modules():
            if hasattr(sub, "use_kernels"):
                try:
                    sub.use_kernels = False
                    n_kernels += 1
                except Exception:
                    pass
        if n_kernels:
            log(f"disabled use_kernels on {n_kernels} module(s) "
                f"(prevents kernelize() teardown crash)")
    except Exception as exc:
        log(f"WARN: kernelize shim failed: {exc}")

    log(f"loading adapter from {cfg.adapter_dir}")
    peft_model = PeftModel.from_pretrained(base, cfg.adapter_dir)
    log("merging LoRA into base weights (merge_and_unload)…")
    merged = peft_model.merge_and_unload()

    log(f"saving merged HF model to {merged_dir}")
    merged_dir.mkdir(parents=True, exist_ok=True)
    # safe_serialization=False on purpose: safetensors uses a ctypes
    # array size argument that's a signed 32-bit int, so any single
    # tensor >2 GB on Windows overflows with
    # "ValueError: Array length must be >= 0, not -2952790016".
    # Gemma 4's embedding tensor (~256k vocab × 4608 hidden × 2 bytes
    # ≈ 2.4 GB) trips this on every merge attempt.
    # The pickle .bin path has no such cap, and llama.cpp's
    # convert_hf_to_gguf.py reads both formats interchangeably, so the
    # downstream pipeline doesn't care which we wrote.
    # Smaller shard target so any single .bin stays manageable.
    merged.save_pretrained(
        str(merged_dir),
        max_shard_size="2GB",
        safe_serialization=False,
    )

    # Tokenizer: prefer the adapter's saved tokenizer (training may
    # have added kbeauty-specific special tokens); fall back to the
    # base tokenizer.
    try:
        tok = AutoTokenizer.from_pretrained(cfg.adapter_dir, trust_remote_code=True)
        log("using tokenizer from adapter dir")
    except Exception:
        tok = AutoTokenizer.from_pretrained(cfg.base_model, trust_remote_code=True)
        log("using tokenizer from base model")
    tok.save_pretrained(str(merged_dir))

    # Free what we can — the converter step is a fresh subprocess so
    # this is mostly cosmetic, but keeps RAM clean if anyone wires the
    # function up in-process.
    del peft_model
    del merged
    del base
    import gc
    gc.collect()
    log("merge complete")


# ---------------------------------------------------------------------------
# Step 2 — HF → GGUF (fp16)
# ---------------------------------------------------------------------------


def _discover_convert_script() -> str:
    """Locate the convert_hf_to_gguf.py shipped with the bundled llamacpp env."""
    root = Path(__file__).resolve().parents[1]  # .../LLM
    candidates = [
        root / ".envs" / "llamacpp-cu121-edge" / ".venv" / "Lib" / "site-packages" / "bin" / "convert_hf_to_gguf.py",
        root / ".envs" / "llamacpp-cu121-stable" / ".venv" / "Lib" / "site-packages" / "bin" / "convert_hf_to_gguf.py",
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    raise FileNotFoundError(
        "convert_hf_to_gguf.py not found in any bundled llamacpp env. "
        "Expected one of:\n  " + "\n  ".join(str(c) for c in candidates)
    )


def _discover_quantize_exe() -> str:
    """Locate llama-quantize.exe shipped under LLM/runtime/llama.cpp/."""
    root = Path(__file__).resolve().parents[1]
    exe = root / "runtime" / "llama.cpp" / "llama-quantize.exe"
    if not exe.exists():
        raise FileNotFoundError(
            f"llama-quantize.exe not found at {exe}. "
            f"Expected the bundled llama.cpp runtime."
        )
    return str(exe)


def _convert_to_fp16_gguf(cfg: ConvertConfig, merged_dir: Path, fp16_gguf: Path) -> None:
    """Run convert_hf_to_gguf.py on the merged HF model."""
    log = cfg.log_callback or (lambda m: print(f"[convert] {m}"))
    convert_script = cfg.convert_script or _discover_convert_script()
    log(f"using converter: {convert_script}")

    # The script lives in the llamacpp env — invoke it with that env's
    # python so it has the right deps (gguf, sentencepiece, torch).
    env_python = (
        Path(convert_script).parents[3] / "Scripts" / "python.exe"
    ).resolve()
    if not env_python.exists():
        # Fallback: same interpreter that's running this module.
        env_python = Path(sys.executable)
    log(f"using python: {env_python}")

    cmd = [
        str(env_python), str(convert_script),
        str(merged_dir),
        "--outfile", str(fp16_gguf),
        "--outtype", "f16",
    ]
    log(f"running: {' '.join(cmd)}")
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        log(f"STDOUT:\n{proc.stdout[-2000:]}")
        log(f"STDERR:\n{proc.stderr[-2000:]}")
        raise RuntimeError(
            f"convert_hf_to_gguf.py failed (exit {proc.returncode}). See logs above."
        )
    if proc.stdout:
        log(f"convert stdout (last 500 chars):\n{proc.stdout[-500:]}")
    log(f"fp16 GGUF written: {fp16_gguf} ({fp16_gguf.stat().st_size / 1e9:.2f} GB)")


# ---------------------------------------------------------------------------
# Step 3 — quantize (optional)
# ---------------------------------------------------------------------------


def _quantize(cfg: ConvertConfig, fp16_gguf: Path, final_gguf: Path) -> None:
    """Run llama-quantize.exe on the fp16 GGUF."""
    log = cfg.log_callback or (lambda m: print(f"[quantize] {m}"))
    if cfg.quant == "F16":
        # No quant — just rename / move the fp16 to the final location.
        log("quant=F16; skipping quantization step (final = fp16 GGUF)")
        if fp16_gguf != final_gguf:
            shutil.move(str(fp16_gguf), str(final_gguf))
        return

    quant_type, _, _ = QUANT_PRESETS[cfg.quant]
    quantize_exe = cfg.quantize_exe or _discover_quantize_exe()
    log(f"using quantizer: {quantize_exe}")
    cmd = [str(quantize_exe), str(fp16_gguf), str(final_gguf), quant_type]
    log(f"running: {' '.join(cmd)}")
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        log(f"STDOUT:\n{proc.stdout[-2000:]}")
        log(f"STDERR:\n{proc.stderr[-2000:]}")
        raise RuntimeError(
            f"llama-quantize failed (exit {proc.returncode}). See logs above."
        )
    log(f"{quant_type} GGUF written: {final_gguf} "
        f"({final_gguf.stat().st_size / 1e9:.2f} GB)")


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def convert_adapter_to_gguf(cfg: ConvertConfig) -> Path:
    """Run the full pipeline. Returns the path to the final .gguf."""
    log = cfg.log_callback or (lambda m: print(m))
    t0 = time.monotonic()

    if cfg.quant not in QUANT_PRESETS:
        raise ValueError(f"unknown quant {cfg.quant!r}; pick from {sorted(QUANT_PRESETS)}")

    base = Path(cfg.base_model).resolve()
    adapter = Path(cfg.adapter_dir).resolve()
    out_dir = Path(cfg.output_dir).resolve()
    if not base.exists():
        raise FileNotFoundError(f"base model not found: {base}")
    if not adapter.exists():
        raise FileNotFoundError(f"adapter dir not found: {adapter}")

    out_dir.mkdir(parents=True, exist_ok=True)
    adapter_name = adapter.name
    final_gguf = out_dir / f"{adapter_name}-{cfg.quant}.gguf"
    fp16_gguf = out_dir / f"{adapter_name}-F16.gguf"
    merged_dir = out_dir / "_merged_hf"

    # 1) merge
    _merge_adapter(cfg, merged_dir)

    # 2) convert to fp16 GGUF
    _convert_to_fp16_gguf(cfg, merged_dir, fp16_gguf)

    # 3) quantize
    _quantize(cfg, fp16_gguf, final_gguf)

    # Cleanup
    if not cfg.keep_merged:
        log(f"removing intermediate merged HF dir {merged_dir}")
        shutil.rmtree(merged_dir, ignore_errors=True)
        if cfg.quant != "F16" and fp16_gguf.exists():
            log(f"removing intermediate fp16 GGUF {fp16_gguf}")
            try:
                fp16_gguf.unlink()
            except OSError:
                pass

    # Write a sidecar so the dropdown auto-pins this variant.
    try:
        marker = out_dir / ".selected_weights.json"
        marker.write_text(json.dumps({
            "model_id": f"{adapter_name}-gguf",
            "allow_patterns": [final_gguf.name],
            "active_variant": final_gguf.name,
            "saved_at": __import__("datetime").datetime.now().isoformat(),
            "source_adapter": str(adapter),
            "source_base": str(base),
            "quant": cfg.quant,
        }, indent=2))
    except Exception:
        logger.exception("could not write .selected_weights.json")

    elapsed = time.monotonic() - t0
    log(f"DONE in {elapsed:.1f}s — {final_gguf}")
    return final_gguf


# ---------------------------------------------------------------------------
# Onboarding registration helper
# ---------------------------------------------------------------------------


def register_in_onboarding(
    gguf_path: Path,
    adapter_name: str,
    base_model_path: str,
    quant: str,
) -> str:
    """Insert / update an onboarding row so this GGUF appears in every dropdown.

    Returns the model_id under which the row was registered.
    """
    from core.state_store import get_state_store
    model_id = f"tuned__{adapter_name}__gguf__{quant}"
    store = get_state_store()
    try:
        # Match the schema of base GGUF rows: base_model_path points at
        # the .gguf file (or its parent dir, depending on how the rest
        # of the app expects it). We write the parent dir because the
        # variant marker (.selected_weights.json) lives there.
        store.upsert_onboarding(
            model_id=model_id,
            status="READY",
            base_model_path=str(gguf_path.parent),
            adapter_dir=None,
            backend="gguf",
            accelerator="cuda",
            config_key="gguf",
            model_fingerprint="",
            env_key="llamacpp-cu121-stable",
        )
    except Exception:
        logger.exception("could not register onboarding row for %s", model_id)
    return model_id


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _parse_args() -> ConvertConfig:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--base-model", required=True,
                   help="Path to the HF base model directory.")
    p.add_argument("--adapter-dir", required=True,
                   help="Path to the trained PEFT adapter dir.")
    p.add_argument("--output-dir", required=True,
                   help="Where to put the final .gguf.")
    p.add_argument("--quant", default="Q5_K_M",
                   choices=sorted(QUANT_PRESETS.keys()),
                   help="Quantisation preset (default Q5_K_M — sweet spot).")
    p.add_argument("--keep-merged", action="store_true",
                   help="Keep the intermediate merged HF model on disk.")
    p.add_argument("--register", action="store_true",
                   help="Register the resulting GGUF in onboarding so dropdowns pick it up.")
    args = p.parse_args()
    return args


def main() -> int:
    args = _parse_args()
    cfg = ConvertConfig(
        base_model=args.base_model,
        adapter_dir=args.adapter_dir,
        output_dir=args.output_dir,
        quant=args.quant,
        keep_merged=args.keep_merged,
        log_callback=lambda m: print(f"[adapter-to-gguf] {m}", flush=True),
    )
    final = convert_adapter_to_gguf(cfg)
    if args.register:
        model_id = register_in_onboarding(
            final,
            adapter_name=Path(args.adapter_dir).name,
            base_model_path=args.base_model,
            quant=args.quant,
        )
        print(f"[adapter-to-gguf] registered as model_id={model_id}")
    print(f"[adapter-to-gguf] OUTPUT={final}")
    return 0


if __name__ == "__main__":
    # Hard-exit on success. Same rationale as finetune.py: Python's
    # interpreter teardown of CUDA contexts on Windows + bf16 can
    # raise 0xC0000005 in cuDNN/cuBLAS finalizers AFTER the GGUF is
    # already on disk. os._exit skips atexit so a successful run
    # reports as successful instead of CrashExit. Real exceptions
    # still surface.
    try:
        rc = main()
    except SystemExit:
        raise
    except BaseException:
        import traceback as _tb
        _tb.print_exc()
        os._exit(1)
    os._exit(int(rc or 0))
