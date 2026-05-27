"""One-shot venv rebuilder — recreate the proven-working Python 3.11 setup.

Why this exists
---------------
A previous Repair attempt tried to swap the venv's Python version
from 3.11 to 3.12 from inside the running OWLLM process. Windows
held the venv's ``python.exe`` and a few ``.pyd`` files locked,
so the destroy step deleted MOST package directories under
``Lib/site-packages/`` but couldn't finish the job.

We then tried to recover by recreating the venv as Python 3.12 to
match the cp312 wheels already cached on disk. That ALSO failed:
``python_runtime/python3.12`` is the embeddable distribution and
the bundled ``virtualenv 21.2`` produces a venv whose Python
can't even load ``ctypes``::

    AttributeError: class must define a '_type_' attribute

That's an ABI mismatch we can't paper over from a script — the
embeddable's _ctypes.pyd doesn't line up with the stdlib
ctypes/__init__.py that virtualenv copies in.

The combo that DOES work — the same one your original install
used — is **Python 3.11** as both bootstrapper and target. So
this script abandons the cp312 wheelhouse on disk (it's
unusable in a Python 3.11 venv) and rebuilds the environment
as cp311:

  1. Confirms OWLLM is closed.
  2. Resolves the canonical env_key via the same path the
     launcher uses (``core.runtime.owllm_python.get_owllm_env``).
  3. Deletes the broken venv (no locks once OWLLM is closed).
  4. Creates a fresh Python **3.11** venv via
     ``virtualenv -p python_runtime/python3.11`` (with default
     seed — virtualenv 21.2's bundled pip is fine on 3.11).
  5. Installs requirements.txt from PyPI + the PyTorch CUDA
     index. ~1.5 GB one-time download — yes, this DOES require
     internet, because every cp311 wheel was overwritten in the
     wheelhouse by an earlier wheelhouse-prep run that targeted
     Python 3.12.

Usage (Windows PowerShell, with OWLLM fully closed):

    cd C:\\1_Git\\LocaLLM
    .\\LLM\\python_runtime\\python3.11\\python.exe LLM\\bootstrap_rebuild_venv.py
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent  # LLM/
REPO_ROOT = SCRIPT_DIR.parent
PYTHON_RUNTIME = SCRIPT_DIR / "python_runtime"
PY311 = PYTHON_RUNTIME / "python3.11" / "python.exe"


def banner(title: str) -> None:
    line = "=" * 70
    print(f"\n{line}\n  {title}\n{line}")


def fail(msg: str, code: int = 1) -> None:
    print(f"\n[ERROR] {msg}")
    sys.exit(code)


def assert_running_from_safe_python() -> None:
    """Refuse to run from inside the very venv we're about to destroy."""
    me = Path(sys.executable).resolve()
    if ".envs" in str(me).lower() and ".venv" in str(me).lower():
        fail(
            "This script is running from the broken venv itself.\n"
            "Run it with the bundled python_runtime/python3.11 instead, e.g.:\n"
            f"  {PY311} {Path(__file__).name}"
        )


def resolve_env_key() -> tuple[str, Path]:
    sys.path.insert(0, str(SCRIPT_DIR))
    from core.runtime.owllm_python import get_owllm_env  # type: ignore
    env = get_owllm_env(SCRIPT_DIR, force_refresh=True)
    return env.env_key, env.venv_dir


def detect_owllm_processes() -> list[int]:
    if sys.platform != "win32":
        return []
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq python.exe", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=10,
            creationflags=0x08000000,
        )
    except Exception:
        return []
    pids: list[int] = []
    for line in (out.stdout or "").splitlines():
        parts = [p.strip().strip('"') for p in line.split(",")]
        if len(parts) >= 2 and parts[0].lower() == "python.exe":
            try:
                pids.append(int(parts[1]))
            except ValueError:
                pass
    return pids


def delete_broken_venv(venv_dir: Path) -> None:
    if not venv_dir.exists():
        print(f"  (venv dir doesn't exist; nothing to delete: {venv_dir})")
        return
    print(f"  Deleting {venv_dir} …")

    def onerror(func, path, _exc):
        try:
            os.chmod(path, 0o666)
            func(path)
        except Exception:
            print(f"    (could not delete {path}; continuing)")

    shutil.rmtree(venv_dir, onerror=onerror)
    for _ in range(3):
        if not venv_dir.exists():
            break
        time.sleep(0.6)
        try:
            shutil.rmtree(venv_dir, onerror=onerror)
        except Exception:
            pass
    if venv_dir.exists():
        fail(
            f"Could not fully delete {venv_dir}. Make sure OWLLM is closed "
            "(check Task Manager for python.exe) and re-run this script."
        )
    print("  ✓ Broken venv removed")


def ensure_python311_runtime() -> None:
    if not PY311.exists():
        fail(
            f"Bundled Python 3.11 not found at {PY311}.\n"
            "Re-run the OWLLM installer to refresh the python_runtime/ folder."
        )


