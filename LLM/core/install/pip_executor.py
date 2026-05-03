"""Single pip runner for the entire OWLLM codebase.

Why this exists
---------------
Before this module, OWLLM had at least three separate pip-runners:

  * ``core/wheelhouse.py::_download_wheel``  — used by the installer's
    Repair All path. Buffered stderr through a regex progress parser
    that discarded everything that didn't look like a percentage line.
    When pip failed the user saw 'Failed to download X: '  with NOTHING
    after the colon. We chased phantom version pins for hours because
    the actual error was never captured.

  * ``core/envs/env_registry.py::auto_install_missing_packages`` — used
    by Environments page repair, model onboarding, server preflight.
    Captured stderr correctly, persisted to logs/pip_install/, but
    the pip-cmd construction (--no-index? --extra-index-url? wheelhouse
    find-links?) was different from every other caller, so the same
    package could install in one path and 404 in another.

  * ``desktop_app/training_env_manager.py::_pip_install`` — used by the
    Train tab preflight. Truncated stderr to 600 chars, used yet
    another set of pip args, no log persistence at all.

  * ``core/immutable_installer.py::_install_packages`` and
    ``_run_pip_streaming`` — yet another set, yet another error path.

Result of the fragmentation: every fix had to be ported to N places,
some places were never updated, and any new entry point started
copy-pasting from whichever existing runner happened to be nearby.
That's why the same class of bug ('pip failed silently', 'phantom
version', 'wrong index URL') kept showing up under different banners.

Design contract
---------------
This is the ONLY pip runner. Every install/repair/uninstall/freeze
in OWLLM goes through it. The contract:

  * Streams stdout+stderr line-by-line to an optional callback so the
    UI sees progress in real time. The previous bug class ('Phase 2.5
    looks frozen for 10 minutes') is structurally impossible here
    because pip's output isn't buffered.

  * Persists the FULL pip output (not a tail, not a regex slice) to
    ``LLM/logs/pip/<timestamp>_<pid>_<label>.log`` for every
    invocation, success or failure. Post-mortem debugging stops being
    a guessing game.

  * Returns a structured ``PipResult`` with returncode, full stdout,
    full stderr, log path, and a one-line ``summary`` so callers can
    decide whether to show the user the error verbatim or a friendlier
    paraphrase.

  * Mode enum (``PipMode``) replaces the scattered '--no-index +
    --find-links' / '--extra-index-url cu121' / 'plain PyPI' decisions
    with one explicit choice per call. No more 'I forgot the
    --extra-index-url and so my install just silently fell back to
    PyPI which didn't have the cu121 wheel'.

  * Honest timeout enforcement INSIDE the read loop. ``subprocess.run``'s
    timeout doesn't fire while Windows pip is mid-download.

  * Never raises for a failed install. Returns a ``PipResult`` with
    ``returncode != 0``. Raising is reserved for setup errors (missing
    venv interpreter, can't write log dir).
"""
from __future__ import annotations

import collections
import os
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Callable, List, Optional, Sequence


LogCallback = Callable[[str], None]


PYTORCH_CU121_INDEX = "https://download.pytorch.org/whl/cu121"
PYTORCH_CU124_INDEX = "https://download.pytorch.org/whl/cu124"
PYTORCH_CPU_INDEX = "https://download.pytorch.org/whl/cpu"


class PipMode(str, Enum):
    """How pip should resolve packages.

    Every install/uninstall/freeze in OWLLM picks ONE of these. No
    callers should ever build their own ``--index-url`` /
    ``--find-links`` / ``--no-index`` flag soup.
    """

    # Wheelhouse-only, offline. --no-index --find-links <wheelhouse>.
    # Used by the bundled installer for the deterministic 'first
    # install' path. Fast, reproducible, no network.
    WHEELHOUSE_ONLY = "wheelhouse_only"

    # Wheelhouse first, PyPI fallback. --find-links <wheelhouse> with
    # PyPI as the default index. Used when the wheelhouse may have
    # the wheel but is allowed to miss it.
    WHEELHOUSE_THEN_PYPI = "wheelhouse_then_pypi"

    # Plain PyPI. Used by self-heal / repair when the wheelhouse is
    # known to be incomplete or pinned to the wrong Python tag.
    PYPI = "pypi"

    # PyPI + PyTorch CUDA 12.1 wheel index.  --extra-index-url cu121.
    # MANDATORY for torch / torchvision / torchaudio cu121 builds —
    # those wheels live ONLY on download.pytorch.org, not on PyPI.
    PYPI_PLUS_CU121 = "pypi_plus_cu121"

    PYPI_PLUS_CU124 = "pypi_plus_cu124"

    # Force CPU-only torch index. Used by CI / non-CUDA hardware.
    PYTORCH_CPU = "pytorch_cpu"


