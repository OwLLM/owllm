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

REPO="OwLLM/owllm"
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

VERSION="$(node -e 'process.stdout.write(require("./src-tauri/tauri.conf.json").version)')"
TAG="v$VERSION"
KEY_FILE=".tauri-keys/owllm-updater.key"
LATEST="dist/latest.json"

# ---- per-platform artifact map -------------------------------------------
# One script, three OSes. INSTALLER = the human-download asset (stable name),
# UPDATER_ARTIFACT = what minisign signs and latest.json points at.
# Windows keeps its historical /latest/ URL (unchanged behaviour); macOS and
# Linux use VERSIONED URLs so a later Windows-only publish can never leave a
# platform key pointing at an asset that no longer matches its signature.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) HOST_OS="windows" ;;
  Darwin)               HOST_OS="macos" ;;
  *)                    HOST_OS="linux" ;;
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
    INSTALLER="dist/OwLLM.Desktop.AppImage"
    UPDATER_ARTIFACT="$INSTALLER"   # Tauri's Linux updater consumes the AppImage
    URL="https://github.com/$REPO/releases/download/$TAG/OwLLM.Desktop.AppImage"
    ;;
esac

step() { echo ""; echo "=== $* ==="; }
fail() { echo "PUBLISH_FAILED: $*" >&2; exit 1; }

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
[ "$DRY_RUN" = 1 ] || command -v gh >/dev/null 2>&1 || fail "gh not on PATH (needed to publish)"

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

step "0b/5 payload sign — every exe/dll bundled under resources/ must be signed"
# Unsigned binaries INSIDE an EV-signed installer are a classic SmartScreen /
# Defender heuristic trigger (bit us with the whisper.cpp runtime). Sign any
# unsigned exe/dll the bundle will carry, with the same cert as the installer.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    if [ -n "$SIGN_THUMBPRINT" ] || [ -n "$SIGN_SUBJECT" ]; then
      SIGNTOOL="$(command -v signtool.exe 2>/dev/null || true)"
      [ -n "$SIGNTOOL" ] || SIGNTOOL="$(ls -d "/c/Program Files (x86)/Windows Kits/10/bin"/*/x64/signtool.exe 2>/dev/null | sort -r | head -1 || true)"
      [ -n "$SIGNTOOL" ] || fail "signtool.exe not found — install the Windows 10/11 SDK (or put signtool on PATH)"
      if [ -n "$SIGN_THUMBPRINT" ]; then SEL=(/sha1 "$SIGN_THUMBPRINT"); else SEL=(/n "$SIGN_SUBJECT"); fi
      PAYLOAD_SIGNED=0
      while IFS= read -r bin; do
        WBIN="$(cygpath -w "$bin")"
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
  node "$APP/scripts/smoke-matrix.mjs" $SMOKE_ARGS \
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
    WINBAT="$(cygpath -w "$APP/build-release.bat")"
    cmd.exe //c "$WINBAT" || fail "build-release.bat failed"
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
      cp -f "$BUNDLE"/deb/*.deb dist/OwLLM.Desktop.deb 2>/dev/null || true
      cp -f "$BUNDLE"/rpm/*.rpm dist/OwLLM.Desktop.rpm 2>/dev/null || true
    fi
    ;;
esac
[ -f "$INSTALLER" ] || fail "build produced no installer at $INSTALLER (build step did not run or failed)"
[ -f "$UPDATER_ARTIFACT" ] || fail "no updater artifact at $UPDATER_ARTIFACT"

step "1b/5 authenticode sign (SimplySign / Certum) — must run BEFORE minisign"
# Windows code signing to clear SmartScreen "unknown publisher". Uses the cloud
# cert exposed by SimplySign Desktop (log in first — the virtual card must be
# mounted in the Windows cert store). Configure the cert via, in priority order:
#   OWLLM_SIGN_THUMBPRINT env · OWLLM_SIGN_SUBJECT env · .tauri-keys/authenticode.thumbprint
# Unconfigured → SKIP (installer stays unsigned, today's behaviour). Configured
# but signing fails → FAIL (never ship a "signed" release that isn't). Authenticode
# MUST precede minisign: it rewrites the .exe, which would void the updater sig.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    if [ -n "$SIGN_THUMBPRINT" ] || [ -n "$SIGN_SUBJECT" ]; then
      SIGNTOOL="$(command -v signtool.exe 2>/dev/null || true)"
      [ -n "$SIGNTOOL" ] || SIGNTOOL="$(ls -d "/c/Program Files (x86)/Windows Kits/10/bin"/*/x64/signtool.exe 2>/dev/null | sort -r | head -1 || true)"
      [ -n "$SIGNTOOL" ] || fail "signtool.exe not found — install the Windows 10/11 SDK (or put signtool on PATH) to Authenticode-sign"
      WININ="$(cygpath -w "$INSTALLER")"
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
KEY_CONTENT="$(cat "$KEY_FILE")"
npx @tauri-apps/cli signer sign --private-key "$KEY_CONTENT" "$UPDATER_ARTIFACT" < /dev/null
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
for extra in dist/OwLLM.Desktop.deb dist/OwLLM.Desktop.rpm; do
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
# Poll: GitHub's /latest CDN can lag a few seconds behind `gh release create`,
# so checking once right after publishing false-fails. Retry up to ~60s.
SERVED=""
for i in $(seq 1 20); do
  SERVED="$(curl -sL "https://github.com/$REPO/releases/latest/download/latest.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).version)}catch{process.stdout.write("?")}})')"
  [ "$SERVED" = "$VERSION" ] && break
  sleep 3
done
HTTP="$(curl -s -o /dev/null -w "%{http_code}" -L "$URL")"
echo "  updater serves: $SERVED | installer HTTP: $HTTP"
[ "$SERVED" = "$VERSION" ] || fail "updater serves '$SERVED', expected '$VERSION' (after ~60s of polling)"
[ "$HTTP" = "200" ] || fail "installer HTTP $HTTP (expected 200)"
echo "PUBLISH_OK: $TAG live — updater serves $VERSION, installer 200."
