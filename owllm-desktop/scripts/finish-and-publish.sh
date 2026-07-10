#!/usr/bin/env bash
# Rule-based, host-side "finish & publish" — the deterministic release the SOLO path
# fires when the goal says publish, so finishing a release never depends on the model
# choosing to commit/tag/dispatch (which it does unreliably). Does, in order:
#   1. bump the patch version in src-tauri/tauri.conf.json (rolls at 100: 0.6.99→0.7.0)
#   2. stage ONLY owllm-desktop/ (the app — excludes root scratch/icons/.claude junk),
#      commit, push the branch
#   3. tag v<version>, push the tag
#   4a. host mode (default): hand off to the canonical publish-release.sh
#       (build → sign → gh release → verify) on THIS machine.
#   4b. ci mode: stop after the tag push; the repo's GitHub Actions workflow builds
#       and drafts/publishes the release. No local build toolchain / signing cert needed.
# Runs on the HOST (has git auth +, in host mode, the signing key + Windows build),
# invoked by release.rs::finish_and_publish. Idempotent-ish: if there is nothing to
# commit it still bumps+tags+publishes the current tree.
set -euo pipefail

NOTES=""
PRERELEASE=""
# Build-mode resolution: explicit --mode > Project Card release.mode > host.
# MODE_SET tracks whether the caller CHOSE — an empty default here would
# otherwise be indistinguishable from an explicit host pick, and the card
# could never be overridden (or honored) correctly.
MODE="host"
MODE_SET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --notes) NOTES="${2:-}"; shift 2 ;;
    # Publish to the PRE-RELEASE channel (public + downloadable, but NOT /latest,
    # so the auto-updater skips it). The "test before you promote" path — nothing
    # reaches users until the release is flipped to Latest.
    --prerelease) PRERELEASE=1; shift ;;
    --mode) MODE="${2:-host}"; MODE_SET=1; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Normalize mode so typos default to the safe, explicit CI path rather than
# accidentally running a local build.
case "${MODE,,}" in
  host) MODE="host" ;;
  ci|github|actions) MODE="ci" ;;
  *) echo "unknown mode '$MODE' — use 'host' or 'ci'" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"        # owllm-desktop/
REPO="$(cd "$APP/.." && pwd)"        # repo root
cd "$REPO"

# Stream a verbatim copy of this run to .cache so a failure can be diagnosed
# without relying on the app's log view (which truncates or may be closed).
mkdir -p "$APP/.cache"
LIVE_LOG="$APP/.cache/publish-latest.log"
: > "$LIVE_LOG"
exec > >(tee -a "$LIVE_LOG") 2>&1
trap 'cp -f "$LIVE_LOG" "$APP/.cache/publish-v${NEW:-unknown}.log" 2>/dev/null || true' EXIT

fail() { echo "PUBLISH_FAILED: $*" >&2; exit 1; }