class PipExecutorError(RuntimeError):
    """Setup-level errors only (missing interpreter, can't write log dir).

    A failed *install* is NOT this — that's a ``PipResult`` with a non-
    zero returncode. Reserve raising for cases where we couldn't even
    spawn pip.
    """


@dataclass
class PipResult:
    """Structured outcome of one PipExecutor call."""

    returncode: int
    stdout: str
    stderr: str
    log_path: Path
    cmd: List[str]
    duration_s: float
    summary: str

    @property
    def ok(self) -> bool:
        return self.returncode == 0

    @property
    def short_error(self) -> str:
        """The most-useful 5 KB of error text for showing to humans."""
        if self.ok:
            return ""
        # Prefer stderr (where pip puts errors) but fall back to stdout
        # when stderr is empty (some Windows pip configs merge them).
        body = (self.stderr or self.stdout or "").strip()
        if not body:
            return f"pip exited {self.returncode} with no captured output. See {self.log_path}"
        return body[-5000:]


class PipExecutor:
    """Drive pip for an OWLLM environment.

    Construct once per (project_root, log_dir); call its methods many
    times. Thread-safe at the level of separate ``PipExecutor`` instances;
    not thread-safe within one instance because pip itself isn't
    parallelism-friendly.

    Example::

        ex = PipExecutor(project_root=Path('LLM'))
        result = ex.install(
            env_python=Path('LLM/.envs/main/.venv/Scripts/python.exe'),
            specs=['transformers>=4.51.0,<4.60.0'],
            mode=PipMode.PYPI,
            log=lambda line: print(line),
        )
        if not result.ok:
            ui.show_error(result.short_error, log_path=result.log_path)
    """

    def __init__(
        self,
        project_root: Path,
        *,
        log_dir: Optional[Path] = None,
        wheelhouse_dir: Optional[Path] = None,
    ) -> None:
        self.project_root = Path(project_root).resolve()
        self.log_dir = Path(log_dir) if log_dir else (self.project_root / "logs" / "pip")
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.wheelhouse_dir = (
            Path(wheelhouse_dir) if wheelhouse_dir else (self.project_root / "wheelhouse")
        )
        # Match the rest of the codebase: hide the console window on
        # Windows so child pip doesn't flash a black box at the user.
        self._creationflags = 0x08000000 if sys.platform == "win32" else 0

    # -----------------------------------------------------------------
    # Public API
    # -----------------------------------------------------------------
    def install(
        self,
        env_python: Path,
        specs: Sequence[str],
        *,
        mode: PipMode = PipMode.PYPI,
        force_reinstall: bool = False,
        no_deps: bool = False,
        upgrade: bool = False,
        timeout_s: int = 1800,
        log: Optional[LogCallback] = None,
        label: Optional[str] = None,
    ) -> PipResult:
        """Install one or more packages into ``env_python``'s environment.

        Failure modes return a ``PipResult`` with ``returncode != 0`` and
        full stderr captured. Setup failures (missing interpreter, can't
        spawn pip) raise ``PipExecutorError``.
        """
        self._verify_interpreter(env_python)
        if not specs:
            raise PipExecutorError("install() called with empty specs list")

        cmd = self._build_pip_cmd(env_python, "install", mode)
        if force_reinstall:
            cmd.append("--force-reinstall")
        if no_deps:
            cmd.append("--no-deps")
        if upgrade:
            cmd.append("--upgrade")
        cmd.extend(specs)

        return self._run(cmd, timeout_s=timeout_s, log=log, label=label or "install")

    def uninstall(
        self,
        env_python: Path,
        packages: Sequence[str],
        *,
        timeout_s: int = 600,
        log: Optional[LogCallback] = None,
    ) -> PipResult:
        """Uninstall one or more packages. ``-y`` is always passed."""
        self._verify_interpreter(env_python)
        if not packages:
            raise PipExecutorError("uninstall() called with empty packages list")
        cmd = [str(env_python), "-m", "pip", "uninstall", "-y", *packages]
        return self._run(cmd, timeout_s=timeout_s, log=log, label="uninstall")

    def freeze(
        self,
        env_python: Path,
        *,
        timeout_s: int = 60,
    ) -> dict[str, str]:
        """Return ``{normalized_name: version}`` for the venv's installed pkgs.

        Uses ``pip freeze --all --local`` so we only report what's
        actually in the venv (not parent / system packages). Robust
        against editable installs (``-e``), URL specifiers, and
        comment lines.
        """
        self._verify_interpreter(env_python)
        cmd = [str(env_python), "-m", "pip", "freeze", "--all", "--local"]
        result = self._run(cmd, timeout_s=timeout_s, label="freeze")
        installed: dict[str, str] = {}
        for raw in (result.stdout or "").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or line.startswith("-e "):
                continue
            if "==" not in line:
                continue
            name, _, ver = line.partition("==")
            installed[_normalize_pkg_name(name)] = ver.strip()
        return installed

    # -----------------------------------------------------------------
    # Internals
    # -----------------------------------------------------------------
    def _build_pip_cmd(
        self,
        env_python: Path,
        verb: str,
        mode: PipMode,
    ) -> List[str]:
        """Construct ``[python, -m, pip, <verb>, --<index args for mode>...]``.

        Centralising this is the whole point of PipMode — no caller
        builds index flags on its own. Keep this function small and
        explicit so a glance at PipMode is enough to know what pip will
        actually be invoked with.
        """
        cmd = [
            str(env_python), "-m", "pip", verb,
            "--no-cache-dir",
            "--no-warn-script-location",
            # 'off' instead of the legacy 'ascii' choice (pip 24+ removed
            # 'ascii' — every wheelhouse install was failing on it before
            # 985e552 / 9a75b2b).
            "--progress-bar", "off",
            # We parse pip output ourselves — skip its color codes.
            "--no-color",
        ]
        if mode is PipMode.WHEELHOUSE_ONLY:
            cmd += ["--no-index", "--find-links", str(self.wheelhouse_dir)]
        elif mode is PipMode.WHEELHOUSE_THEN_PYPI:
            cmd += ["--find-links", str(self.wheelhouse_dir)]
        elif mode is PipMode.PYPI:
            pass  # default behaviour
        elif mode is PipMode.PYPI_PLUS_CU121:
            cmd += ["--extra-index-url", PYTORCH_CU121_INDEX]
        elif mode is PipMode.PYPI_PLUS_CU124:
            cmd += ["--extra-index-url", PYTORCH_CU124_INDEX]
        elif mode is PipMode.PYTORCH_CPU:
            cmd += ["--index-url", PYTORCH_CPU_INDEX]
        else:  # pragma: no cover — exhaustive enum
            raise PipExecutorError(f"unknown PipMode: {mode!r}")
        return cmd

    def _verify_interpreter(self, env_python: Path) -> None:
        env_python = Path(env_python)
        if not env_python.exists():
            raise PipExecutorError(
                f"venv interpreter does not exist: {env_python}"
            )

    def _open_log(self, label: str) -> Path:
        ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        # Short uuid suffix so simultaneous invocations from different
        # entry points don't collide.
        suffix = uuid.uuid4().hex[:6]
        safe = "".join(c if (c.isalnum() or c in "_-") else "_" for c in label)[:40]
        return self.log_dir / f"{ts}_{os.getpid()}_{safe}_{suffix}.log"

    def _run(
        self,
        cmd: List[str],
        *,
        timeout_s: int,
        log: Optional[LogCallback] = None,
        label: str = "pip",
    ) -> PipResult:
        """Spawn pip, stream output, persist log, return PipResult.

        This is THE one place pip is invoked from in the new world.
        """
        log_path = self._open_log(label)
        # Always announce the exact command so reproducing a failure is
        # a copy-paste away — both in the live log and in the file.
        header = f"$ {' '.join(self._quote(c) for c in cmd)}"
        if log:
            try:
                log(header)
            except Exception:
                pass

        # Write log header BEFORE spawning so we have something on disk
        # even if the spawn itself crashes (rare but happens on Windows
        # with weird PATH/anti-virus interactions).
        try:
            with log_path.open("w", encoding="utf-8", errors="replace") as fh:
                fh.write(f"# OWLLM pip log\n# label={label}\n# pid={os.getpid()}\n")
                fh.write(f"# started_utc={datetime.utcnow().isoformat()}Z\n")
                fh.write(f"{header}\n")
        except Exception as exc:
            raise PipExecutorError(f"could not open pip log {log_path}: {exc}")

        start = time.monotonic()
        stdout_lines: collections.deque[str] = collections.deque(maxlen=20000)
        stderr_lines: collections.deque[str] = collections.deque(maxlen=20000)

        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                creationflags=self._creationflags,
            )
        except Exception as exc:
            raise PipExecutorError(f"could not spawn pip: {exc}")

        # Drain both streams concurrently. We read each line-by-line and
        # tee to: (a) stdout_lines/stderr_lines for the PipResult, (b)
        # the log file on disk, (c) the optional UI callback. No
        # buffering on the way through.
        import threading

        def _drain(stream, sink: collections.deque[str], tag: str) -> None:
            try:
                for raw in stream:
                    line = raw.rstrip("\r\n")
                    if not line:
                        continue
                    sink.append(line)
                    try:
                        with log_path.open("a", encoding="utf-8", errors="replace") as fh:
                            fh.write(f"[{tag}] {line}\n")
                    except Exception:
                        pass
                    if log:
                        try:
                            log(f"[{tag}] {line}" if tag != "out" else line)
                        except Exception:
                            pass
            finally:
                try:
                    stream.close()
                except Exception:
                    pass

        t_out = threading.Thread(target=_drain, args=(proc.stdout, stdout_lines, "out"), daemon=True)
        t_err = threading.Thread(target=_drain, args=(proc.stderr, stderr_lines, "err"), daemon=True)
        t_out.start()
        t_err.start()

        timed_out = False
        while True:
            rc = proc.poll()
            if rc is not None:
                break
            if (time.monotonic() - start) > timeout_s:
                timed_out = True
                try:
                    proc.terminate()
                except Exception:
                    pass
                # Give pip a moment to flush before SIGKILL.
                try:
                    proc.wait(timeout=5)
                except Exception:
                    try:
                        proc.kill()
                    except Exception:
                        pass
                break
            time.sleep(0.05)

        rc = proc.wait()
        t_out.join(timeout=2)
        t_err.join(timeout=2)
        duration = time.monotonic() - start

        stdout_text = "\n".join(stdout_lines)
        stderr_text = "\n".join(stderr_lines)
        if timed_out:
            stderr_text = (
                stderr_text
                + f"\n[PipExecutor] command timed out after {timeout_s}s and was terminated."
            ).strip()

        # Append a trailer to the log so post-mortem reviewers can see
        # the outcome without re-deriving it.
        try:
            with log_path.open("a", encoding="utf-8", errors="replace") as fh:
                fh.write(f"\n# returncode={rc}\n# duration_s={duration:.1f}\n")
                if timed_out:
                    fh.write(f"# timed_out=True (limit={timeout_s}s)\n")
                fh.write(f"# ended_utc={datetime.utcnow().isoformat()}Z\n")
        except Exception:
            pass

        # One-line summary for tray notifications / brief UI labels.
        if rc == 0:
            summary = f"pip {label} OK in {duration:.1f}s"
        elif timed_out:
            summary = f"pip {label} TIMEOUT after {timeout_s}s"
        else:
            tail = (stderr_text or stdout_text or "").splitlines()
            tail_line = next((l for l in reversed(tail) if l.strip()), f"exit {rc}")
            summary = f"pip {label} FAILED ({rc}): {tail_line[:200]}"

        return PipResult(
            returncode=rc,
            stdout=stdout_text,
            stderr=stderr_text,
            log_path=log_path,
            cmd=list(cmd),
            duration_s=duration,
            summary=summary,
        )

    @staticmethod
    def _quote(value: str) -> str:
        s = str(value)
        if not s or any(c in s for c in (" ", "\t", '"', "'")):
            return '"' + s.replace('"', '\\"') + '"'
        return s


def _normalize_pkg_name(name: str) -> str:
    """PyPI normalises name-with_dots/UPPER to ``name-with-dots-upper``."""
    import re
    return re.sub(r"[-_.]+", "-", name).strip().lower()
