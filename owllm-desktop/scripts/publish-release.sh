#!/usr/bin/env bash
# Canonical OwLLM release flow — the SINGLE source of truth for publishing, run
# both by a human and by the Publisher agent (via the publish_release host
# command). It exists because the steps below — especially the minisign signing —
# are finicky (empty-password env + closed stdin; PowerShell mangles it), so an
# LLM shelling them ad-hoc gets it wrong. Encode it once, correctly, here.
#
# Usage:
#   scripts/publish-release.sh --notes "release notes"        # build, sign, publish to Latest
#   scripts/publish-release.sh --notes "..." --dry-run         # build + sign + latest.json, NO gh release (safe rehearsal)
#   scripts/publish-release.sh --notes "..." --draft           # publish as a DRAFT (human flips public)
#
# Version is read from src-tauri/tauri.conf.json (bump + commit + tag BEFORE
# calling this). Requires on PATH: cargo+mingw (build), node/npx (sign), gh (publish).
set -euo pipefail

REPO="OwLLM/owllm"
NOTES=""
DRY_RUN=0
DRAFT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --notes) NOTES="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --draft) DRAFT=1; shift ;;
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
INSTALLER="dist/OwLLM Desktop Setup.exe"
LATEST="dist/latest.json"
URL="https://github.com/$REPO/releases/latest/download/OwLLM.Desktop.Setup.exe"

step() { echo ""; echo "=== $* ==="; }
fail() { echo "PUBLISH_FAILED: $*" >&2; exit 1; }

[ -f "$KEY_FILE" ] || fail "signing key not found at $KEY_FILE (host-only secret — run on the host, not a sandbox)"
command -v node >/dev/null 2>&1 || fail "node/npx not on PATH (needed to sign)"
[ "$DRY_RUN" = 1 ] || command -v gh >/dev/null 2>&1 || fail "gh not on PATH (needed to publish)"

step "1/5 build  (version $VERSION)"
# TS/Rust changes need a fresh bundle; drop the stale installer so a skipped
# relink can't ship an old version string.
rm -f "$INSTALLER" "$INSTALLER.sig"
case "$(uname -s)" in
  # cmd.exe needs the FULL Windows path to the .bat (a relative name or a POSIX
  # "/c/…" path gets mangled by MSYS and silently no-ops). cygpath -w resolves it.
  MINGW*|MSYS*|CYGWIN*)
    WINBAT="$(cygpath -w "$APP/build-release.bat")"
    cmd.exe //c "$WINBAT" || fail "build-release.bat failed"
    ;;
  *) npm run tauri -- build || fail "tauri build failed" ;;  # macOS/Linux native bundle
esac
[ -f "$INSTALLER" ] || fail "build produced no installer at $INSTALLER (build step did not run or failed)"

step "1b/5 authenticode sign (SimplySign / Certum) — must run BEFORE minisign"
# Windows code signing to clear SmartScreen "unknown publisher". Uses the cloud
# cert exposed by SimplySign Desktop (log in first — the virtual card must be
# mounted in the Windows cert store). Configure the cert via, in priority order:
#   OWLLM_SIGN_THUMBPRINT env · OWLLM_SIGN_SUBJECT env · .tauri-keys/authenticode.thumbprint
# Unconfigured → SKIP (installer stays unsigned, today's behaviour). Configured
# but signing fails → FAIL (never ship a "signed" release that isn't). Authenticode
# MUST precede minisign: it rewrites the .exe, which would void the updater sig.
SIGN_THUMBPRINT="${OWLLM_SIGN_THUMBPRINT:-}"
SIGN_SUBJECT="${OWLLM_SIGN_SUBJECT:-}"
SIGN_TSA="${OWLLM_SIGN_TSA:-http://time.certum.pl}"          # Certum RFC3161 timestamp
THUMB_FILE=".tauri-keys/authenticode.thumbprint"
if [ -z "$SIGN_THUMBPRINT" ] && [ -z "$SIGN_SUBJECT" ] && [ -f "$THUMB_FILE" ]; then
  SIGN_THUMBPRINT="$(tr -d ' \r\n\t' < "$THUMB_FILE")"
fi
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    if [ -n "$SIGN_THUMBPRINT" ] || [ -n "$SIGN_SUBJECT" ]; then
      SIGNTOOL="$(command -v signtool.exe 2>/dev/null || true)"
      [ -n "$SIGNTOOL" ] || SIGNTOOL="$(ls -d "/c/Program Files (x86)/Windows Kits/10/bin"/*/x64/signtool.exe 2>/dev/null | sort -r | head -1 || true)"
      [ -n "$SIGNTOOL" ] || fail "signtool.exe not found — install the Windows 10/11 SDK (or put signtool on PATH) to Authenticode-sign"
      WININ="$(cygpath -w "$INSTALLER")"
      if [ -n "$SIGN_THUMBPRINT" ]; then SEL=(/sha1 "$SIGN_THUMBPRINT"); else SEL=(/n "$SIGN_SUBJECT"); fi
      echo "  signing '$INSTALLER'  (${SIGN_THUMBPRINT:+thumbprint ${SIGN_THUMBPRINT}}${SIGN_SUBJECT:+subject \"${SIGN_SUBJECT}\"}, tsa $SIGN_TSA)"
      "$SIGNTOOL" sign "${SEL[@]}" /fd sha256 /tr "$SIGN_TSA" /td sha256 /d "OwLLM Desktop" "$WININ" \
        || fail "signtool sign failed — is SimplySign Desktop running + logged in (cloud key mounted)? Is the thumbprint/subject correct?"
      "$SIGNTOOL" verify /pa "$WININ" || fail "signtool verify failed after signing"
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
npx @tauri-apps/cli signer sign --private-key "$KEY_CONTENT" "$INSTALLER" < /dev/null
SIG="$(cat "$INSTALLER.sig")"
[ "${#SIG}" -ge 200 ] || fail "signature looks wrong (${#SIG} chars)"

step "3/5 latest.json"
SIG="$SIG" NOTES="$NOTES" VERSION="$VERSION" URL="$URL" node -e '
  const fs=require("fs");
  const m={version:process.env.VERSION,notes:process.env.NOTES||("Release "+process.env.VERSION),
    pub_date:new Date().toISOString(),
    platforms:{"windows-x86_64":{signature:process.env.SIG,url:process.env.URL}}};
  fs.writeFileSync("dist/latest.json",JSON.stringify(m,null,2));'

if [ "$DRY_RUN" = 1 ]; then
  echo ""; echo "PUBLISH_DRYRUN_OK: built + signed $VERSION; $INSTALLER + $LATEST ready (gh release skipped)."
  exit 0
fi

step "4/5 gh release ($TAG, $([ "$DRAFT" = 1 ] && echo draft || echo latest))"
LATEST_FLAG="--latest"; [ "$DRAFT" = 1 ] && LATEST_FLAG="--draft"
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" "$INSTALLER" "$LATEST" --repo "$REPO" --clobber
  [ "$DRAFT" = 1 ] || gh release edit "$TAG" --repo "$REPO" --draft=false --latest
else
  gh release create "$TAG" --repo "$REPO" --title "$TAG" --notes "${NOTES:-$TAG}" $LATEST_FLAG "$INSTALLER" "$LATEST"
fi

step "5/5 verify"
if [ "$DRAFT" = 1 ]; then
  echo "PUBLISH_DRAFT_OK: $TAG drafted — flip it public on GitHub when ready."
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
