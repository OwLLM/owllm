"""
Regression guard: Windows launcher must stay split into GUI stub + console worker.

Rationale: a single GUI-subsystem launcher cannot reliably give child console
processes a hidden inherited console. The topology is documented in
LLM/LAUNCHER_README.md and enforced by LLM/build_launcher.bat.
"""
from __future__ import annotations

from pathlib import Path

import pytest


def _llm_root() -> Path:
    return Path(__file__).resolve().parents[1]


def test_launcher_cpp_defines_worker_and_gui_modes() -> None:
    cpp = (_llm_root() / "launcher.cpp").read_text(encoding="utf-8", errors="replace")
    assert "LOCALLLM_LAUNCHER_WORKER" in cpp
    assert "LOCALLLM_LAUNCHER_GUI" in cpp
    assert "launcher_worker.exe" in cpp
    assert "static int RunLauncherWorker()" in cpp
    assert "CREATE_NEW_CONSOLE" in cpp
    assert "PreferConsolePythonForHiddenWorker" in cpp
    assert 'venvPython = pythonExe;' in cpp


def test_launcher_worker_does_not_detach_app_from_hidden_console() -> None:
    cpp = (_llm_root() / "launcher.cpp").read_text(encoding="utf-8", errors="replace")
    launch_python_start = cpp.index("int LaunchPythonApp")
    launch_python_end = cpp.index("#if defined(LOCALLLM_LAUNCHER_WORKER)")
    launch_python = cpp[launch_python_start:launch_python_end]

    assert "PreferConsolePythonForHiddenWorker(pythonExe)" in launch_python
    assert "Inherit worker's hidden console" in launch_python
    assert "CREATE_NO_WINDOW" not in launch_python


def test_build_launcher_produces_both_binaries() -> None:
    bat = (_llm_root() / "build_launcher.bat").read_text(encoding="utf-8", errors="replace")
    assert "-DLOCALLLM_LAUNCHER_WORKER" in bat
    assert "-DLOCALLLM_LAUNCHER_GUI" in bat
    assert "-mconsole" in bat
    assert "-mwindows" in bat
    assert "launcher_worker.exe" in bat


@pytest.mark.skipif(
    not (_llm_root() / "launcher.exe").is_file() or not (_llm_root() / "launcher_worker.exe").is_file(),
    reason="Pre-built launcher binaries not present in this checkout",
)
def test_both_executables_exist_when_shipped() -> None:
    """Optional: CI/dev trees that ship binaries must keep both."""
    assert (_llm_root() / "launcher.exe").is_file()
    assert (_llm_root() / "launcher_worker.exe").is_file()
