#!/usr/bin/env bash
set -uo pipefail
B=/home/mc/owllm-build/owllm-desktop/src-tauri/target/release/bundle
prev=""
for i in $(seq 1 160); do
  f=$(ls "$B"/appimage/*_1.0.20_amd64.AppImage 2>/dev/null | head -1)
  if [ -n "$f" ]; then
    sz=$(stat -c %s "$f")
    if [ "$sz" = "$prev" ] && [ "$sz" -gt 100000000 ]; then
      echo "APPIMAGE_READY $sz $f"
      exit 0
    fi
    prev="$sz"
  fi
  sleep 15
done
echo "APPIMAGE_TIMEOUT"
exit 1