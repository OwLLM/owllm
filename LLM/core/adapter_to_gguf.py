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

# When this file is invoked directly (e.g. `python core/adapter_to_gguf.py
# ...`), Python sets sys.path[0] to the script's directory (.../core),
# which means `from core.state_store import ...` raises
# ModuleNotFoundError. Add the LLM root so `core.*` resolves regardless
# of how the script was launched.
_LLM_ROOT = Path(__file__).resolve().parent.parent
if str(_LLM_ROOT) not in sys.path:
    sys.path.insert(0, str(_LLM_ROOT))

# Force UTF-8 stdout/stderr so log lines containing non-ASCII characters
# don't crash the subprocess when the parent (the GUI's QProcess) reads
# them through whatever the Windows console codepage happens to be —
# default cp1252 chokes on a literal `->` arrow we happened to print.
# This must run BEFORE any logging or print, so it sits at module top.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

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


def _max_tensor_bytes(model) -> int:
    """Largest single tensor in the model's state dict, in bytes.

    Decides which save tiers are viable BEFORE we attempt them. A tier
    that we know will hard-crash (safetensors on Windows for any
    tensor >2 GB) is worse than skipping it — a hard crash is a
    process-level abort the parent can't catch with try/except.
    """
    biggest = 0
    try:
        sd = model.state_dict()
    except Exception:
        return 0
    for v in sd.values():
        try:
            sz = int(v.numel()) * int(v.element_size())
            if sz > biggest:
                biggest = sz
        except Exception:
            continue
    return biggest


# Windows safetensors cap: ctypes signed int32 overflow → hard process
# crash (STATUS_BREAKPOINT 0x80000003) once any single tensor exceeds
# this. Be conservative — slightly under 2 GiB.
_SAFETENSORS_WINDOWS_TENSOR_CAP = 2_100_000_000


def _save_merged_with_fallback(model, output_dir: Path, log) -> None:
    """Persist a PEFT-merged model with a tiered, crash-aware strategy.

    The naive "try tier 1, except, try tier 2" approach doesn't work
    on Windows because tier 1 (safetensors) HARD-crashes the process
    via STATUS_BREAKPOINT when any tensor exceeds the ctypes int32
    cap — the except clause never runs.

    So we pre-flight: measure the largest single tensor, and SKIP any
    tier we know will crash. Each surviving tier is then run with
    try/except to catch the bugs that DO raise cleanly (e.g. the
    revert_weight_conversion regex TypeError on PEFT-merged Gemma 4).

    Tiers, in order:

      1. ``save_pretrained(safe_serialization=True)`` — official HF
         safetensors path. Skipped automatically when any tensor
         >~2 GiB (Windows ctypes cap).
      2. ``save_pretrained(safe_serialization=False)`` — pickle .bin
         path. No size cap. Still goes through transformers'
         weight-conversion logic, so it can hit the regex TypeError
         on Gemma 4 + PEFT.
      3. Manual sharded save — bypasses transformers entirely.
         Output is canonical HF sharded-pickle format, byte-identical
         to what tier 2 produces on success.
    """
    last_error: Optional[BaseException] = None

    def _wipe_partial() -> None:
        for p in output_dir.iterdir():
            try:
                if p.is_file():
                    p.unlink()
                elif p.is_dir():
                    shutil.rmtree(p, ignore_errors=True)
            except Exception:
                pass

    # Pre-flight: find the largest single tensor.
    biggest = _max_tensor_bytes(model)
    log(f"largest single tensor: {biggest / 1e9:.2f} GB")

    skip_tier_1 = biggest > _SAFETENSORS_WINDOWS_TENSOR_CAP
    if skip_tier_1:
        log(
            f"skipping tier 1 (safetensors): largest tensor exceeds Windows "
            f"ctypes int32 cap ({_SAFETENSORS_WINDOWS_TENSOR_CAP / 1e9:.2f} GB) — "
            "save_pretrained would hard-crash the subprocess."
        )

    # --- Tier 1: official safetensors save ----------------------------
    if not skip_tier_1:
        try:
            log("save tier 1: save_pretrained(safe_serialization=True)")
            model.save_pretrained(
                str(output_dir),
                max_shard_size="2GB",
                safe_serialization=True,
            )
            return
        except BaseException as exc:
            last_error = exc
            log(f"  tier 1 failed: {type(exc).__name__}: {exc}")
            _wipe_partial()

    # --- Tier 2: official pickle save ---------------------------------
    try:
        log("save tier 2: save_pretrained(safe_serialization=False)")
        model.save_pretrained(
            str(output_dir),
            max_shard_size="2GB",
            safe_serialization=False,
        )
        return
    except BaseException as exc:
        last_error = exc
        log(f"  tier 2 failed: {type(exc).__name__}: {exc}")
        _wipe_partial()

    # --- Tier 3: manual sharded save (canonical HF format) ------------
    try:
        log("save tier 3: manual sharded save (canonical HF format)")
        _manual_sharded_save(model, output_dir, log)
        return
    except BaseException as exc:
        last_error = exc
        log(f"  tier 3 failed: {type(exc).__name__}: {exc}")
        _wipe_partial()

    raise RuntimeError(
        f"All save tiers failed for the merged model. Last error:\n"
        f"  {type(last_error).__name__}: {last_error}"
    )


