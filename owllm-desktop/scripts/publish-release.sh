#!/usr/bin/env bash
# Canonical OwLLM release flow — the SINGLE source of truth for publishing, run
# both by a human and by the Publisher agent (via the publish_release host
# command). It exists because the steps below — especially the minisign signing —
# are finicky (empty-password env + closed stdin; PowerShell mangles it), so an
# LLM shelling them ad-hoc gets it wrong. Encode it once, correctly, here.
#
# Usage:
#   scripts/publish-release.sh                                 # build, sign, publish to Latest (notes auto-derived from git log)
#   scripts/publish-release.sh --notes "release notes"        # same, with explicit notes
#   scripts/publish-release.sh --dry-run                       # build + sign + latest.json, NO gh release (safe rehearsal)
#   scripts/publish-release.sh --draft                         # publish as a DRAFT (human flips public)
#   scripts/publish-release.sh --prerelease                    # publish as a PRE-RELEASE: public + downloadable, but NOT /latest (auto-updater skips it) — the "test before you promote" channel
#
# Version is read from src-tauri/tauri.conf.json (bump + commit + tag BEFORE
# calling this). Requires on PATH: cargo+mingw (build), node/npx (sign), gh (publish).
set -euo pipefail

# gh resolver: host `gh` → WSL sandbox `gh` (the host often has no gh; it lives in the
# provisioned distro). Defines gh()/have_gh(). Falls back to a plain check if the lib
# isn't alongside this script.
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$_SCRIPT_DIR/lib/gh.sh" ]; then
  # shellcheck source=lib/gh.sh
  . "$_SCRIPT_DIR/lib/gh.sh"
else
  have_gh() { command -v gh >/dev/null 2>&1; }
fi

# Target GitHub repo for `gh release` — resolution order:
#   1. $OWLLM_RELEASE_REPO (exported by finish-and-publish.sh from the Project
#      Card's release.repo, or set by the caller)
#   2. release.repo read from the card directly (covers the direct
#      publish_release dry-run/draft path that skips finish-and-publish.sh)
#   3. the historical OwLLM default (card-less repos publish exactly as before)
REPO="${OWLLM_RELEASE_REPO:-}"
NOTES=""
DRY_RUN=0
DRAFT=0
PRERELEASE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --notes) NOTES="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --draft) DRAFT=1; shift ;;
    --prerelease) PRERELEASE=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Resolve owllm-desktop/ (this script lives in owllm-desktop/scripts/).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
cd "$APP"

# Finish resolving the target repo (see the note at REPO= above).
if [ -z "$REPO" ] && [ -f "$APP/../.owllm/project.json" ]; then
  REPO="$(CARD="$APP/../.owllm/project.json" node -e 'try{const r=(require(process.env.CARD).release)||{};process.stdout.write(String(r.repo||""))}catch{}' 2>/dev/null || true)"
fi
[ -n "$REPO" ] || REPO="OwLLM/owllm"
echo "release target repo: $REPO"

# Stream a verbatim copy of this run to .cache so a failure can be diagnosed
# without relying on the app's log view (which truncates or may be closed).
mkdir -p "$APP/.cache"
LIVE_LOG="$APP/.cache/publish-latest.log"
: > "$LIVE_LOG"
exec > >(tee -a "$LIVE_LOG") 2>&1
# Persist the log under the version even if the script aborts mid-run.
trap 'cp -f "$LIVE_LOG" "$APP/.cache/publish-v${VERSION:-unknown}.log" 2>/dev/null || true' EXIT

VERSION="$(node -e 'process.stdout.write(require("./src-tauri/tauri.conf.json").version)')"
TAG="v$VERSION"
KEY_FILE=".tauri-keys/owllm-updater.key"
LATEST="dist/latest.json"

# ---- host/platform detection ---------------------------------------------
UNAME_S="$(uname -s)"
HOST_FLAVOR="$UNAME_S"
is_wsl_windows=0
if [ "$UNAME_S" = "Linux" ] && [ -r /proc/version ] && grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null && command -v cmd.exe >/dev/null 2>&1; then
  is_wsl_windows=1
  HOST_FLAVOR="WSL"
fi

to_windows_path() {
  cygpath -w "$1" 2>/dev/null || wslpath -w "$1" 2>/dev/null || printf '%s' "$1"
}

to_posix_path() {
  cygpath -u "$1" 2>/dev/null || wslpath -u "$1" 2>/dev/null || printf '%s' "$1"
}

find_windows_tool() {
  local rel="$1" root
  for root in "/mnt/c" "/c"; do
    if [ -f "$root/$rel" ]; then
      printf '%s' "$root/$rel"
      return 0
    fi
  done
  return 1
}

