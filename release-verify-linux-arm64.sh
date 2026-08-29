#!/bin/bash
set -euo pipefail

B="$HOME/owllm-build-v1.0.30/owllm-desktop/src-tauri/target/release/bundle"
A="$B/appimage/OwLLM Desktop_1.0.30_aarch64.AppImage"
D="$B/deb/OwLLM Desktop_1.0.30_arm64.deb"
R="$B/rpm/OwLLM Desktop-1.0.30-1.aarch64.rpm"
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
