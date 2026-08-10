#!/usr/bin/env bash
# Finish a multi-host release from the signing hub.
#
# publish-release.sh runs on ONE host and publishes that host's platform. The
# other hosts build and upload their own artifacts, but they hold neither the
# minisign updater key nor a gh login (see LINUX-AUTOUPDATE-RUNBOOK.md), so the
# hub has to sign their artifacts and merge the platform keys into latest.json.
# That tail used to be hand-typed into the hub every release; this is it.
#
#   VERSION=1.0.14 scripts/finish-multihost.sh
#
# Assumes: gh authenticated, ~/.tauri-keys/owllm-updater.key present, and the
# local WSL Ubuntu distro holds the linux-x86_64 build at ~/owllm-build.
set -euo pipefail

VERSION="${VERSION:?set VERSION, e.g. VERSION=1.0.14}"
TAG="v$VERSION"
REPO="${REPO:-OwLLM/owllm}"
KEY="${KEY:-$HOME/.tauri-keys/owllm-updater.key}"
W="${W:-$HOME/rel-$VERSION}"
LXROOT="${LXROOT:-owllm-build/owllm-desktop/src-tauri/target/release/bundle}"

export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
mkdir -p "$W"

say() { echo "== $*"; }

# 1. pull the linux-x86_64 artifacts out of WSL under their published names.
#    W is a Git-Bash path (/c/...) but WSL only understands the /mnt/c/... form,
#    and Git Bash ships no wslpath, so translate the drive prefix here.
W_WSL="$(printf '%s' "$W" | sed -E 's|^/([a-zA-Z])/|/mnt/\1/|')"
wslcp() {
  wsl -d Ubuntu -- bash -c "cp \"\$(ls ~/$LXROOT/$1)\" \"$W_WSL/$2\""
}
say "collecting linux-x86_64 from WSL"
wslcp "appimage/*_${VERSION}_amd64.AppImage" "OwLLM.Desktop_${VERSION}_amd64.AppImage"
wslcp "deb/*_${VERSION}_amd64.deb"           "OwLLM.Desktop_${VERSION}_amd64.deb"
wslcp "rpm/*-${VERSION}-1.x86_64.rpm"        "OwLLM.Desktop_${VERSION}_x86_64.rpm"

# 2. upload them, plus the stable-named Linux links.
#    The stable names matter: publish-release.sh deliberately does NOT carry
#    forward a pending platform's asset, so nothing else supplies a fresh
#    OwLLM.Desktop.AppImage / .deb for this tag. v1.0.13 shipped without them.
cp "$W/OwLLM.Desktop_${VERSION}_amd64.AppImage" "$W/OwLLM.Desktop.AppImage"
cp "$W/OwLLM.Desktop_${VERSION}_amd64.deb"      "$W/OwLLM.Desktop.deb"
say "uploading linux-x86_64"
gh release upload "$TAG" --repo "$REPO" --clobber \
  "$W/OwLLM.Desktop_${VERSION}_amd64.AppImage" \
  "$W/OwLLM.Desktop_${VERSION}_amd64.deb" \
  "$W/OwLLM.Desktop_${VERSION}_x86_64.rpm" \
  "$W/OwLLM.Desktop.AppImage" \
  "$W/OwLLM.Desktop.deb"

# 3. bring the foreign updater artifacts here so they can be signed
say "downloading foreign updater artifacts"
for pat in "OwLLM.Desktop_${VERSION}_aarch64.AppImage" "OwLLM.Desktop_universal.app.tar.gz"; do
  gh release download "$TAG" --repo "$REPO" --pattern "$pat" --dir "$W" --clobber
done

# 4. sign every updater artifact that did not come from this host
say "signing"
for f in "OwLLM.Desktop_${VERSION}_amd64.AppImage" \
         "OwLLM.Desktop_${VERSION}_aarch64.AppImage" \
         "OwLLM.Desktop_universal.app.tar.gz"; do
  npx --yes @tauri-apps/cli signer sign --private-key-path "$KEY" --password= "$W/$f" < /dev/null
  [ -s "$W/$f.sig" ] || { echo "no signature produced for $f" >&2; exit 1; }
done

echo "FINISH_MULTIHOST_ARTIFACTS_OK $VERSION"