find_signtool() {
  local found
  found="$(command -v signtool.exe 2>/dev/null || true)"
  if [ -n "$found" ]; then printf '%s' "$found"; return 0; fi
  for root in "/mnt/c/Program Files (x86)/Windows Kits/10/bin" "/c/Program Files (x86)/Windows Kits/10/bin"; do
    found="$(ls -d "$root"/*/x64/signtool.exe 2>/dev/null | sort -r | head -1 || true)"
    if [ -n "$found" ]; then printf '%s' "$found"; return 0; fi
  done
  return 1
}

find_makensis() {
  local found local_appdata posix_local_appdata
  found="$(command -v makensis.exe 2>/dev/null || command -v makensis 2>/dev/null || true)"
  if [ -n "$found" ]; then printf '%s' "$found"; return 0; fi
  local_appdata="${LOCALAPPDATA:-}"
  if [ -z "$local_appdata" ] && command -v powershell.exe >/dev/null 2>&1; then
    local_appdata="$(powershell.exe -NoProfile -Command "[Environment]::GetFolderPath('LocalApplicationData')" 2>/dev/null | tr -d '\r' | tail -1 || true)"
  fi
  if [ -n "$local_appdata" ]; then
    posix_local_appdata="$(to_posix_path "$local_appdata")"
    for found in "$posix_local_appdata/tauri/NSIS/makensis.exe" "$posix_local_appdata/tauri/NSIS/Bin/makensis.exe"; do
      if [ -x "$found" ] || [ -f "$found" ]; then printf '%s' "$found"; return 0; fi
    done
  fi
  return 1
}

# ---- per-platform artifact map -------------------------------------------
# One script, three OSes. INSTALLER = the human-download asset (stable name),
# UPDATER_ARTIFACT = what minisign signs and latest.json points at.
# Windows keeps its historical /latest/ URL (unchanged behaviour); macOS and
# Linux use VERSIONED URLs so a later Windows-only publish can never leave a
# platform key pointing at an asset that no longer matches its signature.
case "$UNAME_S" in
  MINGW*|MSYS*|CYGWIN*) HOST_OS="windows" ;;
  Darwin)               HOST_OS="macos" ;;
  *)                    if [ "$is_wsl_windows" = 1 ]; then HOST_OS="windows"; else HOST_OS="linux"; fi ;;
esac
ARCH="$(uname -m)"
case "$ARCH" in arm64|aarch64) ARCH="aarch64" ;; *) ARCH="x86_64" ;; esac
case "$HOST_OS" in
  windows)
    PLATFORM_KEY="windows-x86_64"
    INSTALLER="dist/OwLLM Desktop Setup.exe"
    UPDATER_ARTIFACT="$INSTALLER"
    URL="https://github.com/$REPO/releases/latest/download/OwLLM.Desktop.Setup.exe"
    ;;
  macos)
    PLATFORM_KEY="darwin-$ARCH"
    INSTALLER="dist/OwLLM.Desktop.Setup.dmg"
    # Tauri's macOS updater consumes a .app tar.gz, not the dmg.
    UPDATER_ARTIFACT="dist/OwLLM.Desktop_$ARCH.app.tar.gz"
    URL="https://github.com/$REPO/releases/download/$TAG/OwLLM.Desktop_$ARCH.app.tar.gz"
    ;;
  linux)
    PLATFORM_KEY="linux-$ARCH"
    INSTALLER="dist/OwLLM.Desktop_${VERSION}_${ARCH}.AppImage"
    UPDATER_ARTIFACT="$INSTALLER"   # Tauri's Linux updater consumes the AppImage
    URL="https://github.com/$REPO/releases/download/$TAG/OwLLM.Desktop_${VERSION}_${ARCH}.AppImage"
    ;;
esac

step() { echo ""; echo "=== $* ==="; }
fail() { echo "PUBLISH_FAILED: $*" >&2; exit 1; }

MIN_HOST_RELEASE_FREE_KB=$((20 * 1024 * 1024))
fmt_kb() {
  awk -v kb="$1" 'BEGIN { printf "%.1f GB", kb / 1024 / 1024 }'
}
preflight_host_disk() {
  local dir="$1" avail
  avail="$(df -Pk "$dir" 2>/dev/null | awk 'NR==2 {print $4}' || true)"
  [ -n "$avail" ] || fail "could not measure free disk space for '$dir' (host release requires at least $(fmt_kb "$MIN_HOST_RELEASE_FREE_KB") free)"
  if [ "$avail" -lt "$MIN_HOST_RELEASE_FREE_KB" ]; then
    fail "only $(fmt_kb "$avail") free; host release requires at least $(fmt_kb "$MIN_HOST_RELEASE_FREE_KB") before building. Free space or clean build caches first."
  fi
  echo "disk preflight: $(fmt_kb "$avail") free (minimum $(fmt_kb "$MIN_HOST_RELEASE_FREE_KB"))"
}