def _verify_merged_dir(output_dir: Path, log) -> None:
    """Check that the saved merged dir is structurally complete.

    convert_hf_to_gguf.py needs at minimum:
      - ``config.json`` parseable as JSON with an ``architectures`` field
      - At least one weight shard:
          * ``model.safetensors`` (single-file safetensors)
          * ``model.safetensors.index.json`` + matching shards (sharded
            safetensors)
          * ``pytorch_model.bin`` (single-file pickle)
          * ``pytorch_model.bin.index.json`` + matching shards (sharded
            pickle)

    Any other state means the converter will fail with a confusing
    error 30 seconds in — better to fail loud here.
    """
    cfg_path = output_dir / "config.json"
    if not cfg_path.exists():
        raise RuntimeError(f"saved merged dir is missing config.json: {output_dir}")
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError(f"config.json is not parseable: {exc}") from exc
    if not cfg.get("architectures"):
        raise RuntimeError(
            f"config.json has no `architectures` field — converter will reject this dir"
        )

    weights_present = (
        (output_dir / "model.safetensors").exists()
        or (output_dir / "pytorch_model.bin").exists()
        or (output_dir / "model.safetensors.index.json").exists()
        or (output_dir / "pytorch_model.bin.index.json").exists()
    )
    if not weights_present:
        raise RuntimeError(
            f"saved merged dir has no weight files (.safetensors / .bin / "
            f"index.json): {output_dir}"
        )

    # If there's an index, every shard it references must actually exist.
    for index_name in ("model.safetensors.index.json", "pytorch_model.bin.index.json"):
        idx_path = output_dir / index_name
        if not idx_path.exists():
            continue
        try:
            idx = json.loads(idx_path.read_text(encoding="utf-8"))
            referenced = set((idx.get("weight_map") or {}).values())
        except Exception as exc:
            raise RuntimeError(f"{index_name} is corrupt: {exc}") from exc
        missing = [s for s in referenced if not (output_dir / s).exists()]
        if missing:
            raise RuntimeError(
                f"{index_name} references {len(missing)} missing shard(s): "
                f"{missing[:3]}{'...' if len(missing) > 3 else ''}"
            )

    log(f"merged dir verified: {output_dir}")


