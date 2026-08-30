#!/usr/bin/env bash
exec > /c/1_Git/LocaLLM/tail1020.log 2>&1
set -euo pipefail
echo "TAIL_START $(date)"
cd /c/1_Git/LocaLLM
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' wsl -d Ubuntu -- bash /mnt/c/1_Git/LocaLLM/waitrpm.sh
VERSION=1.0.20 bash owllm-desktop/scripts/finish-multihost.sh
echo "TAIL_EXIT $?"