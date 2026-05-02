"""One-shot venv rebuilder — recover from a partially-destroyed env without redownloading wheels.

Why this exists
---------------
A previous Repair attempt tried to swap the venv's Python version
from inside the running OWLLM process. Windows held the venv's
``python.exe`` and a few ``.pyd`` files locked, so the destroy step
deleted *most* package directories under ``Lib/site-packages/`` but
couldn't finish the job. The user is left with a venv that has only
``python.exe`` + 3-4 packages and an OWLLM home page that correctly
reports "everything missing".

The cp312 wheels are already cached in
``LLM/wheelhouse/<env_key>/`` — the user shouldn't have to download
anything again. This script:

1. Confirms OWLLM is closed (no python.exe holds the venv tree).
2. Resolves the canonical env_key via the same path the launcher
   uses (``core.runtime.owllm_python.get_owllm_env``).
3. Deletes the broken venv (no locks now → succeeds).
4. Creates a fresh Python 3.12 venv at the same path, using the
   bundled ``python_runtime/python3.11`` plus its vendored
   ``virtualenv`` package (Python 3.12 is the embeddable distro
   without a ``Lib/venv`` module so we can't ``-m venv`` it
   directly; ``virtualenv -p`` works regardless).
5. Installs every wheel in ``LLM/wheelhouse/<env_key>/`` into the
   new venv with ``pip install --no-index --find-links``. Fully
   offline.

Usage (Windows PowerShell):

    cd C:\\1_Git\\LocaLLM
    .\\LLM\\python_runtime\\python3.11\\python.exe LLM\\bootstrap_rebuild_venv.py

Or invoke through the launcher's Python — anything that's NOT the
broken venv will do.
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
PY312 = PYTHON_RUNTIME / "python3.12" / "python.exe"


def banner(title: str) -> None:
    line = "=" * 70
    print(f"\n{line}\n  {title}\n{line}")


def fail(msg: str, code: int = 1) -> None:
    print(f"\n[ERROR] {msg}")
    sys.exit(code)


def assert_running_from_safe_python() -> None:
    """Refuse to run from inside the very venv we're about to destroy."""
    me = Path(sys.executable).resolve()
    target_hint = ".envs"
    if target_hint in str(me).lower() and ".venv" in str(me).lower():
        fail(
            "This script is running from the broken venv itself.\n"
            "Run it with the bundled python_runtime/python3.11 instead, e.g.:\n"
            f"  {PY311} {Path(__file__).name}"
        )


def resolve_env_key() -> tuple[str, Path, Path]:
    """Use the canonical resolver so we hit the same env the launcher uses."""
    sys.path.insert(0, str(SCRIPT_DIR))
    from core.runtime.owllm_python import get_owllm_env  # type: ignore

    env = get_owllm_env(SCRIPT_DIR, force_refresh=True)
    venv_dir = env.venv_dir
    wheelhouse_dir = SCRIPT_DIR / "wheelhouse" / env.env_key
    if not wheelhouse_dir.exists():
        # Fallback: top-level wheelhouse (older single-wheelhouse layouts).
        alt = SCRIPT_DIR / "wheelhouse"
        if alt.exists() and any(alt.glob("*.whl")):
            wheelhouse_dir = alt
    return env.env_key, venv_dir, wheelhouse_dir


def detect_owllm_processes() -> list[int]:
    """Return PIDs of any python processes that look like OWLLM."""
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
        # CSV: "python.exe","12345","Console","1","123,456 K"
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
        # Try to clear read-only and retry once.
        try:
            os.chmod(path, 0o666)
            func(path)
        except Exception:
            print(f"    (could not delete {path}; continuing)")

    # rmtree with onerror so a single locked file doesn't abort the whole tree.
    shutil.rmtree(venv_dir, onerror=onerror)
    # If anything stragglers remain, retry up to 3 times with a short delay.
    for attempt in range(3):
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
            f"(check Task Manager for python.exe) and re-run this script."
        )
    print("  ✓ Broken venv removed")


def ensure_python312_runtime() -> None:
    if not PY312.exists():
        fail(
            f"Bundled Python 3.12 not found at {PY312}.\n"
            "Re-run the OWLLM installer to refresh the python_runtime/ folder."
        )


