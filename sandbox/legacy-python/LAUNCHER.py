#!/usr/bin/env python3
"""
LAUNCHER.py - Python Launcher for LLM Fine-tuning Studio
Pure Python equivalent of Launcher.exe that works on ANY computer with Python
"""

import sys
import os
import subprocess
from pathlib import Path
import time

_llm_root = str(Path(__file__).resolve().parent)
if _llm_root not in sys.path:
    sys.path.insert(0, _llm_root)

# Do not hide child console windows.
SUBPROCESS_FLAGS = {}

def log(message):
    """Print log message"""
    try:
        print(f"[LAUNCHER] {message}")
    except UnicodeEncodeError:
        # Windows consoles may default to cp1252; avoid crashing on ✓ etc.
        safe = str(message).replace("✓", "[OK]").replace("✗", "[FAIL]").replace("⚠", "[WARN]")
        print(f"[LAUNCHER] {safe}")


def _wait_for_user(prompt: str = "Press Enter to exit...") -> None:
    """Pause for the user only when running interactively.

    When ``launcher.exe`` invokes us, stdin is not a tty and ``input()``
    would hang forever waiting for keystrokes nobody can deliver. Skip the
    wait in that case so a failed launch returns control immediately.
    """
    try:
        if sys.stdin and sys.stdin.isatty():
            input(prompt)
    except Exception:
        pass

def find_venv_python():
    """Return the canonical OWLLM Python (single source of truth).

    Delegates to ``core.runtime.owllm_python.get_owllm_python``. There is
    exactly ONE answer derived from the profile files
    (``compatibility_matrix.json`` + ``setup_state``). No legacy ``.venv``
    fallback, no bootstrap fallback — if the resolved env doesn't exist,
    we return ``None`` and the caller launches the installer to create it.
    """
    llm_dir = Path(__file__).parent
    try:
        from core.runtime.owllm_python import get_owllm_python, get_owllm_env, OwllmEnvNotInstalled
        try:
            py = get_owllm_python(llm_dir)
            try:
                env = get_owllm_env(llm_dir)
                log(f"Resolved OWLLM env: {env.env_key}")
            except Exception:
                pass
            return py
        except OwllmEnvNotInstalled as exc:
            log(f"OWLLM env not installed: {exc.env_key} (expected at {exc.expected_path})")
            return None
    except Exception as e:
        log(f"OWLLM env resolution failed: {e}")
        return None

