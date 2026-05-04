from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import List, Dict, Optional
import os
import subprocess
import sys
from datetime import datetime


def get_app_root() -> Path:
    return Path(__file__).resolve().parents[1]


@dataclass
class TrainingConfig:
    base_model: str
    data_path: Path
    output_dir: Path
    epochs: int = 1
    batch_size: int = 1
    learning_rate: float = 2e-4
    max_seq_length: int = 2048
    lora_r: int = 16
    lora_alpha: int = 16
    lora_dropout: float = 0.0
    use_4bit: bool = True
    adapter_name: Optional[str] = None
    """User-supplied adapter directory name (typed in the Model Name field
    of the training panel). When set, finetune.py saves the adapter to
    ``<output_dir>/<adapter_name>`` instead of the default
    ``adapter_<timestamp>``. ``None`` falls back to the timestamped name."""


def build_finetune_cmd(cfg: TrainingConfig) -> List[str]:
    # Use python.exe instead of pythonw.exe for training to get real-time output
    # pythonw.exe buffers output even with -u flag when there's no TTY
    python_exe = sys.executable
    if python_exe.endswith("pythonw.exe"):
        python_exe = python_exe.replace("pythonw.exe", "python.exe")

    cmd = [
        python_exe, "-u", "finetune.py",
        "--model-name", cfg.base_model,  # finetune.py uses --model-name, not --base-model
        "--data-path", str(cfg.data_path),
        "--output-dir", str(cfg.output_dir),
        "--epochs", str(cfg.epochs),
        "--batch-size", str(cfg.batch_size),
        "--learning-rate", str(cfg.learning_rate),
        "--max-seq-length", str(cfg.max_seq_length),
        "--lora-r", str(cfg.lora_r),
        "--lora-alpha", str(cfg.lora_alpha),
        "--lora-dropout", str(cfg.lora_dropout),
        # Note: finetune.py always uses 4-bit (hardcoded), no --use-4bit flag needed
    ]
    if cfg.adapter_name:
        cmd.extend(["--adapter-name", cfg.adapter_name])
    return cmd


def default_output_dir() -> Path:
    """Return base fine_tuned directory - no timestamped subdirectories"""
    root = get_app_root()
    out = root / "fine_tuned"
    out.mkdir(parents=True, exist_ok=True)
    return out


def _training_no_window_flags() -> Dict[str, object]:
    """Return subprocess kwargs. Console windows are intentionally not hidden."""
    return {}


def start_training_process(cfg: TrainingConfig, env: Optional[Dict[str, str]] = None) -> subprocess.Popen:
    workdir = str(get_app_root())
    proc_env = os.environ.copy()
    if env:
        proc_env.update(env)
    cmd = build_finetune_cmd(cfg)
    return subprocess.Popen(
        cmd,
        cwd=workdir,
        env=proc_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        universal_newlines=True,
        encoding="utf-8",
        errors="replace",
        **_training_no_window_flags(),
    )