def _manual_sharded_save(model, output_dir: Path, log) -> None:
    """Write a HF-compatible state-dict to disk WITHOUT save_pretrained.

    transformers.modeling_utils.save_pretrained on this version raises
    `TypeError: 'int' object is not subscriptable` deep inside
    revert_weight_conversion when handed a PEFT-merged Gemma 4. The
    regex it compiles for weight renaming gets ints in places that
    expect strings.

    We sidestep all of that and write what convert_hf_to_gguf.py
    actually reads: ``config.json``, optional ``generation_config.json``,
    a sharded ``pytorch_model.bin`` index, and shards on disk.
    """
    import json as _json
    import torch as _torch

    state_dict = model.state_dict()
    # Force every tensor onto CPU + contiguous memory before pickling —
    # avoids "tensor is not contiguous" errors and guarantees torch.save
    # can serialise without copying through unexpected memory layouts.
    cleaned: dict = {}
    for k, v in state_dict.items():
        if hasattr(v, "detach"):
            t = v.detach()
            if hasattr(t, "cpu"):
                t = t.cpu()
            if hasattr(t, "contiguous"):
                t = t.contiguous()
            cleaned[k] = t
        else:
            cleaned[k] = v

    # Bucket tensors into ~2 GB shards. We never need more than that for
    # a single pickle file; smaller shards keep peak RAM during torch.save
    # bounded too.
    target_bytes = 2_000_000_000
    shards: list = []
    current: dict = {}
    current_size = 0
    for name, tensor in cleaned.items():
        try:
            sz = int(tensor.numel()) * int(tensor.element_size())
        except Exception:
            sz = 0
        if current and current_size + sz > target_bytes:
            shards.append(current)
            current = {}
            current_size = 0
        current[name] = tensor
        current_size += sz
    if current:
        shards.append(current)

    total_shards = max(1, len(shards))
    weight_map: dict = {}
    total_size = 0
    log(f"writing {total_shards} shard(s) to {output_dir}")
    for idx, shard in enumerate(shards, start=1):
        shard_name = f"pytorch_model-{idx:05d}-of-{total_shards:05d}.bin"
        shard_path = output_dir / shard_name
        for k, v in shard.items():
            weight_map[k] = shard_name
            try:
                total_size += int(v.numel()) * int(v.element_size())
            except Exception:
                pass
        log(f"  shard {idx}/{total_shards}: {len(shard)} tensors -> {shard_name}")
        _torch.save(shard, str(shard_path))

    # Write the standard HF index file so loaders (including
    # convert_hf_to_gguf.py) can find each tensor.
    index = {
        "metadata": {"total_size": int(total_size)},
        "weight_map": weight_map,
    }
    (output_dir / "pytorch_model.bin.index.json").write_text(
        _json.dumps(index, indent=2),
        encoding="utf-8",
    )

    # Save the model config — without this the converter doesn't know
    # the architecture. config.save_pretrained is a thin file-write and
    # doesn't go through the broken revert_weight_conversion path.
    try:
        model.config.save_pretrained(str(output_dir))
        log("saved config.json")
    except Exception as exc:
        log(f"WARN: config.save_pretrained failed: {exc}")
    try:
        gc = getattr(model, "generation_config", None)
        if gc is not None:
            gc.save_pretrained(str(output_dir))
            log("saved generation_config.json")
    except Exception as exc:
        log(f"WARN: generation_config.save_pretrained failed: {exc}")


