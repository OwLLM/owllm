#!/bin/bash
set -euo pipefail

A="/home/mc/owllm-build/owllm-desktop/src-tauri/target/release/bundle/appimage/OwLLM Desktop_1.0.30_amd64.AppImage"
D="/home/mc/owllm-build/owllm-desktop/src-tauri/target/release/bundle/deb/OwLLM Desktop_1.0.30_amd64.deb"
R="/home/mc/owllm-build/owllm-desktop/src-tauri/target/release/bundle/rpm/OwLLM Desktop-1.0.30-1.x86_64.rpm"
test -s "$A" -a -s "$D" -a -s "$R"
echo DEB_META
dpkg-deb --field "$D" Package Version Architecture
echo DEB_RUNTIME
dpkg-deb --contents "$D" | grep "resources/runtime/whisper.cpp/"
echo RPM_META
rpm -qip "$R" | grep -E "^(Name|Version|Release|Architecture)"
echo RPM_RUNTIME
rpm -qlp "$R" | grep "resources/runtime/whisper.cpp/"
echo APPIMAGE_RUNTIME
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
cd "$T"
"$A" --appimage-extract >/dev/null
find squashfs-root -path "*resources/runtime/whisper.cpp/*" -type f -printf "%f %s\n" | sort
sha256sum "$A" "$D" "$R"
