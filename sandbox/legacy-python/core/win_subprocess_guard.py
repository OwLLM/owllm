"""
Windows-only subprocess boundary guard.

Root-cause fix for "CMD window flashes on top of the GUI" issue.

Rationale
---------
The desktop app launches with ``pythonw.exe`` (no console). Any console
child process it spawns (directly or indirectly, via pip / huggingface_hub /
transformers / torch / etc.) will, by default, allocate its own visible
console on Windows. The fix is to pass ``CREATE_NO_WINDOW`` + hidden
``STARTUPINFO`` to every child-process spawn.

There are FOUR different Python-visible entry points that spawn processes
on Windows, each of which needs to be patched independently because they
do not share a common code path:

  1. ``subprocess.Popen.__init__``   - covers ``subprocess.run``, ``.call``,
     ``.check_call``, ``.check_output``, and everything built on top of
     ``subprocess``.
  2. ``_winapi.CreateProcess``       - the low-level Win32 wrapper that
     ``subprocess`` and ``multiprocessing`` call on Windows. Patching here
     is a safety net for libraries that bypass ``subprocess.Popen``.
  3. ``os.system`` / ``os.popen``    - these route through the C runtime's
     ``system()``/``_popen()``, which spawn ``cmd.exe`` with a visible
     console on Windows.
  4. ``PySide6.QtCore.QProcess``     - Qt's own process API. Does not go
     through ``subprocess``; uses Win32 ``CreateProcess`` directly. We
     install a global ``setCreateProcessArgumentsModifier`` on every
     ``QProcess`` instance via ``__init__`` patching.

All patches are:
  * Idempotent (installing twice is a no-op).
  * Respect explicit opt-out (``CREATE_NEW_CONSOLE``).
  * Wrapped in broad except blocks so they cannot break a spawn.
  * No-op on non-Windows platforms.

Optional diagnostic trace
-------------------------
If the environment variable ``LOCALLLM_SPAWN_TRACE`` is set to a file path
(or ``1`` to use a default), every intercepted spawn is appended to that
file with the executable, args, and the creation flags that were applied.
This is the instrumentation you want when a flash still appears after the
guard is active: it tells you which spawn path produced it.
"""
from __future__ import annotations

import os
import sys
import time
from typing import Any, Optional

__all__ = [
    "install_windows_subprocess_guard",
    "is_installed",
    "auto_install_from_env",
    "install_guard_into_venv",
    "sweep_install_guard_into_envs",
]

_INSTALLED_ATTR = "_localllm_no_window_guard_installed"
_TRACE_PATH: Optional[str] = None


def _resolve_trace_path() -> Optional[str]:
    value = os.environ.get("LOCALLLM_SPAWN_TRACE", "").strip()
    if not value:
        return None
    if value == "1":
        base = os.path.expanduser("~")
        return os.path.join(base, "localllm_spawn_trace.log")
    return value


def _trace(source: str, detail: str) -> None:
    global _TRACE_PATH
    if _TRACE_PATH is None:
        return
    try:
        with open(_TRACE_PATH, "a", encoding="utf-8", errors="replace") as fh:
            fh.write(f"[{time.strftime('%H:%M:%S')}][pid={os.getpid()}][{source}] {detail}\n")
    except Exception:
        pass


def is_installed() -> bool:
    """Return True if the guard is already active in this process."""
    import subprocess
    return bool(getattr(subprocess.Popen, _INSTALLED_ATTR, False))