def create_venv_python311(venv_dir: Path) -> None:
    """Create a Python 3.11 venv via the bundled virtualenv.

    virtualenv 21.2's seed pip / setuptools / wheel match Python 3.11
    cleanly, so we let virtualenv seed them — no manual get-pip
    bootstrap needed. Python 3.11 + virtualenv 21.2 is the
    proven-working combination (your original install used it).
    """
    print(f"  Creating Python 3.11 venv at {venv_dir} …")
    cmd = [
        str(PY311), "-m", "virtualenv",
        "-p", str(PY311),
        "--no-periodic-update",
        str(venv_dir),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if proc.returncode != 0:
        fail(
            "virtualenv failed to create the new venv.\n"
            f"stdout: {proc.stdout[-800:]}\nstderr: {proc.stderr[-800:]}"
        )
    new_python = venv_dir / "Scripts" / "python.exe"
    if not new_python.exists():
        fail(f"Venv created but python.exe missing at {new_python}")

    # Sanity: ctypes works, pip runs.
    sanity = subprocess.run(
        [str(new_python), "-c", "import sys, ctypes; ctypes.c_int(0); print(sys.version_info[:2])"],
        capture_output=True, text=True, timeout=30,
    )
    if sanity.returncode != 0:
        fail(
            "New venv's Python failed the ctypes sanity check.\n"
            f"stderr: {sanity.stderr[-1000:]}"
        )
    print(f"  ✓ New venv reports: {sanity.stdout.strip()}")

    pip_check = subprocess.run(
        [str(new_python), "-m", "pip", "--version"],
        capture_output=True, text=True, timeout=30,
    )
    if pip_check.returncode != 0:
        fail(
            "Seeded pip is broken in the new venv.\n"
            f"stderr: {pip_check.stderr[-800:]}"
        )
    print(f"  ✓ pip OK: {pip_check.stdout.strip()}")


def install_from_pypi(venv_dir: Path) -> None:
    """Install requirements.txt from PyPI + the PyTorch CUDA index.

    PyPI hosts cp311 wheels for everything in requirements.txt and
    download.pytorch.org/whl/cu121 hosts cp311 torch wheels.
    ~1.5 GB one-time. Live progress is streamed straight to the
    terminal — pip download progress is the user's signal that
    things are happening, so we don't capture stdout.
    """
    new_python = venv_dir / "Scripts" / "python.exe"
    requirements = SCRIPT_DIR / "requirements.txt"
    if not requirements.exists():
        fail(f"requirements.txt not found at {requirements}")

    print("  Upgrading pip / setuptools / wheel inside the venv …")
    rc = subprocess.call([
        str(new_python), "-m", "pip", "install",
        "--upgrade", "--no-warn-script-location",
        "pip", "setuptools", "wheel",
    ])
    if rc != 0:
        fail(f"pip self-upgrade failed (exit {rc})")

    print("  Installing torch+cu121 from the PyTorch CUDA index …")
    rc = subprocess.call([
        str(new_python), "-m", "pip", "install",
        "--index-url", "https://download.pytorch.org/whl/cu121",
        "--no-warn-script-location",
        "torch==2.5.1+cu121",
        "torchvision==0.20.1+cu121",
        "torchaudio==2.5.1+cu121",
    ])
    if rc != 0:
        fail(f"torch install failed (exit {rc})")

    print(f"  Installing the rest from {requirements.name} …")
    rc = subprocess.call([
        str(new_python), "-m", "pip", "install",
        "--no-warn-script-location",
        "-r", str(requirements),
    ])
    if rc != 0:
        fail(f"requirements.txt install failed (exit {rc})")
    print("  ✓ All packages installed")


def main() -> int:
    banner("OWLLM venv rebuilder — Python 3.11 (proven working)")
    print(f"  Repo root:   {REPO_ROOT}")
    print(f"  Script dir:  {SCRIPT_DIR}")

    assert_running_from_safe_python()
    ensure_python311_runtime()

    pids = detect_owllm_processes()
    if pids:
        print(
            f"  ⚠ Found {len(pids)} python.exe process(es) running. If any of "
            "them is OWLLM, close it now (Task Manager) — Windows file locks "
            "will otherwise block the rebuild."
        )
        print("  (Sleeping 5s. Hit Ctrl+C if you need to close OWLLM first.)")
        try:
            time.sleep(5)
        except KeyboardInterrupt:
            return 1

    env_key, venv_dir = resolve_env_key()
    print(f"  env_key:    {env_key}")
    print(f"  venv path:  {venv_dir}")

    banner("Step 1/3 — Delete the broken venv")
    delete_broken_venv(venv_dir)

    banner("Step 2/3 — Create a fresh Python 3.11 venv")
    create_venv_python311(venv_dir)

    banner("Step 3/3 — Install requirements.txt from PyPI (~1.5 GB one-time)")
    install_from_pypi(venv_dir)

    banner("Done")
    print(
        "  Reopen OWLLM. The home page System Status should go green; "
        "if anything still looks off, click Refresh Hardware Detection."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