preflight_host_disk "$APP"

# No --notes → fall back to the OWLLM_RELEASE_NOTES env var (set by the
# deterministic finish-and-publish.sh), then derive from git history.
# finish-and-publish.sh stopped passing notes as a shell-quoted argument
# because commit subjects can contain quotes that broke the inner bash -c.
[ -n "${OWLLM_RELEASE_NOTES:-}" ] && [ -z "$NOTES" ] && NOTES="$OWLLM_RELEASE_NOTES"

# No --notes → derive them from git history. Version-bump commits (the ones
# touching tauri.conf.json) mark release boundaries, and commit subjects in
# this repo are written as release notes ("vX.Y.Z: what shipped"), so the
# bullets below are real user-facing lines. This is what the GitHub release
# body AND the in-app update popup (latest.json "notes") show — an empty
# --notes must never again publish a body that is just the tag.
if [ -z "$NOTES" ]; then
  # Boundary = the bump commit of the release users are actually ON (gh latest),
  # so a version that never shipped (failed build) still lands in the next
  # release's notes. Fall back to the previous bump commit, then to -n 15.
  PREV_BUMP=""
  PREV_TAG="$(gh release view --repo "$REPO" --json tagName --jq .tagName 2>/dev/null || true)"
  if [ -n "$PREV_TAG" ]; then
    PREV_VER_RE="$(printf '%s' "${PREV_TAG#v}" | sed 's/\./\\./g')"
    # awk, not grep -P: MSYS grep rejects \x escapes under non-UTF8 locales.
    PREV_BUMP="$(git log --format='%H%x09%s' -n 200 -- src-tauri/tauri.conf.json \
      | awk -F'\t' -v re="^v?${PREV_VER_RE}([:,. ]|\$)" \
          '{ s=$2; sub(/^\xef\xbb\xbf/, "", s); if (s ~ re) { print $1; exit } }' || true)"
  fi
  [ -n "$PREV_BUMP" ] || PREV_BUMP="$(git log --format=%H -n 2 -- src-tauri/tauri.conf.json | sed -n 2p || true)"
  if [ -n "$PREV_BUMP" ]; then LOGSPEC=("$PREV_BUMP..HEAD"); else LOGSPEC=(-n 15); fi
  NOTES="$(git log --no-merges --format='%s' "${LOGSPEC[@]}" | awk '
    { sub(/^\xef\xbb\xbf/, "");                      # strip UTF-8 BOM some subjects carry
      sub(/^v?[0-9]+\.[0-9]+\.[0-9]+[.:,]?[ \t]*/, ""); # strip "vX.Y.Z:" release prefix
      gsub(/^[ \t]+|[ \t]+$/, "");
      if ($0 == "") next;                            # bare "vX.Y.Z" bump commits
      if (!seen[$0]++) print "- " $0 }')"
  [ -n "$NOTES" ] || NOTES="Release $VERSION"
  echo "auto-derived release notes:"; printf '%s\n' "$NOTES"
fi

[ -f "$KEY_FILE" ] || fail "signing key not found at $KEY_FILE (host-only secret — run on the host, not a sandbox)"
command -v node >/dev/null 2>&1 || fail "node/npx not on PATH (needed to sign)"
[ "$DRY_RUN" = 1 ] || have_gh || fail "gh not on PATH (needed to publish)"

# Resolve the Authenticode cert once, up front — used by the payload-sign step
# below AND the installer-sign step 1b. Priority: env thumbprint · env subject ·
# .tauri-keys/authenticode.thumbprint file. Unconfigured → both steps skip.
SIGN_THUMBPRINT="${OWLLM_SIGN_THUMBPRINT:-}"
SIGN_SUBJECT="${OWLLM_SIGN_SUBJECT:-}"
SIGN_TSA="${OWLLM_SIGN_TSA:-http://time.certum.pl}"          # Certum RFC3161 timestamp
THUMB_FILE=".tauri-keys/authenticode.thumbprint"
if [ -z "$SIGN_THUMBPRINT" ] && [ -z "$SIGN_SUBJECT" ] && [ -f "$THUMB_FILE" ]; then
  SIGN_THUMBPRINT="$(tr -d ' \r\n\t' < "$THUMB_FILE")"
fi

# Optional: auto-establish the SimplySign session so the ~2h Certum session re-auth
# doesn't need a phone. The QR you enrolled with is a standard otpauth:// TOTP seed;
# Connect-SimplySign.ps1 generates the current OTP from it, logs in, and waits until
# the cloud cert actually appears in the store (real readiness signal, not a sleep).
# OPT-IN via OWLLM_AUTO_SIMPLYSIGN=1 so the default flow is unchanged; the seed comes
# from $CERTUM_OTP_URI (never committed). No-op if the cert is already mounted (still
# inside the 2h window). Security note: this stores your 2FA seed on the build box.
if [ "${OWLLM_AUTO_SIMPLYSIGN:-}" = "1" ] && { [ -n "$SIGN_THUMBPRINT" ] || [ -n "$SIGN_SUBJECT" ]; }; then
  case "$HOST_OS" in
    windows)
      echo "  auto-connecting SimplySign (OWLLM_AUTO_SIMPLYSIGN=1)…"
      powershell.exe -NoProfile -ExecutionPolicy Bypass \
        -File "$(to_windows_path "$APP/scripts/Connect-SimplySign.ps1")" \
        ${SIGN_THUMBPRINT:+-Thumbprint "$SIGN_THUMBPRINT"} \
        || fail "SimplySign auto-connect failed — verify the seed with 'powershell -File scripts/Connect-SimplySign.ps1 -CodeOnly' (must match your phone), or log in manually"
      ;;
    *) echo "  (OWLLM_AUTO_SIMPLYSIGN set but SimplySign auto-connect is Windows-only — skipping)" ;;
  esac
