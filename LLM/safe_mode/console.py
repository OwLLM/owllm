"""Console fallback for safe-mode repair.

Stdlib-only. Used when PySide6 isn't installed in the interpreter
that's hosting safe-mode (which today is the bundled embeddable
``python_runtime``, where Qt isn't shipped).

Identical role to the legacy ``safe_mode_repair.py`` at the LLM root
— but routed through the unified ``EnvRepairer`` foundation so the
console flow gets the same diff/install/verify the eventual Qt window
will use. One bug fix benefits both UIs.
"""
from __future__ import annotations

import sys
import traceback
from pathlib import Path


def _hr(char: str = "=", width: int = 70) -> None:
    print(char * width, flush=True)


def _banner() -> None:
    _hr()
    print("  OWLLM SAFE MODE — RUNTIME REPAIR (console)")
    print("  (running from bundled Python; the workload venv is quarantined)")
    _hr()
    print(f"  Python:   {sys.version.split()[0]} at {sys.executable}")
    print(f"  Repo:     {Path(__file__).resolve().parents[2]}")
    print(flush=True)


def _press_enter_to_exit(rc: int) -> None:
    print(flush=True)
    _hr("-")
    if rc == 0:
        print("  Repair completed successfully.")
        print("  Close this window and re-launch OWLLM (double-click START.bat).")
    else:
        print(f"  Repair did NOT complete cleanly (exit code {rc}).")
        print("  Read the lines above for the actual pip/installer error.")
        print("  Detailed pip logs:")
        print("    LLM\\logs\\pip\\")
    _hr("-")
    try:
        input("  Press Enter to close…")
    except (EOFError, KeyboardInterrupt):
        pass


def run_console(project_root: Path) -> int:
    """Run the unified EnvRepairer in a console session."""
    _banner()
    here = Path(__file__).resolve().parent.parent  # .../LLM
    if str(here) not in sys.path:
        sys.path.insert(0, str(here))

    # Resolve which env to repair — the same way LAUNCHER.py does.
    try:
        from core.runtime.owllm_python import get_owllm_env
        from core.install import resolve_profile_id
        env = get_owllm_env(here)
        env_python = env.python_exe
        env_id = resolve_profile_id(env.env_key, project_root=here)
    except Exception as exc:
        print(f"[FATAL] could not resolve OWLLM env: {exc}")
        traceback.print_exc()
        _press_enter_to_exit(2)
        return 2

    print(f"  Workload venv: {env_python}")
    print(f"  Profile id:    {env_id}")
    print(flush=True)

    try:
        from core.install import EnvRepairer, RepairOutcome
    except Exception as exc:
        print(f"[FATAL] could not import EnvRepairer: {exc}")
        traceback.print_exc()
        _press_enter_to_exit(3)
        return 3

    print("Running EnvRepairer.repair() …")
    print(flush=True)
    try:
        repairer = EnvRepairer(project_root=here)
        result = repairer.repair(
            env_python=env_python,
            env_id=env_id,
            extras=["training"],
            log=lambda line: print(line, flush=True),
        )
    except KeyboardInterrupt:
        print("\n[INTERRUPTED] User cancelled with Ctrl+C.")
        _press_enter_to_exit(130)
        return 130
    except Exception as exc:
        print(f"\n[FATAL] EnvRepairer.repair() raised: {type(exc).__name__}: {exc}")
        traceback.print_exc()
        _press_enter_to_exit(4)
        return 4

    print(flush=True)
    _hr("-")
    print(f"Outcome: {result.outcome.value}")
    print(f"Summary: {result.summary}")
    if result.log_paths:
        print("Pip logs:")
        for p in result.log_paths:
            print(f"  {p}")
    rc = 0 if result.ok else 1
    _press_enter_to_exit(rc)
    return rc


if __name__ == "__main__":
    sys.exit(run_console(Path(__file__).resolve().parents[1]))