def create_venv_with_virtualenv(venv_dir: Path) -> None:
    """Use python3.11 + vendored virtualenv to create a Python 3.12 venv,
    then bootstrap pip ourselves with the bundled ``get-pip.py``.

    Why we don't let virtualenv seed pip:
      The bundled ``virtualenv 21.2`` ships pre-built pip / setuptools /
      wheel seed wheels that pre-date Python 3.12. When virtualenv
      copies those into a 3.12 venv, the seeded pip can't even
      ``import ctypes`` because its compiled bits don't match the
      3.12 runtime ABI — that was the
      ``AttributeError: class must define a '_type_' attribute`` you
      saw on the previous attempt.

    So:
      1. ``virtualenv -p python3.12 --no-pip --no-setuptools --no-wheel``
         to create an empty Python 3.12 venv.
      2. Run ``get-pip.py`` (shipped with python_runtime/python3.12/
         and therefore version-matched) against the new venv's
         ``python.exe`` to install a 3.12-compatible pip / setuptools
         / wheel from the bundled get-pip.
      3. From that point on every pip call uses the freshly bootstrapped
         3.12 pip — no more ABI mismatch.
    """
    if not PY311.exists():
        fail(
            f"Bundled Python 3.11 not found at {PY311}.\n"
            "Re-run the OWLLM installer to refresh the python_runtime/ folder."
        )
    print(f"  Creating empty Python 3.12 venv at {venv_dir} (no seeded packages)…")
    cmd = [
        str(PY311), "-m", "virtualenv",
        "-p", str(PY312),
        "--no-pip",
        "--no-setuptools",
        "--no-wheel",
        "--no-periodic-update",
        str(venv_dir),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if proc.returncode != 0:
        fail(
            "virtualenv failed to create the new venv.\n"
            f"stdout: {proc.stdout[-500:]}\nstderr: {proc.stderr[-500:]}"
        )
    new_python = venv_dir / "Scripts" / "python.exe"
    if not new_python.exists():
        fail(f"Venv created but python.exe missing at {new_python}")

    # Verify the venv's Python is truly 3.12 AND its stdlib (ctypes etc.)
    # imports cleanly. This is the gate that detects the abi-mismatch
    # condition before we hit it via pip.
    sanity = subprocess.run(
        [
            str(new_python),
            "-c",
            "import sys, ctypes; print(sys.version_info[:2]); ctypes.c_int(0)",
        ],
        capture_output=True, text=True, timeout=30,
    )
    if sanity.returncode != 0:
        fail(
            "New venv's stdlib import failed (ctypes / runtime mismatch).\n"
            f"stderr: {sanity.stderr[-1000:]}"
        )
    print(f"  ✓ New venv reports: {sanity.stdout.strip()}")

    # Bootstrap pip using the version-matched get-pip.py shipped with
    # python_runtime/python3.12. This installs pip + setuptools + wheel
    # using the new venv's own runtime, so the resulting pip can import
    # ctypes correctly.
    get_pip = SCRIPT_DIR / "python_runtime" / "python3.12" / "get-pip.py"
    if not get_pip.exists():
        fail(
            f"get-pip.py not found at {get_pip}. Re-run the OWLLM installer "
            "to refresh the python_runtime/ folder."
        )
    print(f"  Bootstrapping pip via {get_pip.name} …")
    boot = subprocess.run(
        [str(new_python), str(get_pip), "--no-cache-dir", "--no-warn-script-location"],
        capture_output=True, text=True, timeout=300,
    )
    if boot.returncode != 0:
        fail(
            "get-pip.py failed.\n"
            f"stdout: {boot.stdout[-500:]}\nstderr: {boot.stderr[-1000:]}"
        )
    print("  ✓ pip bootstrapped")


def install_from_wheelhouse(venv_dir: Path, wheelhouse_dir: Path) -> None:
    new_python = venv_dir / "Scripts" / "python.exe"
    wheel_count = len(list(wheelhouse_dir.glob("*.whl")))
    print(f"  Installing from {wheelhouse_dir} ({wheel_count} wheels) …")
    if wheel_count == 0:
        fail(
            f"No .whl files at {wheelhouse_dir}. Run the regular OWLLM "
            f"installer/Repair to populate the wheelhouse first."
        )
    cmd = [
        str(new_python), "-m", "pip", "install",
        "--no-index",
        "--find-links", str(wheelhouse_dir),
        "--no-cache-dir",
    ]
    # Install every .whl in the wheelhouse — pip resolves the dep graph.
    cmd.extend(str(p) for p in wheelhouse_dir.glob("*.whl"))
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    if proc.returncode != 0:
        fail(
            "Offline pip install failed.\n"
            f"stdout tail: {proc.stdout[-1500:]}\nstderr tail: {proc.stderr[-1500:]}"
        )
    print("  ✓ Wheels installed from local cache")


def main() -> int:
    banner("OWLLM venv rebuilder — offline recovery")
    print(f"  Repo root:   {REPO_ROOT}")
    print(f"  Script dir:  {SCRIPT_DIR}")

    assert_running_from_safe_python()
    ensure_python312_runtime()

    pids = detect_owllm_processes()
    if pids:
        # Don't refuse outright — it's safe enough to continue if OWLLM
        # is using a different venv. But warn loudly.
        print(
            f"  ⚠ Found {len(pids)} python.exe process(es) running. If any of "
            "them is OWLLM, close it now (Task Manager) before continuing — "
            "Windows file locks will otherwise block the rebuild."
        )
        print("  (Sleeping 5s. Hit Ctrl+C if you need to close OWLLM first.)")
        try:
            time.sleep(5)
        except KeyboardInterrupt:
            return 1

    env_key, venv_dir, wheelhouse_dir = resolve_env_key()
    print(f"  env_key:        {env_key}")
    print(f"  venv path:      {venv_dir}")
    print(f"  wheelhouse:     {wheelhouse_dir}")

    if not wheelhouse_dir.exists():
        fail(f"Wheelhouse directory not found: {wheelhouse_dir}")

    banner("Step 1/3 — Delete the broken venv")
    delete_broken_venv(venv_dir)

    banner("Step 2/3 — Create a fresh Python 3.12 venv")
    create_venv_with_virtualenv(venv_dir)

    banner("Step 3/3 — Install all wheels from the local cache")
    install_from_wheelhouse(venv_dir, wheelhouse_dir)

    banner("Done")
    print(
        "  Reopen OWLLM. The home page System Status should turn green; "
        "if anything still looks off, click Refresh Hardware Detection."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