fi

step "0b/5 payload sign — every exe/dll bundled under resources/ must be signed"
# Unsigned binaries INSIDE an EV-signed installer are a classic SmartScreen /
# Defender heuristic trigger (bit us with the whisper.cpp runtime). Sign any
# unsigned exe/dll the bundle will carry, with the same cert as the installer.
case "$HOST_OS" in
  windows)
    if [ -n "$SIGN_THUMBPRINT" ] || [ -n "$SIGN_SUBJECT" ]; then
      SIGNTOOL="$(find_signtool || true)"
      [ -n "$SIGNTOOL" ] || fail "signtool.exe not found — install the Windows 10/11 SDK (or put signtool on PATH)"
      if [ -n "$SIGN_THUMBPRINT" ]; then SEL=(/sha1 "$SIGN_THUMBPRINT"); else SEL=(/n "$SIGN_SUBJECT"); fi
      PAYLOAD_SIGNED=0
      while IFS= read -r bin; do
        WBIN="$(to_windows_path "$bin")"
        # already signed (by us or upstream, e.g. Microsoft's WebView2Loader)? skip.
        if MSYS2_ARG_CONV_EXCL="*" "$SIGNTOOL" verify /pa "$WBIN" >/dev/null 2>&1; then continue; fi
        echo "  signing payload: $bin"
        MSYS2_ARG_CONV_EXCL="*" "$SIGNTOOL" sign "${SEL[@]}" /fd sha256 /tr "$SIGN_TSA" /td sha256 /d "OwLLM Desktop" "$WBIN" \
          || fail "payload sign failed on $bin"
        PAYLOAD_SIGNED=$((PAYLOAD_SIGNED + 1))
      done < <(find "$APP/resources" -type f \( -name '*.exe' -o -name '*.dll' \) 2>/dev/null)
      echo "  ✓ payload check done ($PAYLOAD_SIGNED newly signed)"
    else
      echo "  (skipped — no signing cert configured)"
    fi
    ;;
  *) echo "  (skipped — Windows-only step)" ;;
esac

# ---- ship gate: smoke matrix ---------------------------------------------
# Green matrix = shippable. This runs BEFORE the expensive build so a known
# regression fails fast instead of after a 10-minute compile + sign. Default is
# --static-only: the source tripwires (one per shipped provider fix) + the
# Layer-1 control-flow harnesses — deterministic, no credentials, safe on a
# headless/CI box. OWLLM_SMOKE_FULL=1 also runs the live provider cells (needs
# logged-in CLIs). OWLLM_SKIP_SMOKE=1 bypasses entirely (emergencies only).
if [ "${OWLLM_SKIP_SMOKE:-0}" = "1" ]; then
  echo "⚠ smoke matrix SKIPPED (OWLLM_SKIP_SMOKE=1) — shipping unverified"
else
  step "0/5 smoke matrix (ship gate)"
  SMOKE_ARGS="--static-only"; [ "${OWLLM_SMOKE_FULL:-0}" = "1" ] && SMOKE_ARGS=""
  NODE_RUNNER="${OWLLM_NODE:-}"
  if [ -z "$NODE_RUNNER" ]; then
    NODE_RUNNER="$(command -v node.exe 2>/dev/null || command -v node)"
  fi
  SMOKE_MATRIX="$APP/scripts/smoke-matrix.mjs"
  case "$NODE_RUNNER" in
    *node.exe)
      SMOKE_MATRIX="$(cygpath -w "$SMOKE_MATRIX" 2>/dev/null || wslpath -w "$SMOKE_MATRIX" 2>/dev/null || printf '%s' "$SMOKE_MATRIX")"
      ;;
  esac
  "$NODE_RUNNER" "$SMOKE_MATRIX" $SMOKE_ARGS \
    || fail "smoke matrix red — not shippable. Fix the failing cell, or OWLLM_SKIP_SMOKE=1 for an emergency override."
