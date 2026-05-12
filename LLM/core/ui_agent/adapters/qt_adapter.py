"""Qt adapter — runs the subprocess runner and returns a normalized CaptureResult."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Optional

from core.ui_agent.schema import Bounds, CaptureResult, UIElement


def capture(
    page: str,
    out_png: str,
    out_tree: str,
    *,
    width: int = 1600,
    height: int = 960,
    wait_seconds: float = 5.0,
    include_frame: bool = True,
    python_exe: Optional[str] = None,
    timeout: int = 180,
) -> CaptureResult:
    """Boot the OWLLM app, switch to `page`, capture PNG + widget tree.

    `python_exe` defaults to the venv interpreter that has PySide6. Override
    only if you know what you're doing.
    """
    llm_root = Path(__file__).resolve().parents[3]
    if python_exe is None:
        python_exe = str(
            llm_root / ".envs" / "tf-cu121-t25-base-stable" / ".venv" / "Scripts" / "python.exe"
        )
        if not Path(python_exe).exists():
            python_exe = sys.executable
    runner = Path(__file__).parent / "_qt_subprocess_runner.py"
    payload = {
        "page": page,
        "out_png": str(out_png),
        "out_tree": str(out_tree),
        "width": width, "height": height,
        "wait_seconds": wait_seconds,
        "include_frame": include_frame,
    }
    proc = subprocess.run(
        [python_exe, str(runner)],
        input=json.dumps(payload),
        text=True, capture_output=True,
        cwd=str(llm_root), timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"qt adapter subprocess failed (rc={proc.returncode}):\n"
            f"STDERR:\n{proc.stderr}\nSTDOUT:\n{proc.stdout}"
        )
    # Parse the result line (last non-empty stdout line is the JSON summary)
    lines = [l for l in proc.stdout.splitlines() if l.strip().startswith("{")]
    if not lines:
        raise RuntimeError(f"runner produced no JSON; stdout:\n{proc.stdout}")
    summary = json.loads(lines[-1])
    tree_data = json.loads(Path(out_tree).read_text(encoding="utf-8"))
    root = UIElement.from_dict(tree_data)
    return CaptureResult(
        png_path=str(out_png),
        root=root,
        width=int(summary.get("width", width)),
        height=int(summary.get("height", height)),
        raw={"stable": summary.get("stable"), "attempts": summary.get("attempts"),
             "drift_history": summary.get("drift_history")},
    )
