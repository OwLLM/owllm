#!/usr/bin/env bash
# bootstrap.sh -- POSIX equivalent of bootstrap.bat.
#
# Both scripts are thin wrappers around scripts/build-modules.ps1. PowerShell
# Core (pwsh) runs cross-platform and the build logic is the same on every OS.
#
# Why a wrapper at all? Devs on macOS/Linux expect `./bootstrap.sh` not
# `pwsh -File ./scripts/build-modules.ps1 ...`. This is the affordance.
#
# Usage:
#   ./bootstrap.sh                                # build all modules
#   ./bootstrap.sh -Only local-inference-cuda
#   ./bootstrap.sh -Skip finetune-*

set -e
cd "$(dirname "$0")"

if ! command -v pwsh >/dev/null 2>&1; then
  echo "[owllm] pwsh (PowerShell Core) is required but not on PATH."
  case "$(uname -s)" in
    Darwin)
      echo "  Install: brew install --cask powershell"
      ;;
    Linux)
      echo "  Install: see https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-linux"
      ;;
  esac
  exit 1
fi

exec pwsh -NoProfile -ExecutionPolicy Bypass -File "$(pwd)/scripts/build-modules.ps1" "$@"