# --- Project Card (.owllm/project.json): per-project release config so this works
#     for ANY project on ANY OS, not just this repo. Defaults preserve the OwLLM
#     behaviour, so a card-less repo still publishes exactly as before. ---
CARD="$REPO/.owllm/project.json"
VERSION_FILE="owllm-desktop/src-tauri/tauri.conf.json"
STAGE_PATH="owllm-desktop"
PUBLISH_CMD='bash "owllm-desktop/scripts/publish-release.sh"'
if [ -f "$CARD" ]; then
  _rd() { CARD="$CARD" K="$1" node -e 'try{const r=(require(process.env.CARD).release)||{};process.stdout.write(String(r[process.env.K]||""))}catch{}'; }
  _rds() { CARD="$CARD" K="$1" node -e 'try{const s=((require(process.env.CARD).release)||{}).sign||{};process.stdout.write(String(s[process.env.K]||""))}catch{}'; }
  vf="$(_rd versionFile)"; sp="$(_rd stagePath)"; pc="$(_rd command)"; rr="$(_rd repo)"
  # Build mode: the committed card's release.mode is the FALLBACK when the
  # caller passed no --mode (explicit arg > card > host default). This is what
  # makes the mode configured on the publisher card actually take effect on a
  # machine with no local override.
  if [ -z "$MODE_SET" ]; then
    cm="$(_rd mode)"
    case "${cm,,}" in
      host) MODE="host" ;;
      ci|github|actions) MODE="ci" ;;
    esac
    [ -n "$cm" ] && echo "build mode from Project Card: $MODE"
  fi
  [ -n "$vf" ] && VERSION_FILE="$vf"
  [ -n "$sp" ] && STAGE_PATH="$sp"
  [ -n "$pc" ] && PUBLISH_CMD="$pc"
  # release.repo — the gh target ("owner/name"). Exported so the publish command
  # (canonical publish-release.sh or a card override) targets the card's repo
  # instead of a hardcoded default. Caller env wins.
  [ -z "${OWLLM_RELEASE_REPO:-}" ] && [ -n "$rr" ] && export OWLLM_RELEASE_REPO="$rr"
  # Project Card can also commit the signing cert selector so teammates/machines share it.
  # Env vars from the caller (release.rs) take precedence.
  [ -z "${OWLLM_SIGN_THUMBPRINT:-}" ] && OWLLM_SIGN_THUMBPRINT="$(_rds thumbprint)"
  [ -z "${OWLLM_SIGN_SUBJECT:-}" ] && OWLLM_SIGN_SUBJECT="$(_rds subject)"
  [ -z "${OWLLM_SIGN_TSA:-}" ] && OWLLM_SIGN_TSA="$(_rds tsa)"
fi
# In CI mode the release is built by GitHub Actions, so we never run the local
# publish command. Evaluated AFTER the card block — the card can be what flips
# the mode to ci. The signing env vars are still meaningful in host mode: they
# are inherited by publish-release.sh which reads OWLLM_SIGN_THUMBPRINT etc.
[ "$MODE" = "ci" ] && PUBLISH_CMD=""
# Forward the pre-release channel to the publish command (the canonical
# publish-release.sh understands --prerelease; a card override that doesn't will
# ignore it or error clearly).
[ -n "$PRERELEASE" ] && [ "$MODE" = "host" ] && PUBLISH_CMD="$PUBLISH_CMD --prerelease"
CONF="$REPO/$VERSION_FILE"
[ -f "$CONF" ] || fail "version file '$VERSION_FILE' not found — set release.versionFile in .owllm/project.json"

# 1. Bump the patch version (string-replace to preserve formatting; rule-based rollover).
CUR="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$CONF")"
NEW="$(CUR="$CUR" node -e '
  let [a,b,p] = process.env.CUR.split(".").map(Number);
  p += 1; if (p >= 100) { p = 0; b += 1; } if (b >= 10) { b = 0; a += 1; }
  process.stdout.write(`${a}.${b}.${p}`);')"
[ -n "$NEW" ] || fail "version bump produced empty result from '$CUR'"
TAG="v$NEW"
CUR="$CUR" NEW="$NEW" CONF="$CONF" node -e '
  const fs=require("fs");
  let s=fs.readFileSync(process.env.CONF,"utf8");
  const a=`"version": "${process.env.CUR}"`, b=`"version": "${process.env.NEW}"`;
  if (!s.includes(a)) { console.error("version line not found"); process.exit(3); }
  fs.writeFileSync(process.env.CONF, s.replace(a,b));'
echo "version $CUR -> $NEW"

# Headline from the caller — but DROP a bare "publish it" / "ship" / "release"
# command. The release body must describe what SHIPPED, not echo the chat message
# the user typed to the agents (that was the old, useless behaviour).
HEADLINE="$(printf '%s' "$NOTES" | head -1)"
_squash="$(printf '%s' "$HEADLINE" | tr 'A-Z' 'a-z' | tr -d '[:space:][:punct:]')"
case "$_squash" in
  ""|publish|publishit|publishthis|publishthechanges|publishthechange|publishnow|shipit|ship|release|releaseit|releasenow|deploy|deployit|makearelease|publishrelease|pushit|publishplease) HEADLINE="" ;;