fi

step "1/5 build  (version $VERSION)"
# TS/Rust changes need a fresh bundle; drop the stale artifacts so a skipped
# relink can't ship an old version string.
rm -f "$INSTALLER" "$UPDATER_ARTIFACT" "$UPDATER_ARTIFACT.sig"
case "$HOST_OS" in
  # cmd.exe needs the FULL Windows path to the .bat (a relative name or a POSIX
  # "/c/…" path gets mangled by MSYS and silently no-ops). cygpath -w resolves it.
  windows)
    WINBAT="$(to_windows_path "$APP/build-release.bat")"
    if [ "$HOST_FLAVOR" = "WSL" ]; then
      cmd.exe /c "$WINBAT" || fail "build-release.bat failed"
    else
      cmd.exe //c "$WINBAT" || fail "build-release.bat failed"
    fi
    ;;
  *)
    npm run tauri -- build || fail "tauri build failed"
    mkdir -p dist
    BUNDLE="src-tauri/target/release/bundle"
    if [ "$HOST_OS" = "macos" ]; then
      DMG="$(ls "$BUNDLE"/dmg/*.dmg 2>/dev/null | head -1 || true)"
      [ -n "$DMG" ] || fail "no .dmg under $BUNDLE/dmg — tauri bundle step failed"
      cp -f "$DMG" "$INSTALLER"
      APPB="$(ls -d "$BUNDLE"/macos/*.app 2>/dev/null | head -1 || true)"
      [ -n "$APPB" ] || fail "no .app under $BUNDLE/macos — tauri bundle step failed"
      tar -czf "$UPDATER_ARTIFACT" -C "$(dirname "$APPB")" "$(basename "$APPB")"
    else
      AI="$(ls "$BUNDLE"/appimage/*.AppImage 2>/dev/null | head -1 || true)"
      [ -n "$AI" ] || fail "no .AppImage under $BUNDLE/appimage — tauri bundle step failed"
      cp -f "$AI" "$INSTALLER"
      # Convenience packages for non-AppImage distros (download-only; the
      # updater path is the AppImage).
      cp -f "$BUNDLE"/deb/*.deb "dist/OwLLM.Desktop_${VERSION}_${ARCH}.deb" 2>/dev/null || true
      cp -f "$BUNDLE"/rpm/*.rpm "dist/OwLLM.Desktop_${VERSION}_${ARCH}.rpm" 2>/dev/null || true
    fi
    ;;
esac
[ -f "$INSTALLER" ] || fail "build produced no installer at $INSTALLER (build step did not run or failed)"
[ -f "$UPDATER_ARTIFACT" ] || fail "no updater artifact at $UPDATER_ARTIFACT"

step "1a/5 windows payload signing (exe/dll before installer)"
case "$HOST_OS" in
  windows)
    if [ -n "$SIGN_THUMBPRINT" ] || [ -n "$SIGN_SUBJECT" ]; then
      SIGNTOOL="$(find_signtool || true)"
      [ -n "$SIGNTOOL" ] || fail "signtool.exe not found — install the Windows 10/11 SDK (or put signtool on PATH) to Authenticode-sign payloads"
      if [ -n "$SIGN_THUMBPRINT" ]; then SEL=(/sha1 "$SIGN_THUMBPRINT"); else SEL=(/n "$SIGN_SUBJECT"); fi

      sign_payload() {
        local src="$1" label="$2" win_src
        [ -f "$src" ] || fail "payload missing: $src"
        win_src="$(to_windows_path "$src")"
        if ! MSYS2_ARG_CONV_EXCL="*" "$SIGNTOOL" verify /pa "$win_src" >/dev/null 2>&1; then
          echo "  signing $label: $src"
          MSYS2_ARG_CONV_EXCL="*" "$SIGNTOOL" sign "${SEL[@]}" /fd sha256 /tr "$SIGN_TSA" /td sha256 /d "OwLLM Desktop" "$win_src" \
            || fail "payload sign failed on $src"
        fi
        MSYS2_ARG_CONV_EXCL="*" "$SIGNTOOL" verify /pa "$win_src" >/dev/null \
          || fail "payload verify failed after signing: $src"
      }

      RELEASE_DIR="src-tauri/target/x86_64-pc-windows-gnu/release"
      sign_payload "$RELEASE_DIR/owllm-desktop.exe" "main exe"
      sign_payload "$RELEASE_DIR/WebView2Loader.dll" "WebView2 loader"

      cp -f "$RELEASE_DIR/owllm-desktop.exe" "OwLLM Desktop.exe" || echo "  warn: could not refresh root convenience exe"
      cp -f "$RELEASE_DIR/owllm-desktop.exe" "dist/OwLLM Desktop.exe" || echo "  warn: could not refresh dist convenience exe"
      [ -f "WebView2Loader.dll" ] || cp -f "$RELEASE_DIR/WebView2Loader.dll" "WebView2Loader.dll" || echo "  warn: could not seed root WebView2Loader.dll"
      cp -f "$RELEASE_DIR/WebView2Loader.dll" "dist/WebView2Loader.dll" || echo "  warn: could not refresh dist WebView2Loader.dll"

      # Tauri's generated NSIS script reads MAINBINARYSRCPATH from RELEASE_DIR.
      # Rebuild it after force-signing the exe so the installer payload is signed
      # too, then let step 1b sign the outer installer.
      NSIS_DIR="$RELEASE_DIR/nsis/x64"
      NSIS_OUT="$NSIS_DIR/nsis-output.exe"
      BUNDLED_INSTALLER="$RELEASE_DIR/bundle/nsis/OwLLM Desktop_${VERSION}_x64-setup.exe"
      MAKENSIS="$(find_makensis || true)"
      [ -n "$MAKENSIS" ] || fail "makensis.exe not found — cannot rebuild installer with signed payload"
      [ -f "$NSIS_DIR/installer.nsi" ] || fail "generated NSIS script missing: $NSIS_DIR/installer.nsi"
      ( cd "$NSIS_DIR" && "$MAKENSIS" installer.nsi ) || fail "makensis failed while rebuilding signed installer"
      [ -f "$NSIS_OUT" ] || fail "makensis produced no output at $NSIS_OUT"
      mkdir -p "$(dirname "$BUNDLED_INSTALLER")"
      cp -f "$NSIS_OUT" "$BUNDLED_INSTALLER"
      cp -f "$BUNDLED_INSTALLER" "$INSTALLER"
      echo "  ✓ payloads signed and NSIS installer rebuilt"
    else
      echo "  (skipped — no OWLLM_SIGN_THUMBPRINT / OWLLM_SIGN_SUBJECT / $THUMB_FILE; payloads may be unsigned)"
    fi
    ;;
  *) echo "  (skipped — Windows-only step)" ;;
esac

step "1b/5 authenticode sign (SimplySign / Certum) — must run BEFORE minisign"
# Windows code signing to clear SmartScreen "unknown publisher". Uses the cloud
# cert exposed by SimplySign Desktop (log in first — the virtual card must be
# mounted in the Windows cert store). Configure the cert via, in priority order:
#   OWLLM_SIGN_THUMBPRINT env · OWLLM_SIGN_SUBJECT env · .tauri-keys/authenticode.thumbprint
# Unconfigured → SKIP (installer stays unsigned, today's behaviour). Configured
# but signing fails → FAIL (never ship a "signed" release that isn't). Authenticode
# MUST precede minisign: it rewrites the .exe, which would void the updater sig.
case "$HOST_OS" in
  windows)
    if [ -n "$SIGN_THUMBPRINT" ] || [ -n "$SIGN_SUBJECT" ]; then
      SIGNTOOL="$(find_signtool || true)"
      [ -n "$SIGNTOOL" ] || fail "signtool.exe not found — install the Windows 10/11 SDK (or put signtool on PATH) to Authenticode-sign"
      WININ="$(to_windows_path "$INSTALLER")"
      if [ -n "$SIGN_THUMBPRINT" ]; then SEL=(/sha1 "$SIGN_THUMBPRINT"); else SEL=(/n "$SIGN_SUBJECT"); fi
      echo "  signing '$INSTALLER'  (${SIGN_THUMBPRINT:+thumbprint ${SIGN_THUMBPRINT}}${SIGN_SUBJECT:+subject \"${SIGN_SUBJECT}\"}, tsa $SIGN_TSA)"
      # MSYS2_ARG_CONV_EXCL: Git Bash rewrites /fd, /tr, /sha1 into filesystem
      # paths before signtool sees them ("No file digest algorithm specified").
      MSYS2_ARG_CONV_EXCL="*" "$SIGNTOOL" sign "${SEL[@]}" /fd sha256 /tr "$SIGN_TSA" /td sha256 /d "OwLLM Desktop" "$WININ" \
        || fail "signtool sign failed — is SimplySign Desktop running + logged in (cloud key mounted)? Is the thumbprint/subject correct?"
      MSYS2_ARG_CONV_EXCL="*" "$SIGNTOOL" verify /pa "$WININ" || fail "signtool verify failed after signing"
      echo "  ✓ Authenticode-signed + verified"
    else
      echo "  (skipped — no OWLLM_SIGN_THUMBPRINT / OWLLM_SIGN_SUBJECT / $THUMB_FILE; installer will be UNSIGNED)"
    fi
    ;;
  *) echo "  (skipped — Authenticode signing is Windows-only)" ;;
esac

step "2/5 sign   (minisign — empty password, closed stdin)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
case "$HOST_OS" in
  windows)
    NODE_RUNNER="${OWLLM_NODE:-}"
    [ -n "$NODE_RUNNER" ] || NODE_RUNNER="$(command -v node.exe 2>/dev/null || command -v node)"
    TAURI_CLI="$(to_windows_path "$APP/node_modules/@tauri-apps/cli/tauri.js")"
    "$NODE_RUNNER" "$TAURI_CLI" signer sign --private-key-path "$(to_windows_path "$KEY_FILE")" --password= "$(to_windows_path "$UPDATER_ARTIFACT")" < /dev/null
    ;;
  *)
    npx @tauri-apps/cli signer sign --private-key-path "$KEY_FILE" --password= "$UPDATER_ARTIFACT" < /dev/null
    ;;
esac
SIG="$(cat "$UPDATER_ARTIFACT.sig")"
[ "${#SIG}" -ge 200 ] || fail "signature looks wrong (${#SIG} chars)"

step "3/5 latest.json (merge platform keys)"
# Preserve OTHER platforms' entries only when they were published for THIS
# same version (coordinated multi-OS publish of one tag). A stale entry from
# an older version would make that platform's updater "install" an update
# that leaves the app on the old version — an infinite update loop.
EXISTING_LATEST="$(curl -sL "https://github.com/$REPO/releases/latest/download/latest.json" 2>/dev/null || true)"
SIG="$SIG" NOTES="$NOTES" VERSION="$VERSION" URL="$URL" \
PLATFORM_KEY="$PLATFORM_KEY" EXISTING_LATEST="$EXISTING_LATEST" node -e '
  const fs=require("fs");
  let prev={}; try{ prev=JSON.parse(process.env.EXISTING_LATEST||"{}"); }catch{}
  const platforms=(prev.version===process.env.VERSION && prev.platforms)?{...prev.platforms}:{};
  platforms[process.env.PLATFORM_KEY]={signature:process.env.SIG,url:process.env.URL};
  const m={version:process.env.VERSION,notes:process.env.NOTES||("Release "+process.env.VERSION),
    pub_date:new Date().toISOString(),platforms};
  fs.writeFileSync("dist/latest.json",JSON.stringify(m,null,2));
  console.log("  platforms in manifest:",Object.keys(platforms).join(", "));'

if [ "$DRY_RUN" = 1 ]; then
  echo ""; echo "PUBLISH_DRYRUN_OK: built + signed $VERSION; $INSTALLER + $LATEST ready (gh release skipped)."
  exit 0
fi

_chan="latest"; [ "$PRERELEASE" = 1 ] && _chan="prerelease"; [ "$DRAFT" = 1 ] && _chan="draft"
step "4/5 gh release ($TAG, $_chan)"
LATEST_FLAG="--latest"; [ "$PRERELEASE" = 1 ] && LATEST_FLAG="--prerelease"; [ "$DRAFT" = 1 ] && LATEST_FLAG="--draft"
UPLOADS=("$INSTALLER" "$LATEST")
[ "$UPDATER_ARTIFACT" = "$INSTALLER" ] || UPLOADS+=("$UPDATER_ARTIFACT")
for extra in "dist/OwLLM.Desktop_${VERSION}_${ARCH}.deb" "dist/OwLLM.Desktop_${VERSION}_${ARCH}.rpm"; do
  [ -f "$extra" ] && UPLOADS+=("$extra")
done
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" "${UPLOADS[@]}" --repo "$REPO" --clobber
  # Refresh the body too — but never clobber notes a human wrote by hand:
  # only overwrite when the existing body is empty or just the tag/version.
  EXISTING_BODY="$(gh release view "$TAG" --repo "$REPO" --json body --jq .body 2>/dev/null | tr -d ' \r\n')"
  if [ -z "$EXISTING_BODY" ] || [ "$EXISTING_BODY" = "$TAG" ] || [ "$EXISTING_BODY" = "$VERSION" ] || [ "$EXISTING_BODY" = "Release$VERSION" ]; then
    gh release edit "$TAG" --repo "$REPO" --notes "$NOTES"
  fi
  if [ "$DRAFT" = 1 ]; then :
  elif [ "$PRERELEASE" = 1 ]; then gh release edit "$TAG" --repo "$REPO" --draft=false --prerelease --latest=false
  else gh release edit "$TAG" --repo "$REPO" --draft=false --latest
  fi
else
  gh release create "$TAG" --repo "$REPO" --title "$TAG" --notes "$NOTES" $LATEST_FLAG "${UPLOADS[@]}"
fi

# Carry-forward: the release marked "Latest" must offer a working installer for
# EVERY OS, even on a single-OS publish. The site/READMEs link at
# `releases/latest/download/<stable-name>`, which 404s the instant Latest lacks
# that OS's asset (a Mac-only publish once broke the Windows download this way).
# So after this tag is Latest, copy forward the newest existing stable-named
# installer for any OS this build didn't produce. Purely additive and
# failure-tolerant — a hiccup here never fails the publish.
carry_forward_assets() {
  local repo="$1" tag="$2"
  local names="OwLLM.Desktop.Setup.exe OwLLM.Desktop.Setup.dmg OwLLM.Desktop.AppImage OwLLM.Desktop.deb"
  local have tmp src name
  have="$(gh release view "$tag" --repo "$repo" --json assets --jq '.assets[].name' 2>/dev/null || true)"
  tmp="$(mktemp -d)"
  for name in $names; do
    printf '%s\n' "$have" | grep -qxF "$name" && continue   # already on this tag
    src="$(gh api "repos/$repo/releases?per_page=30" \
      --jq "[.[] | select(.draft|not) | select(.tag_name != \"$tag\") | select(any(.assets[]; .name == \"$name\")) ] | first | .tag_name" 2>/dev/null || true)"
    [ -n "$src" ] && [ "$src" != "null" ] || continue       # no OS build to carry
    if gh release download "$src" --repo "$repo" --pattern "$name" --dir "$tmp" 2>/dev/null; then
      gh release upload "$tag" "$tmp/$name" --repo "$repo" --clobber 2>/dev/null \
        && echo "  carried forward $name from $src"
    fi
  done
  rm -rf "$tmp"
}
if [ "$DRAFT" != 1 ] && [ "$PRERELEASE" != 1 ]; then
  carry_forward_assets "$REPO" "$TAG" || echo "  warn: asset carry-forward skipped (non-fatal)"
fi

step "5/5 verify"
if [ "$DRAFT" = 1 ]; then
  echo "PUBLISH_DRAFT_OK: $TAG drafted — flip it public on GitHub when ready."
  exit 0
fi
if [ "$PRERELEASE" = 1 ]; then
  # A pre-release is intentionally NOT /latest — the auto-updater skips it, so
  # DON'T poll /latest (that would false-fail). Verify the tagged asset is
  # publicly downloadable and hand back the direct link for a targeted test.
  DL="https://github.com/$REPO/releases/download/$TAG/$(basename "$INSTALLER" | tr ' ' '.')"
  HTTP="$(curl -s -o /dev/null -w "%{http_code}" -L "$DL")"
  echo "  prerelease installer: $DL (HTTP $HTTP)"
  [ "$HTTP" = "200" ] || fail "prerelease installer HTTP $HTTP (expected 200)"
  echo "PUBLISH_PRERELEASE_OK: $TAG published as a pre-release (NOT auto-served). Test via the link above, then promote to Latest."
  exit 0
fi
# Poll: GitHub's /latest CDN can lag MINUTES behind `gh release create` (both
# v0.8.32 and v0.8.33 propagated slower than the old ~60s window, false-failing
# a release that was actually fine). Retry up to ~6 min; when it still lags,
# distinguish "CDN stale but API says Latest is right" from a real failure.
SERVED=""
for i in $(seq 1 40); do
  SERVED="$(curl -sL "https://github.com/$REPO/releases/latest/download/latest.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).version)}catch{process.stdout.write("?")}})')"
  [ "$SERVED" = "$VERSION" ] && break
  sleep 9
done
HTTP="$(curl -s -o /dev/null -w "%{http_code}" -L "$URL")"
echo "  updater serves: $SERVED | installer HTTP: $HTTP"
if [ "$SERVED" != "$VERSION" ]; then
  # CDN still stale — check the source of truth. If the API's Latest release IS
  # this tag with a latest.json asset, the release is correct and the edge cache
  # just hasn't flipped: report OK-with-caveat instead of failing the publish.
  API_TAG="$(gh api "repos/$REPO/releases/latest" --jq .tag_name 2>/dev/null || true)"
  if [ "$API_TAG" = "$TAG" ]; then
    echo "PUBLISH_OK: $TAG is Latest per the GitHub API; the /latest download CDN still serves '$SERVED' and will flip shortly."
    exit 0
  fi
  fail "updater serves '$SERVED', expected '$VERSION' (after ~6min; API Latest is '$API_TAG')"
fi
[ "$HTTP" = "200" ] || fail "installer HTTP $HTTP (expected 200)"
echo "PUBLISH_OK: $TAG live — updater serves $VERSION, installer 200."