def _patch_subprocess_popen() -> bool:
    import subprocess

    if getattr(subprocess.Popen, _INSTALLED_ATTR, False):
        return True

    CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    CREATE_NEW_CONSOLE = getattr(subprocess, "CREATE_NEW_CONSOLE", 0x00000010)
    STARTF_USESHOWWINDOW = getattr(subprocess, "STARTF_USESHOWWINDOW", 0x00000001)
    SW_HIDE = getattr(subprocess, "SW_HIDE", 0)

    _original_init = subprocess.Popen.__init__

    def _patched_init(self, *args: Any, **kwargs: Any) -> None:  # type: ignore[no-untyped-def]
        try:
            creationflags = int(kwargs.get("creationflags", 0) or 0)
            if not (creationflags & CREATE_NEW_CONSOLE):
                kwargs["creationflags"] = creationflags | CREATE_NO_WINDOW
                si = kwargs.get("startupinfo")
                if si is None:
                    si = subprocess.STARTUPINFO()
                    si.dwFlags |= STARTF_USESHOWWINDOW
                    si.wShowWindow = SW_HIDE
                    kwargs["startupinfo"] = si
                else:
                    try:
                        if not (int(getattr(si, "dwFlags", 0)) & STARTF_USESHOWWINDOW):
                            si.dwFlags = int(getattr(si, "dwFlags", 0)) | STARTF_USESHOWWINDOW
                            si.wShowWindow = SW_HIDE
                    except Exception:
                        pass
            if _TRACE_PATH:
                try:
                    first = args[0] if args else kwargs.get("args")
                    _trace("subprocess.Popen", f"args={first!r} shell={kwargs.get('shell', False)} cf={hex(int(kwargs.get('creationflags', 0) or 0))}")
                except Exception:
                    pass
        except Exception:
            pass
        return _original_init(self, *args, **kwargs)

    _patched_init._localllm_original = _original_init  # type: ignore[attr-defined]
    subprocess.Popen.__init__ = _patched_init  # type: ignore[method-assign]
    setattr(subprocess.Popen, _INSTALLED_ATTR, True)
    return True


def _patch_winapi_create_process() -> bool:
    """Hook ``_winapi.CreateProcess`` as a belt-and-suspenders.

    ``subprocess.Popen`` on Windows ultimately calls this. Patching it here
    catches anything that bypasses ``subprocess.Popen`` but still uses
    ``_winapi`` (e.g. ``multiprocessing`` on the ``spawn`` start method, and
    some rare third-party libraries).
    """
    try:
        import _winapi  # type: ignore[import-not-found]
    except ImportError:
        return False
    if getattr(_winapi, "_localllm_no_window_guard_installed", False):
        return True

    CREATE_NO_WINDOW = 0x08000000
    CREATE_NEW_CONSOLE = 0x00000010

    _original_cp = _winapi.CreateProcess

    def _patched_cp(
        application_name,
        command_line,
        proc_attrs,
        thread_attrs,
        inherit_handles,
        creation_flags,
        env_mapping,
        current_directory,
        startup_info,
    ):
        try:
            flags = int(creation_flags or 0)
            if not (flags & CREATE_NEW_CONSOLE):
                flags |= CREATE_NO_WINDOW
                creation_flags = flags
            if _TRACE_PATH:
                _trace(
                    "_winapi.CreateProcess",
                    f"app={application_name!r} cmd={command_line!r} cf={hex(flags)}",
                )
        except Exception:
            pass
        return _original_cp(
            application_name,
            command_line,
            proc_attrs,
            thread_attrs,
            inherit_handles,
            creation_flags,
            env_mapping,
            current_directory,
            startup_info,
        )

    try:
        _winapi.CreateProcess = _patched_cp  # type: ignore[assignment]
        setattr(_winapi, "_localllm_no_window_guard_installed", True)
        return True
    except Exception:
        return False


def _patch_os_system_popen() -> bool:
    """Redirect ``os.system`` and ``os.popen`` through ``subprocess`` so the
    Popen patch applies.

    ``os.system()`` on Windows spawns ``cmd.exe`` via the C runtime's
    ``system()`` which always creates a visible console. ``os.popen()``
    has the same issue. We route them through ``subprocess`` instead.
    """
    import subprocess as _sp

    if getattr(os, "_localllm_syspopen_patched", False):
        return True

    _original_system = os.system
    _original_popen = os.popen

    def _patched_system(command):  # type: ignore[no-untyped-def]
        if _TRACE_PATH:
            _trace("os.system", repr(command))
        try:
            return _sp.call(command, shell=True)
        except Exception:
            return _original_system(command)

    def _patched_popen(command, mode="r", buffering=-1):  # type: ignore[no-untyped-def]
        if _TRACE_PATH:
            _trace("os.popen", repr(command))
        try:
            if "w" in mode:
                proc = _sp.Popen(
                    command, shell=True, stdin=_sp.PIPE, bufsize=buffering,
                    text=True, encoding="utf-8", errors="replace",
                )
                return proc.stdin
            else:
                proc = _sp.Popen(
                    command, shell=True, stdout=_sp.PIPE, bufsize=buffering,
                    text=True, encoding="utf-8", errors="replace",
                )
                return proc.stdout
        except Exception:
            return _original_popen(command, mode, buffering)

    try:
        os.system = _patched_system  # type: ignore[assignment]
        os.popen = _patched_popen  # type: ignore[assignment]
        setattr(os, "_localllm_syspopen_patched", True)
        return True
    except Exception:
        return False