def _patch_transformers_weight_renaming(log) -> None:
    """Monkey-patch the broken WeightRenaming.__post_init__ in transformers.

    The bug: ``re.compile("|".join(branches))`` is called with branches
    built from ``source_pattern.replace(".*.", r"\\..*\\.")`` — but
    raw source_patterns contain regex specials (parens, dots, square
    brackets, ``+``, etc.) that aren't escaped. On Gemma 4 those
    patterns include strings the regex parser can't compile, raising
    ``TypeError: 'bool' object does not support the context manager
    protocol`` deep inside re/_parser.py.

    Both load (convert_and_load_state_dict_in_model) and save
    (revert_weight_conversion) paths instantiate WeightRenaming, so
    both sides crash. Patching one place fixes both.

    The patched __post_init__:

    * Treats ``.*.`` as the only wildcard token; everything else is
      regex-escaped so source patterns are matched literally as the
      original code intended.
    * Falls back to an always-no-match regex if the resulting pattern
      still won't compile. ``rename_source_key`` then returns the
      input key unchanged — which is the correct behaviour when no
      renaming applies, and lets the rest of the load/save path
      proceed with the model's own state-dict naming.

    Idempotent: if already patched, returns silently.
    """
    try:
        from transformers import core_model_loading as cml
    except Exception as exc:
        log(f"WARN: transformers core_model_loading not importable: {exc}")
        return
    if getattr(cml, "_owllm_weight_renaming_patched", False):
        return

    import re as _re
    WR = getattr(cml, "WeightRenaming", None)
    if WR is None:
        log("WARN: WeightRenaming class not found — skipping patch")
        return

    _NO_MATCH = _re.compile(r"(?!x)x")  # never matches anything

    def _safe_post_init(self):
        # Recompute source_patterns the way the original does (via
        # process_source_pattern in a loop). The original mutates
        # self.source_patterns; we let that happen and only replace
        # the compile step.
        try:
            unprocess_targets = getattr(self, "target_patterns", None) or []
            for i, pattern in enumerate(self.source_patterns):
                if i < len(unprocess_targets):
                    pattern = cml.process_source_pattern(pattern, unprocess_targets[i])
                self.source_patterns[i] = pattern
        except Exception:
            # If pre-processing itself fails, fall through with whatever
            # source_patterns we already have.
            pass

        branches = []
        for i, source_pattern in enumerate(self.source_patterns):
            try:
                group_name = f"g{i}"
                # Split on the literal `.*.` wildcard token, escape
                # every other character, then re-join with the regex
                # equivalent. Mirrors the original intent without
                # leaving regex specials un-escaped.
                parts = str(source_pattern).split(".*.")
                escaped = [_re.escape(p) for p in parts]
                pattern = r"\..*\.".join(escaped)
                branches.append(f"(?P<{group_name}>{pattern})")
            except Exception:
                continue

        try:
            self.compiled_sources = _re.compile("|".join(branches)) if branches else _NO_MATCH
        except Exception:
            # Last-resort fallback: a no-match regex makes
            # rename_source_key a no-op, which is the correct
            # behaviour when no renaming applies.
            self.compiled_sources = _NO_MATCH

    WR.__post_init__ = _safe_post_init
    cml._owllm_weight_renaming_patched = True
    log("patched transformers.WeightRenaming.__post_init__ (regex-safe)")


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

    # Patch BEFORE loading anything — the bug fires during from_pretrained.
    _patch_transformers_weight_renaming(log)

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
    log("merging LoRA into base weights (merge_and_unload)...")
    merged = peft_model.merge_and_unload()

    log(f"saving merged HF model to {merged_dir}")
    merged_dir.mkdir(parents=True, exist_ok=True)
    _save_merged_with_fallback(merged, merged_dir, log)
    _verify_merged_dir(merged_dir, log)

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
    """Locate convert_hf_to_gguf.py — preferring the master copy.

    The script bundled inside the llamacpp env (under
    ``.../bin/convert_hf_to_gguf.py``) lags llama.cpp master by months
    and doesn't know about Gemma 3 / Gemma 4 / many newer architectures.
    We ship a master-snapshot at ``LLM/runtime/llama.cpp/`` and use it
    in preference to the env-bundled one — the gguf-py package in the
    same env is also overlaid with master sources so the new script's
    dependencies are satisfied.
    """
    root = Path(__file__).resolve().parents[1]  # .../LLM
    candidates = [
        # Master snapshot — preferred. Updated alongside the gguf-py
        # source files in the llamacpp-cu121-edge env.
        root / "runtime" / "llama.cpp" / "convert_hf_to_gguf.py",
        # Env-bundled fallbacks (months out of date).
        root / ".envs" / "llamacpp-cu121-edge" / ".venv" / "Lib" / "site-packages" / "bin" / "convert_hf_to_gguf.py",
        root / ".envs" / "llamacpp-cu121-stable" / ".venv" / "Lib" / "site-packages" / "bin" / "convert_hf_to_gguf.py",
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    raise FileNotFoundError(
        "convert_hf_to_gguf.py not found. Expected one of:\n  "
        + "\n  ".join(str(c) for c in candidates)
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

    # The converter has heavy deps (gguf master, sentencepiece, torch,
    # safetensors). The llamacpp-cu121-edge env is where we maintain
    # those — that's also where the gguf master overlay lives. Always
    # use that env's python regardless of where the script file sits
    # (env-bundled vs. our runtime snapshot).
    root = Path(__file__).resolve().parents[1]  # .../LLM
    env_python_candidates = [
        root / ".envs" / "llamacpp-cu121-edge" / ".venv" / "Scripts" / "python.exe",
        root / ".envs" / "llamacpp-cu121-stable" / ".venv" / "Scripts" / "python.exe",
    ]
    env_python = None
    for cand in env_python_candidates:
        if cand.exists():
            env_python = cand
            break
    if env_python is None:
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
    """Convert a PEFT LoRA adapter to a GGUF LoRA file.

    Earlier iterations of this pipeline tried to merge the LoRA into
    the base model and convert the resulting 17 GB HF model to GGUF.
    That path is a minefield on Windows / Gemma 4 / current
    transformers — every step had a separate bug (kernelize crashes,
    safetensors >2 GB cap, save_pretrained regex bug, converter
    architecture mismatch, post-write access violations).

    Use llama.cpp's dedicated ``convert_lora_to_gguf.py`` instead.
    The LoRA stays a LoRA — it gets converted to the GGUF wire format
    (just the A/B matrices, ~140 MB for our 36 M-trainable adapter),
    and llama-server applies it on top of the existing base GGUF at
    inference time via ``--lora <path>``.

    Output: a single ``<adapter_name>-lora-f16.gguf`` file in
    ``output_dir``. No intermediate dirs, no merge, no quantise step.
    """
    log = cfg.log_callback or (lambda m: print(m))
    t0 = time.monotonic()

    base = Path(cfg.base_model).resolve()
    adapter = Path(cfg.adapter_dir).resolve()
    out_dir = Path(cfg.output_dir).resolve()
    if not base.exists():
        raise FileNotFoundError(f"base model not found: {base}")
    if not adapter.exists():
        raise FileNotFoundError(f"adapter dir not found: {adapter}")

    out_dir.mkdir(parents=True, exist_ok=True)
    adapter_name = adapter.name
    final_gguf = out_dir / f"{adapter_name}-lora-f16.gguf"

    # Locate the bundled convert_lora_to_gguf.py (master snapshot).
    root = Path(__file__).resolve().parents[1]
    lora_script = root / "runtime" / "llama.cpp" / "convert_lora_to_gguf.py"
    if not lora_script.exists():
        raise FileNotFoundError(
            f"convert_lora_to_gguf.py not bundled at {lora_script}. "
            "Re-run the OWLLM updater to fetch llama.cpp master tools."
        )

    # Pick the llamacpp env's Python (has gguf master overlay + torch +
    # safetensors); fall back to the running interpreter.
    env_python_candidates = [
        root / ".envs" / "llamacpp-cu121-edge" / ".venv" / "Scripts" / "python.exe",
        root / ".envs" / "llamacpp-cu121-stable" / ".venv" / "Scripts" / "python.exe",
    ]
    env_python: Optional[Path] = None
    for cand in env_python_candidates:
        if cand.exists():
            env_python = cand
            break
    if env_python is None:
        env_python = Path(sys.executable)

    cmd = [
        str(env_python), "-u", str(lora_script),
        "--base", str(base),
        "--outfile", str(final_gguf),
        "--outtype", "f16",
        str(adapter),
    ]
    log(f"using converter: {lora_script}")
    log(f"using python: {env_python}")
    log(f"running: {' '.join(cmd)}")

    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.stdout:
        log(f"STDOUT (last 800 chars):\n{proc.stdout[-800:]}")
    if proc.stderr:
        log(f"STDERR (last 800 chars):\n{proc.stderr[-800:]}")
    if proc.returncode != 0:
        raise RuntimeError(
            f"convert_lora_to_gguf.py failed (exit {proc.returncode})"
        )
    if not final_gguf.exists():
        raise RuntimeError(
            f"converter returned 0 but no output file at {final_gguf}"
        )

    log(f"GGUF LoRA written: {final_gguf} "
        f"({final_gguf.stat().st_size / 1e6:.1f} MB)")

    # Write a sidecar so any future GGUF dropdown picks this entry up
    # as the canonical adapter file.
    try:
        marker = out_dir / ".selected_weights.json"
        marker.write_text(json.dumps({
            "model_id": f"{adapter_name}-lora-gguf",
            "allow_patterns": [final_gguf.name],
            "active_variant": final_gguf.name,
            "saved_at": __import__("datetime").datetime.now().isoformat(),
            "source_adapter": str(adapter),
            "source_base": str(base),
            "kind": "lora",
        }, indent=2))
    except Exception:
        logger.exception("could not write .selected_weights.json")

    elapsed = time.monotonic() - t0
    log(f"DONE in {elapsed:.1f}s -- {final_gguf}")
    return final_gguf


# ---------------------------------------------------------------------------
# Onboarding registration helper
# ---------------------------------------------------------------------------


def _find_gguf_base_for(hf_base_path: str) -> Optional[Path]:
    """Find a GGUF base on disk that pairs with the given HF base.

    The LoRA was trained against an HF transformers model (e.g.
    ``google/gemma-4-E4B-it``), but llama-server can only serve GGUF.
    Look for an already-onboarded GGUF dir under ``models/`` whose
    base_model_path resolves to the same family — typically the
    unsloth GGUF variant of the same model.

    Strategy:
      1. Read every onboarded GGUF row from the state store.
      2. Pick the one whose model_id family stem matches the HF
         base's family stem (case-insensitive, ignoring vendor
         prefixes and the trailing -GGUF marker).
      3. Resolve to the active_variant .gguf file inside its dir.

    Returns None if no match — caller must error out cleanly.
    """
    try:
        from core.state_store import get_state_store
    except Exception:
        return None

    def _family_key(s: str) -> str:
        s = (s or "").lower()
        s = s.replace("\\", "/").rstrip("/")
        # Strip vendor prefix and -gguf suffix.
        s = s.split("/")[-1]
        s = s.replace("__", "/").split("/")[-1]
        for suffix in ("-gguf", "_gguf"):
            if s.endswith(suffix):
                s = s[: -len(suffix)]
        return s

    target_family = _family_key(hf_base_path)
    if not target_family:
        return None

    store = get_state_store()
    try:
        rows = store.list_onboarding_by_status("READY") or []
    except Exception:
        rows = []

    for row in rows:
        rid = (row.get("model_id") or "").lower()
        bp = row.get("base_model_path") or ""
        # Skip the LoRA-GGUF rows themselves and adapter rows.
        if "__lora_gguf" in rid or row.get("adapter_dir"):
            continue
        # Backend must be a GGUF runtime.
        if str(row.get("backend") or "").lower() not in ("gguf", "llama_cpp_server"):
            continue
        if _family_key(rid) != target_family and _family_key(bp) != target_family:
            continue
        # Found a candidate base — resolve to the active variant.
        bp_path = Path(bp)
        if bp_path.is_file() and bp_path.suffix.lower() == ".gguf":
            return bp_path
        if bp_path.is_dir():
            marker = bp_path / ".selected_weights.json"
            try:
                if marker.exists():
                    data = json.loads(marker.read_text(encoding="utf-8"))
                    av = (data or {}).get("active_variant")
                    if av:
                        cand = bp_path / av
                        if cand.exists():
                            return cand
            except Exception:
                pass
            # No marker — pick the first non-mmproj .gguf.
            for g in sorted(bp_path.glob("*.gguf")):
                if g.name.lower().startswith(("mmproj", "mm-proj", "projector")):
                    continue
                return g
    return None


def _wire_lora_gguf_into_yaml(
    adapter_id: str,
    base_gguf_file: Path,
    adapter_dir: Path,
) -> None:
    """Add a YAML entry for the LoRA-GGUF that shares the base's server.

    Mirrors the transformers-side wiring in ``main._wire_adapter_into_yaml``:
    the base GGUF entry stays unchanged and serves both the base and the
    adapter; the adapter entry has ``shares_server_with`` set so
    ``ensure_server_running`` reuses the base's process and port. The
    ``--lora`` flag is added at startup time by the bundled-proxy env
    injection wired earlier (see llm_server_manager + bundled_proxy_server).

    Without this entry, ``ensure_server_running(<adapter_id>)`` raises
    'Model at <path> is not in config' even though the onboarding row
    is healthy — the YAML is a separate registry the server manager
    consults at chat time.
    """
    import yaml as _yaml
    root = Path(__file__).resolve().parents[1]  # .../LLM
    config_path = root / "configs" / "llm_backends.yaml"

    cfg: dict = {}
    if config_path.exists():
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                cfg = _yaml.safe_load(f) or {}
        except Exception:
            cfg = {}
    if "models" not in cfg or not isinstance(cfg.get("models"), dict):
        cfg["models"] = {}
    models = cfg["models"]

    # Locate the YAML entry whose base_model matches the base GGUF.
    # The base might be referenced by file path (...Q5_K_M.gguf) OR
    # by directory path. Match either form against base_model.
    base_id: Optional[str] = None
    base_file_norm = str(base_gguf_file.resolve()).lower()
    base_dir_norm = str(base_gguf_file.parent.resolve()).lower()
    for mid, entry in models.items():
        if not isinstance(entry, dict):
            continue
        bm = str(entry.get("base_model") or "")
        if not bm:
            continue
        try:
            bm_norm = str(Path(bm).resolve()).lower()
        except OSError:
            bm_norm = bm.lower()
        if bm_norm == base_file_norm or bm_norm == base_dir_norm:
            base_id = mid
            break

    # If no base entry exists yet, create one so ensure_server_running
    # has a target to delegate to. Pick a free port and a sensible
    # default config.
    if base_id is None:
        used_ports = {
            int(e.get("port"))
            for e in models.values()
            if isinstance(e, dict) and isinstance(e.get("port"), (int, str)) and str(e.get("port")).isdigit()
        }
        port = 10500
        while port in used_ports:
            port += 1
        base_id = f"{base_gguf_file.parent.name}__gguf"
        models[base_id] = {
            "base_model": str(base_gguf_file),
            "adapter_dir": None,
            "model_type": "instruct",
            "port": port,
            "use_4bit": False,
            "system_prompt": "",
        }

    # Always (re)write the adapter entry so changes (path moves, quant
    # changes) are reflected. shares_server_with tells the manager not
    # to spawn a second process — base_id's server hosts the adapter
    # via --lora.
    base_entry = models[base_id]
    adapter_entry = models.get(adapter_id, {}) or {}
    adapter_entry.update({
        "base_model": str(base_gguf_file),
        "adapter_dir": str(adapter_dir),
        "model_type": base_entry.get("model_type", "instruct"),
        "port": int(base_entry.get("port", 10500)),
        "use_4bit": base_entry.get("use_4bit", False),
        "system_prompt": adapter_entry.get("system_prompt", ""),
        "shares_server_with": base_id,
    })
    models[adapter_id] = adapter_entry

    try:
        with open(config_path, "w", encoding="utf-8") as f:
            _yaml.safe_dump(cfg, f, sort_keys=False, default_flow_style=False)
    except Exception:
        logger.exception("could not write llm_backends.yaml for %s", adapter_id)
        return

    # Best-effort: ask the global server manager to reload its cached
    # config view so the new entries are visible without an app restart.
    try:
        from core.llm_server_manager import get_global_server_manager
        mgr = get_global_server_manager()
        if mgr is not None and hasattr(mgr, "_load_config"):
            mgr._load_config()
    except Exception:
        pass


def register_in_onboarding(
    gguf_path: Path,
    adapter_name: str,
    base_model_path: str,
    quant: str,
) -> str:
    """Register the LoRA-GGUF in onboarding AND wire it into the YAML config.

    Two registries to keep in sync:

      * ``model_onboarding`` table — drives the dropdown lists. The
        row has ``base_model_path`` = the BASE GGUF FILE (so the
        runtime probe loads a real model) and ``adapter_dir`` = the
        LoRA folder (so the server-manager knows which GGUF LoRA to
        pass via ``--lora``).

      * ``configs/llm_backends.yaml`` — drives the server-manager's
        ``ensure_server_running`` lookup at chat time. Without an
        entry here, picking the LoRA in chat raises 'Model at <path>
        is not in config' even though onboarding is healthy.

    If no GGUF base of the same family is on disk, raise — the user
    has to onboard one first.

    Returns the model_id under which the row was registered.
    """
    from core.state_store import get_state_store
    model_id = f"tuned__{adapter_name}__lora_gguf"

    gguf_base = _find_gguf_base_for(base_model_path)
    if gguf_base is None:
        raise RuntimeError(
            f"No GGUF base model found on disk that pairs with "
            f"{base_model_path!r}. Onboard a matching GGUF (e.g. "
            f"unsloth/...-GGUF for the same family) before the LoRA "
            f"can be served. The .gguf adapter file is on disk at "
            f"{gguf_path} -- only the registration step is failing."
        )

    # 1. Onboarding store row — drives dropdowns.
    store = get_state_store()
    try:
        store.upsert_onboarding(
            model_id=model_id,
            status="READY",
            base_model_path=str(gguf_base),
            adapter_dir=str(gguf_path.parent),
            backend="gguf",
            accelerator="cuda",
            config_key="gguf-lora",
            model_fingerprint="",
            env_key="llamacpp-cu121-stable",
        )
    except Exception:
        logger.exception("could not register onboarding row for %s", model_id)

    # 2. YAML wiring — drives server-manager. Failure here doesn't
    # break the artefact (it's still on disk and registered) but
    # picking it in chat would error out, so log loudly.
    try:
        _wire_lora_gguf_into_yaml(model_id, gguf_base, gguf_path.parent)
    except Exception:
        logger.exception("could not wire %s into llm_backends.yaml", model_id)

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