esac
MSG="v$NEW${HEADLINE:+: $HEADLINE}"

# 2. Stage ONLY the app dir (keeps root junk — .claude/, scratch icons — out of the
#    release commit, per the audit rule), commit if there's anything, push the branch.
git add -- "$REPO/$STAGE_PATH" || fail "git add failed"
if ! git diff --cached --quiet; then
  git commit -q -m "$MSG" || fail "git commit failed"
  echo "committed $(git rev-parse --short HEAD)"
else
  echo "nothing new to commit — publishing current tree at v$NEW"
fi
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git push -q origin "$BRANCH" || fail "git push failed (branch $BRANCH)"

# 2b. Build a HUMAN release changelog from the actual commit subjects (what really
#     shipped), not the chat message and NOT git file-plumbing. PREV_TAG = the
#     previous release (HEAD isn't tagged yet).
PREV_TAG="$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)"
if [ -n "$PREV_TAG" ]; then RANGE="$PREV_TAG..HEAD"; else RANGE="HEAD~5..HEAD"; fi
# The changelog is built from REAL work-commit subjects (conventional commits
# like "fix(release): …" / "feat: …"), NOT from the "vX.Y.Z: <headline>" release
# commits this script makes. Those release headlines have repeatedly carried the
# user's raw chat prompt — a STALE app build (built before the UI stopped doing
# it) still passes the chat text as --notes, which becomes the release commit
# subject. Recovering that headline leaked the prompt straight into "What's New".
# So DROP every vX.Y.Z release commit outright. This is enforced host-side at
# publish time, so it holds no matter which app build triggered the release and
# also strips already-poisoned historical release commits out of the range. If no
# real work commits remain, NOTES_BODY falls back to a clean "Maintenance release".
SUBJECTS="$(git log --no-merges --pretty='- %s' "$RANGE" 2>/dev/null \
  | grep -vE '^- v[0-9]+\.[0-9]+\.[0-9]+([:[:space:]]|$)' \
  | grep -vE '^-[[:space:]]*$' \
  | head -20 || true)"
#     The release body is a clean "what's new" list only — never the git
#     file-plumbing (shortstat / name-status) and never the user's chat message
#     ($HEADLINE, which is for the git commit/tag subject alone).
if [ -n "$SUBJECTS" ]; then
  NOTES_BODY="$SUBJECTS"
else
  NOTES_BODY="Maintenance release v$NEW."
fi
echo "release notes:"; printf '%s\n' "$NOTES_BODY" | sed 's/^/  | /'

# 3. Tag + push the tag.
git tag -a "v$NEW" -m "$MSG" || fail "git tag v$NEW failed (already exists?)"
git push -q origin "v$NEW" || fail "git push tag v$NEW failed"
echo "tagged v$NEW"

# 4. Run the project's publish command (default = the canonical OwLLM
#    publish-release.sh: build → sign → gh release → verify). The generated notes
#    are passed via $OWLLM_RELEASE_NOTES so any project's command can use them.
if [ "$MODE" = "ci" ]; then
  if [ -f "$REPO/.github/workflows/release.yml" ]; then
    echo "CI mode: tag pushed — GitHub Actions workflow will build and publish the release."
  else
    echo "CI mode: tag pushed — no .github/workflows/release.yml found; you must trigger/build the release manually."
  fi
  echo "PUBLISH_OK: $TAG pushed for CI build."
  exit 0
fi

export OWLLM_RELEASE_NOTES="$NOTES_BODY"
export OWLLM_SIGN_THUMBPRINT OWLLM_SIGN_SUBJECT OWLLM_SIGN_TSA
( cd "$REPO" && bash -c "$PUBLISH_CMD" ) || fail "publish command failed: $PUBLISH_CMD"