def _swap_python_exe_to_pythonw(program: str) -> str:
    """Delegate to :func:`core.python_exe_swap.swap_console_python_to_pythonw`."""
    try:
        from core.python_exe_swap import swap_console_python_to_pythonw

        return swap_console_python_to_pythonw(program)
    except Exception:
        return program


def _patch_qprocess() -> bool:
    """Install a Windows-no-window guard on every ``QProcess``.

    Two mechanisms are applied (each independently, whichever is supported):

    1. If ``QProcess.setCreateProcessArgumentsModifier`` is available
       (newer PySide6 builds), every new QProcess gets a modifier that
       forces ``CREATE_NO_WINDOW`` + hidden ``STARTUPINFO``.
    2. Always: ``QProcess.setProgram`` and ``QProcess.start`` are patched
       to transparently swap ``python.exe`` → ``pythonw.exe``. This is the
       only portable fallback on PySide6 6.8.1 (the version bundled with
       LocaLLM), which does not expose the modifier API at all.

    Patching ``QProcess.__init__`` on its own is insufficient on PySide6
    6.8.1 because the modifier API is missing; the program-swap covers
    that gap for every Python-script QProcess, including those that do
    not call ``apply_create_no_window``.
    """
    try:
        from PySide6.QtCore import QProcess  # type: ignore[import-not-found]
    except Exception:
        return False
    if getattr(QProcess, "_localllm_no_window_guard_installed", False):
        return True

    import subprocess as _sp
    CREATE_NO_WINDOW = getattr(_sp, "CREATE_NO_WINDOW", 0x08000000)
    CREATE_NEW_CONSOLE = getattr(_sp, "CREATE_NEW_CONSOLE", 0x00000010)
    STARTF_USESHOWWINDOW = getattr(_sp, "STARTF_USESHOWWINDOW", 0x00000001)
    SW_HIDE = getattr(_sp, "SW_HIDE", 0)

    modifier_installed = False
    if hasattr(QProcess, "setCreateProcessArgumentsModifier"):
        def _modifier(args):  # pragma: no cover - runs in Qt event loop
            try:
                existing = int(getattr(args, "flags", 0) or 0)
                new_flags = existing
                if not (existing & CREATE_NEW_CONSOLE):
                    new_flags = existing | CREATE_NO_WINDOW
                    if hasattr(args, "flags"):
                        args.flags = new_flags
                    if hasattr(args, "dwCreationFlags"):
                        args.dwCreationFlags = new_flags
                si = getattr(args, "startupInfo", None)
                if si is not None:
                    try:
                        si.dwFlags = int(getattr(si, "dwFlags", 0)) | STARTF_USESHOWWINDOW
                        si.wShowWindow = SW_HIDE
                    except Exception:
                        pass
                if _TRACE_PATH:
                    try:
                        prog = getattr(args, "applicationName", "") or getattr(args, "arguments", "")
                        _trace("QProcess.modifier", f"program={prog!r} cf={hex(new_flags)}")
                    except Exception:
                        pass
            except Exception:
                pass

        _original_init = QProcess.__init__

        def _patched_init(self, *args: Any, **kwargs: Any) -> None:  # type: ignore[no-untyped-def]
            _original_init(self, *args, **kwargs)
            try:
                self.setCreateProcessArgumentsModifier(_modifier)
            except Exception:
                pass

        try:
            QProcess.__init__ = _patched_init  # type: ignore[method-assign]
            modifier_installed = True
        except Exception:
            modifier_installed = False
    else:
        _trace(
            "QProcess",
            "setCreateProcessArgumentsModifier unavailable; using pythonw.exe swap fallback.",
        )

    # Program-swap patch: applies on EVERY PySide6 version.
    try:
        _original_set_program = QProcess.setProgram
        _original_start = QProcess.start

        def _patched_set_program(self, program):  # type: ignore[no-untyped-def]
            try:
                swapped = _swap_python_exe_to_pythonw(str(program))
                if swapped != program and _TRACE_PATH:
                    _trace("QProcess.setProgram.swap", f"{program!r} -> {swapped!r}")
                return _original_set_program(self, swapped)
            except Exception:
                return _original_set_program(self, program)

        def _patched_start(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            try:
                if args and isinstance(args[0], str):
                    swapped = _swap_python_exe_to_pythonw(args[0])
                    if swapped != args[0]:
                        if _TRACE_PATH:
                            _trace("QProcess.start.swap", f"{args[0]!r} -> {swapped!r}")
                        args = (swapped,) + args[1:]
                elif not args:
                    try:
                        current = self.program()
                    except Exception:
                        current = ""
                    swapped = _swap_python_exe_to_pythonw(current)
                    if swapped and swapped != current:
                        if _TRACE_PATH:
                            _trace("QProcess.start.swap(program)", f"{current!r} -> {swapped!r}")
                        try:
                            _original_set_program(self, swapped)
                        except Exception:
                            pass
            except Exception:
                pass
            return _original_start(self, *args, **kwargs)

        QProcess.setProgram = _patched_set_program  # type: ignore[method-assign]
        QProcess.start = _patched_start  # type: ignore[method-assign]
    except Exception as exc:
        _trace("QProcess.swap_patch", f"failed: {exc!r}")

    setattr(QProcess, "_localllm_no_window_guard_installed", True)
    return True or modifier_installed


def install_windows_subprocess_guard() -> bool:
    """
    Install the Windows subprocess no-window guard on all spawn paths:
    ``subprocess.Popen``, ``_winapi.CreateProcess``, ``os.system``,
    ``os.popen``, and ``QProcess`` (if PySide6 is already importable).

    Safe to call from any entry point. Idempotent. No-op on non-Windows.

    Returns True if Windows and at least ``subprocess.Popen`` was patched.
    """
    if sys.platform != "win32":
        return False

    global _TRACE_PATH
    _TRACE_PATH = _resolve_trace_path()
    if _TRACE_PATH:
        try:
            with open(_TRACE_PATH, "a", encoding="utf-8") as fh:
                fh.write(f"\n=== spawn trace started pid={os.getpid()} argv={sys.argv!r} ===\n")
        except Exception:
            pass

    ok_popen = False
    try:
        ok_popen = _patch_subprocess_popen()
    except Exception as exc:
        print(f"[win_subprocess_guard] subprocess.Popen patch failed: {exc!r}", file=sys.stderr)

    try:
        _patch_winapi_create_process()
    except Exception as exc:
        print(f"[win_subprocess_guard] _winapi.CreateProcess patch failed: {exc!r}", file=sys.stderr)

    try:
        _patch_os_system_popen()
    except Exception as exc:
        print(f"[win_subprocess_guard] os.system/popen patch failed: {exc!r}", file=sys.stderr)

    try:
        _patch_qprocess()
    except Exception as exc:
        print(f"[win_subprocess_guard] QProcess patch failed: {exc!r}", file=sys.stderr)

    # Propagate to child Python processes: ensure LLM root is on PYTHONPATH
    # so Python finds ``sitecustomize.py`` at interpreter startup and auto-
    # installs the guard there too. Without this, pip/uvicorn child Pythons
    # would spawn their own grandchildren (compilers, nvidia-smi, git, etc.)
    # with visible consoles.
    try:
        _llm_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        current = os.environ.get("PYTHONPATH", "")
        parts = [p for p in current.split(os.pathsep) if p]
        if _llm_root not in parts:
            parts.insert(0, _llm_root)
            os.environ["PYTHONPATH"] = os.pathsep.join(parts)
    except Exception as exc:
        print(f"[win_subprocess_guard] Could not set PYTHONPATH: {exc!r}", file=sys.stderr)

    os.environ.setdefault("LOCALLLM_WIN_NOWINDOW_GUARD", "1")

    # Propagate the guard into every pre-existing per-model venv. This is the
    # root-cause fix for the "isolate / onboarding / probe flashes" bug: those
    # flows launch python.exe from LLM/.envs/<env>/.venv, and that python must
    # auto-install the guard at startup to prevent its own subprocess children
    # from allocating visible consoles. A missing guard in those venvs was the
    # reason restarts and isolate clicks still flashed after the main-venv .pth
    # fix landed. Failure is ignored; the guard in the current process still
    # applies to anything spawned from here with CREATE_NO_WINDOW.
    try:
        sweep_install_guard_into_envs()
    except Exception as exc:
        _trace("install_windows_subprocess_guard", f"envs sweep failed: {exc!r}")

    return ok_popen


def auto_install_from_env() -> bool:
    """Install the guard if ``LOCALLLM_WIN_NOWINDOW_GUARD=1`` is set."""
    if os.environ.get("LOCALLLM_WIN_NOWINDOW_GUARD") == "1":
        return install_windows_subprocess_guard()
    return False


def reinstall_after_qt_import() -> bool:
    """Call this AFTER PySide6 has been imported if the guard was installed
    before Qt was loaded. The ``QProcess`` patch requires Qt to be importable
    and therefore has to be retried.
    """
    if sys.platform != "win32":
        return False
    try:
        return _patch_qprocess()
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Guard propagation into per-model venvs
#
# Root-cause fix for "isolate button flashes" and "per-env spawn flashes":
# every ``LLM/.envs/<env_key>/.venv`` has its own ``site-packages`` tree, and
# Python only auto-imports ``.pth`` / ``sitecustomize`` modules that live on
# that venv's ``sys.path``. The main venv's ``localllm_guard.pth`` is not
# visible from a per-model venv's python.exe, so spawns from per-model venvs
# bypass the guard. The helpers below drop a tiny bootstrap pair into any
# venv's site-packages so its python.exe auto-installs the guard at startup,
# exactly like the main venv does.
# ---------------------------------------------------------------------------

# Kept in sync with LLM/.venv/Lib/site-packages/localllm_guard_boot.py.
# Duplicated here because installing into an arbitrary venv cannot assume the
# main venv's copy exists on disk.
_GUARD_PTH_NAME = "localllm_guard.pth"
_GUARD_BOOT_MODULE_NAME = "localllm_guard_boot.py"
_GUARD_PTH_CONTENTS = "import localllm_guard_boot\n"
_GUARD_BOOT_TEMPLATE = '''"""Auto-generated by core.win_subprocess_guard.install_guard_into_venv.

Bootstrap module loaded by ``localllm_guard.pth`` at Python startup. Its sole
job is to locate the LLM repository root and install the Windows subprocess
guard so every process spawned from THIS venv is console-free.

Do not edit by hand; regenerate via ``install_guard_into_venv(venv_path)``.
"""
from __future__ import annotations
import os
import sys


def _boot() -> None:
    if sys.platform != "win32":
        return
    if os.environ.get("LOCALLLM_DISABLE_NOWINDOW_GUARD") == "1":
        return
    try:
        llm_root = {llm_root_literal!r}
        if not os.path.isdir(os.path.join(llm_root, "core")):
            return
        if llm_root not in sys.path:
            sys.path.insert(0, llm_root)
    except Exception:
        return
    trace_val = os.environ.get("LOCALLLM_SPAWN_TRACE", "").strip()
    if trace_val == "":
        os.environ["LOCALLLM_SPAWN_TRACE"] = "1"
    try:
        from core.win_subprocess_guard import install_windows_subprocess_guard
        install_windows_subprocess_guard()
    except Exception:
        return


_boot()
'''


def _resolve_llm_root() -> Optional[str]:
    """Return the absolute path of the LLM repo root (parent of ``core/``)."""
    try:
        # This module lives at LLM/core/win_subprocess_guard.py
        here = os.path.abspath(__file__)
        return os.path.dirname(os.path.dirname(here))
    except Exception:
        return None


def _venv_site_packages(venv_path: str) -> Optional[str]:
    """Return the site-packages directory of a given venv, or None.

    Tries the Windows layout (``<venv>/Lib/site-packages``) first, then a
    POSIX-style fallback (``<venv>/lib/python*/site-packages``) so the helper
    is reusable if/when non-Windows venvs need similar bootstrap.
    """
    try:
        win_path = os.path.join(venv_path, "Lib", "site-packages")
        if os.path.isdir(win_path):
            return win_path
    except Exception:
        pass
    try:
        lib_dir = os.path.join(venv_path, "lib")
        if os.path.isdir(lib_dir):
            for entry in os.listdir(lib_dir):
                if entry.startswith("python"):
                    candidate = os.path.join(lib_dir, entry, "site-packages")
                    if os.path.isdir(candidate):
                        return candidate
    except Exception:
        pass
    return None


def install_guard_into_venv(venv_path: str, *, llm_root: Optional[str] = None) -> bool:
    """Install the subprocess-guard bootstrap into a venv's site-packages.

    Creates two tiny files in ``<venv>/Lib/site-packages/``:
      * ``localllm_guard.pth`` - triggers import at interpreter startup.
      * ``localllm_guard_boot.py`` - adds LLM root to sys.path and installs
        the guard via ``core.win_subprocess_guard``.

    Idempotent: if both files already exist with the expected content the
    function is a no-op and returns True. Any I/O failure is swallowed and
    returns False so callers never break venv creation because of the guard.

    ``llm_root`` can override auto-detection (useful for tests / tools that
    install the guard into a venv from outside the repo).
    """
    if sys.platform != "win32":
        return False
    try:
        site_packages = _venv_site_packages(venv_path)
        if not site_packages:
            return False
        root = llm_root or _resolve_llm_root()
        if not root or not os.path.isdir(os.path.join(root, "core")):
            return False

        pth_path = os.path.join(site_packages, _GUARD_PTH_NAME)
        boot_path = os.path.join(site_packages, _GUARD_BOOT_MODULE_NAME)
        boot_contents = _GUARD_BOOT_TEMPLATE.format(llm_root_literal=root)

        def _write_if_changed(path: str, contents: str) -> None:
            try:
                existing = ""
                if os.path.isfile(path):
                    with open(path, "r", encoding="utf-8") as fh:
                        existing = fh.read()
                if existing == contents:
                    return
            except Exception:
                pass
            with open(path, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(contents)

        _write_if_changed(pth_path, _GUARD_PTH_CONTENTS)
        _write_if_changed(boot_path, boot_contents)
        return True
    except Exception as exc:
        _trace("install_guard_into_venv", f"failed for {venv_path!r}: {exc!r}")
        return False


def sweep_install_guard_into_envs(envs_dir: Optional[str] = None) -> int:
    """Install the guard into every ``<envs_dir>/*/.venv`` found on disk.

    Returns the number of venvs that had the guard (re)written. Used on main
    app startup so that pre-existing per-model environments never produce
    console flashes, even if they were created before the guard existed.
    """
    if sys.platform != "win32":
        return 0
    if envs_dir is None:
        root = _resolve_llm_root()
        if not root:
            return 0
        envs_dir = os.path.join(root, ".envs")
    if not os.path.isdir(envs_dir):
        return 0

    count = 0
    try:
        for entry in os.listdir(envs_dir):
            venv_path = os.path.join(envs_dir, entry, ".venv")
            if os.path.isdir(venv_path):
                if install_guard_into_venv(venv_path):
                    count += 1
    except Exception as exc:
        _trace("sweep_install_guard_into_envs", f"failed: {exc!r}")
    return count