def check_venv_health(venv_python):
    """Check if venv Python and PySide6 are working"""
    try:
        # Test if venv Python works
        result = subprocess.run(
            [str(venv_python), "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            **SUBPROCESS_FLAGS
        )
        if result.returncode != 0:
            log("Venv Python check failed")
            return False

        # Test if PySide6 can be imported
        result = subprocess.run(
            [str(venv_python), "-c", "import PySide6.QtCore; print('OK')"],
            capture_output=True,
            text=True,
            timeout=10,
            **SUBPROCESS_FLAGS
        )
        if result.returncode != 0 or "OK" not in result.stdout:
            log("PySide6 check failed - dependencies broken")
            return False

        return True
    except Exception as e:
        log(f"Health check failed: {e}")
        return False


def check_torch_stack_health(venv_python):
    """Probe torch/torchvision/torchaudio in the venv via subprocess.

    Returns ``(ok: bool, reason: str)``. ``ok=False`` means the workload
    venv has a torch stack that will crash the app the moment a tab
    touches it — we MUST NOT proceed to launch_app, because OWLLM runs
    inside this venv and a torchvision._C.pyd ABI mismatch (or a missing
    libtorch DLL, or CPU-only torch where CUDA is expected) will kill
    the parent process at first touch with no Python traceback.

    The probe is the same one the installer's _ensure_torch_trio_coherent
    uses, just lifted earlier so we can REFUSE TO LAUNCH instead of
    crashing post-launch. Cheap (~1 s) when healthy.
    """
    probe = (
        "import sys\n"
        "try:\n"
        "    import torch\n"
        "    import torchvision\n"
        "    import torchaudio\n"
        "    cuda_ok = bool(getattr(torch, 'cuda', None) and torch.cuda.is_available())\n"
        "    print('TORCH_OK', torch.__version__, torchvision.__version__, torchaudio.__version__, 'cuda=', cuda_ok)\n"
        "except Exception as e:\n"
        "    print('TORCH_FAIL', type(e).__name__, str(e))\n"
        "    sys.exit(2)\n"
    )
    try:
        result = subprocess.run(
            [str(venv_python), "-c", probe],
            capture_output=True,
            text=True,
            timeout=30,
            **SUBPROCESS_FLAGS,
        )
    except subprocess.TimeoutExpired:
        return False, "torch import probe timed out (DLL hang likely)"
    except Exception as e:
        return False, f"could not run torch probe: {e}"

    out = (result.stdout or "") + "\n" + (result.stderr or "")
    if result.returncode == 0 and "TORCH_OK" in out:
        # Even if the probe succeeded, "cuda=False" on a CUDA profile is
        # a soft fail — we let the launcher proceed (the user might be
        # on a CPU-only setup intentionally) but log it. The HARD fail
        # here is import-time crash, which is what we redirect to safe
        # mode for.
        return True, out.strip()

    # Hard fail — match the same ABI-mismatch / CPU-only / missing-DLL
    # fingerprints the installer uses. Any of these in the probe output
    # means the venv is in a state where launching the app would crash.
    fingerprints = (
        "intrusive_ptr_target",
        "c10::",
        "could not be located in the dynamic link library",
        "_c.pyd",
        "dll load failed while importing _c",
        "undefined symbol",
        "not a directory",  # sometimes accompanies a wrecked install
        "modulenotfounderror: no module named 'torch'",
        "modulenotfounderror: no module named 'torchvision'",
        "modulenotfounderror: no module named 'torchaudio'",
    )
    low = out.lower()
    if any(fp in low for fp in fingerprints):
        return False, out.strip()
    # Unknown error but probe exited non-zero — be conservative.
    return False, out.strip() or f"torch probe exited {result.returncode}"


def find_bootstrap_python():
    """Locate the bundled python_runtime/pythonX.Y/python.exe.

    Used as the safe-mode interpreter when the workload venv's torch
    stack is broken. The bootstrap runtime is part of OWLLM's bundle —
    no system Python required, true to the self-contained design intent.
    Prefers 3.12 (matches the current installer target) and falls back
    to 3.11.
    """
    llm_dir = Path(__file__).parent
    candidates = [
        llm_dir / "python_runtime" / "python3.12" / "python.exe",
        llm_dir / "python_runtime" / "python3.11" / "python.exe",
    ]
    for p in candidates:
        if p.exists():
            return p
    return None


def launch_safe_mode_installer(reason: str):
    """Launch the safe-mode repair runner from the BUNDLED Python.

    Critical: never use the workload venv interpreter here — it's the
    one that's broken. We also can't route to the legacy tkinter-based
    ``installer_gui.py`` because the bundled embeddable Python doesn't
    ship tkinter (confirmed empirically — that crash is what motivated
    this rewrite). Instead we spawn ``safe_mode_repair.py``, a stdlib-
    only console script that wraps ``InstallerV2.repair()``. The user
    sees the repair as text in a console window. No GUI deps required.

    The ``cmd /K`` wrapper is intentional: when the bundled Python
    finishes the repair, the console stays open so the user can read
    pip's actual output before deciding to re-launch OWLLM.
    """
    llm_dir = Path(__file__).parent
    bootstrap_py = find_bootstrap_python()
    if not bootstrap_py:
        log("✗ Bundled bootstrap Python not found — cannot enter safe mode.")
        log("  Looked under: LLM/python_runtime/python3.12/, python3.11/")
        return False
    # New: route to the safe_mode package, which auto-picks Qt vs console
    # based on whether PySide6 is reachable in the bundled interpreter.
    # The legacy safe_mode_repair.py at LLM root is left in place as a
    # last-resort fallback so existing installs that haven't pulled the
    # safe_mode/ package still have something to run.
    safe_pkg_main = llm_dir / "safe_mode" / "__main__.py"
    legacy_safe_repair = llm_dir / "safe_mode_repair.py"

    if safe_pkg_main.exists():
        # Direct script invocation rather than ``-m safe_mode``: the
        # bundled embeddable Python doesn't put cwd on sys.path by
        # default, so ``-m`` lookup fails with 'No module named
        # safe_mode'. Running __main__.py as a path always works
        # because the file path is what python loads.
        target = [str(safe_pkg_main)]
        target_label = "safe_mode (Qt-if-available, console-fallback)"
    elif legacy_safe_repair.exists():
        target = [str(legacy_safe_repair)]
        target_label = "safe_mode_repair.py (legacy console)"
    else:
        log(f"✗ Neither {safe_pkg_main} nor {legacy_safe_repair} exists.")
        return False

    log("⚠ Workload venv is broken at the C-extension layer:")
    for line in (reason or "").splitlines()[-10:]:
        log(f"    {line}")
    log("")
    log("Routing to SAFE MODE — repair runs from the bundled Python.")
    log(f"Interpreter: {bootstrap_py}")
    log(f"Target:      {target_label}")

    try:
        print(f"[LAUNCHER] process_start: {target_label}", file=sys.stderr)
        # Belt-and-braces: PYTHONPATH guarantees the LLM dir is
        # importable regardless of which Python is invoked / how
        # the embeddable distribution's _pth file is configured.
        env = os.environ.copy()
        existing = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = (
            str(llm_dir) + (os.pathsep + existing if existing else "")
        )
        # CREATE_NEW_CONSOLE = 0x00000010 on Windows so the console
        # safe-mode is visible (launcher.exe is GUI-subsystem). Qt
        # safe-mode opens its own window so it doesn't need the
        # console; the flag is a no-op for it.
        if sys.platform == "win32":
            subprocess.Popen(
                [str(bootstrap_py), *target],
                cwd=str(llm_dir),
                env=env,
                creationflags=0x00000010,
            )
        else:
            subprocess.Popen(
                [str(bootstrap_py), *target],
                cwd=str(llm_dir),
                env=env,
            )
        return True
    except Exception as e:
        log(f"Failed to launch safe-mode installer: {e}")
        return False

def run_dependency_check(venv_python):
    """Run check_dependencies.py"""
    llm_dir = Path(__file__).parent
    check_script = llm_dir / "check_dependencies.py"
    
    if not check_script.exists():
        log("Warning: check_dependencies.py not found, skipping check")
        return True
    
    try:
        log("Running dependency check...")
        result = subprocess.run(
            [str(venv_python), str(check_script)],
            capture_output=True,
            text=True,
            timeout=30,
            **SUBPROCESS_FLAGS
        )
        
        # Print output for debugging
        if result.stdout:
            for line in result.stdout.splitlines():
                print(f"  {line}")
        
        if result.returncode == 0:
            log("✓ Dependency check passed")
            return True
        else:
            log("✗ Dependency check failed")
            if result.stderr:
                for line in result.stderr.splitlines():
                    print(f"  ERROR: {line}")
            return False
    except Exception as e:
        log(f"Dependency check error: {e}")
        return False

def launch_installer(reason: str = "Dependencies need install/update.") -> bool:
    """Open the unified safe-mode repair UI.

    All 'environment needs work' paths now route through this single
    entry point. We delegate to ``launch_safe_mode_installer`` so the
    user sees the SAME Qt window (with checklist + reason + plan +
    progress) regardless of whether the trigger was a missing venv,
    failed PySide6 import, broken torch, or version-drift in the
    dependency check.

    The legacy ``installer_gui.py`` (tkinter) and ``run_installer.bat``
    (bootstrap-Python launcher) are no longer reachable from here —
    they were a parallel UX with worse diagnostics. ``installer_gui.py``
    still exists on disk for users who want to invoke it manually,
    but the launcher will never auto-spawn it.
    """
    return launch_safe_mode_installer(reason)

def launch_app(venv_python):
    """Launch the main application"""
    llm_dir = Path(__file__).parent
    
    log("Launching application...")
    
    try:
        print("[LAUNCHER] process_start: desktop_app.main", file=sys.stderr)
        # Launch desktop_app.main
        result = subprocess.Popen(
            [str(venv_python), "-m", "desktop_app.main"],
            cwd=str(llm_dir),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            **SUBPROCESS_FLAGS
        )
        
        # Wait a moment to see if it crashes immediately
        time.sleep(2)
        if result.poll() is not None:
            # Process exited already - that's bad
            log("ERROR: Application exited immediately")
            stdout, stderr = result.communicate(timeout=1)
            if stderr:
                log(f"Error output: {stderr.decode('utf-8', errors='ignore')}")
            return False
        
        log("✓ Application launched successfully")
        return True
    except Exception as e:
        log(f"Failed to launch app: {e}")
        return False

def main():
    """Main launcher logic"""
    print("=" * 60)
    print("LLM FINE-TUNING STUDIO - PYTHON LAUNCHER")
    print("=" * 60)
    
    llm_dir = Path(__file__).parent
    log(f"LLM Directory: {llm_dir}")
    
    # Step 1: Check if venv exists
    log("\nStep 1: Checking virtual environment...")
    venv_python = find_venv_python()
    
    if not venv_python:
        log("✗ Virtual environment not found")
        log("Launching installer...")
        if launch_installer():
            log("Installer launched. Please complete setup and rerun launcher.")
            return 0
        else:
            log("ERROR: Could not launch installer!")
            _wait_for_user()
            return 1
    
    log(f"✓ Found venv: {venv_python}")
    
    # Step 2: Check venv health (PySide6, etc.)
    log("\nStep 2: Checking venv health...")
    if not check_venv_health(venv_python):
        log("✗ Virtual environment is broken")
        log("Launching installer to repair...")
        if launch_installer():
            log("Installer launched. Please complete repair and rerun launcher.")
            return 0
        else:
            log("ERROR: Could not launch installer!")
            _wait_for_user()
            return 1
    
    log("✓ Venv health check passed")

    # Step 2.5: Probe the torch stack BEFORE launching the app.
    # OWLLM runs INSIDE the workload venv, so any C-extension fault
    # (torchvision/_C.pyd ABI mismatch, missing libtorch DLL, etc.)
    # crashes the whole app the moment a tab loads it — with no Python
    # traceback. Catch it here so we route to safe mode instead.
    log("\nStep 2.5: Probing torch stack (subprocess; ~1s)...")
    torch_ok, torch_reason = check_torch_stack_health(venv_python)
    if not torch_ok:
        log("✗ Torch stack probe failed — workload venv is unsafe to launch into.")
        if launch_safe_mode_installer(torch_reason):
            log("Safe-mode installer launched. Repair the venv and rerun.")
            return 0
        else:
            log("ERROR: Could not launch safe-mode installer.")
            _wait_for_user()
            return 1
    log(f"✓ Torch stack OK: {torch_reason.splitlines()[0] if torch_reason else ''}")

    # Step 3: Check dependencies
    log("\nStep 3: Checking dependencies...")
    deps_ok = run_dependency_check(venv_python)

    if not deps_ok:
        log("✗ Dependencies check failed")
        log("Launching installer to repair...")
        if launch_installer():
            log("Installer launched. Please complete repair and rerun launcher.")
            return 0
        else:
            log("ERROR: Could not launch installer!")
            _wait_for_user()
            return 1

    # Step 4: Launch application
    log("\nStep 4: Launching application...")
    if launch_app(venv_python):
        log("\nApplication is running.")
        log("You can close this window.")
        return 0
    else:
        log("\nERROR: Application failed to launch")
        log("Try running installer to repair the installation.")
        input("Press Enter to exit...")
        return 1

if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n\nCancelled by user.")
        sys.exit(0)
    except Exception as e:
        print(f"\nLauncher error: {e}")
        import traceback
        traceback.print_exc()
        _wait_for_user("\nPress Enter to exit...")
        sys.exit(1)
