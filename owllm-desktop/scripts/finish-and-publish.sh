#!/usr/bin/env bash
# Rule-based, host-side "finish & publish" — the deterministic release the SOLO path
# fires when the goal says publish, so finishing a release never depends on the model
# choosing to commit/tag/dispatch (which it does unreliably). Works for ANY project
# (the app ships a bundled copy and runs it with --repo-dir against the open repo;
# every knob comes from the committed Project Card). Does, in order:
#   1. bump the patch version in release.versionFile (rolls at 100: 0.6.99→0.7.0)
#   2. stage release.stagePath, commit, push the branch
#   3. tag v<version>, push the tag
#   4a. host mode: run release.command on THIS machine (OwLLM's canonical
#       publish-release.sh when present) — or, with no command at all, a generic
#       `gh release create` on the tag (source + notes).
#   4b. ci mode: stop after the tag push; the repo's GitHub Actions workflow builds
#       and drafts/publishes the release. No local build toolchain / signing cert needed.
# Runs on the HOST (has git auth +, in host mode, the signing key + build toolchain),
# invoked by release.rs::finish_and_publish. Idempotent-ish: if there is nothing to
# commit it still bumps+tags+publishes the current tree.
set -euo pipefail

NOTES=""
PRERELEASE=""
REPO_DIR=""
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
    # The repo to release. Passed by the app when running its BUNDLED copy of
    # this script (the target repo usually doesn't carry the script itself).
    --repo-dir) REPO_DIR="${2:-}"; shift 2 ;;
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

# Repo root: explicit --repo-dir > derived from this script's own location
# (the legacy in-repo layout, <repo>/owllm-desktop/scripts/…).
if [ -n "$REPO_DIR" ]; then
  REPO="$(cd "$REPO_DIR" 2>/dev/null && pwd)" || { echo "PUBLISH_FAILED: repo dir not found: $REPO_DIR" >&2; exit 1; }
else
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO="$(cd "$HERE/../.." && pwd)"
fi
cd "$REPO"

# Stream a verbatim copy of this run to a log so a failure can be diagnosed
# without relying on the app's log view (which truncates or may be closed).
# OwLLM keeps its historical location; any other repo logs under .owllm/.
if [ -d "$REPO/owllm-desktop" ]; then LOG_DIR="$REPO/owllm-desktop/.cache"; else LOG_DIR="$REPO/.owllm"; fi
mkdir -p "$LOG_DIR"
LIVE_LOG="$LOG_DIR/publish-latest.log"
: > "$LIVE_LOG"
exec > >(tee -a "$LIVE_LOG") 2>&1
trap 'cp -f "$LIVE_LOG" "$LOG_DIR/publish-v${NEW:-unknown}.log" 2>/dev/null || true' EXIT

fail() { echo "PUBLISH_FAILED: $*" >&2; exit 1; }

# --- Project Card (.owllm/project.json): per-project release config so this works
#     for ANY project on ANY OS, not just this repo. Defaults preserve the OwLLM
#     behaviour, so a card-less repo still publishes exactly as before. ---
CARD="$REPO/.owllm/project.json"
# Existence-based defaults so a card-less repo of ANY layout still works:
# OwLLM's layout gets its historical behaviour; a plain Tauri or npm repo gets
# its own version file; anything else must set release.versionFile on the card.
VERSION_FILE=""
for cand in "owllm-desktop/src-tauri/tauri.conf.json" "src-tauri/tauri.conf.json" "package.json"; do
  if [ -f "$REPO/$cand" ]; then VERSION_FILE="$cand"; break; fi
done
STAGE_PATH="."
[ -d "$REPO/owllm-desktop" ] && STAGE_PATH="owllm-desktop"
# Default publish command ONLY when the OwLLM pipeline is actually present in
# this repo; otherwise empty → the generic gh-release path in step 4.
PUBLISH_CMD=""
[ -f "$REPO/owllm-desktop/scripts/publish-release.sh" ] && PUBLISH_CMD='bash "owllm-desktop/scripts/publish-release.sh"'
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
# ignore it or error clearly). The generic gh-release path handles it itself.
[ -n "$PRERELEASE" ] && [ "$MODE" = "host" ] && [ -n "$PUBLISH_CMD" ] && PUBLISH_CMD="$PUBLISH_CMD --prerelease"
[ -n "$VERSION_FILE" ] || fail "no version file found (tauri.conf.json / package.json) — set release.versionFile in .owllm/project.json"
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
  // Whitespace-tolerant: "version": "x", "version":"x", etc. — a compact
  // package.json is as valid as a pretty-printed tauri.conf.json.
  const re=new RegExp(`("version"\\s*:\\s*")${process.env.CUR.replace(/\./g,"\\.")}(")`);
  if (!re.test(s)) { console.error("version line not found"); process.exit(3); }
  fs.writeFileSync(process.env.CONF, s.replace(re,`$1${process.env.NEW}$2`));'
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

# No release.command and no OwLLM pipeline in this repo → GENERIC publish:
# a gh release on the tag (source archive + the derived notes). Enough for any
# repo out of the box; set release.command on the Project Card to build and
# attach real artifacts. NB: --repo is only meaningful for split-source/release
# setups whose target repo shares the tag — those should use a custom command.
if [ -z "$PUBLISH_CMD" ]; then
  command -v gh >/dev/null 2>&1 || fail "gh not on PATH — needed for the generic release (or set release.command on the Project Card)"
  CHANNEL_FLAG="--latest"
  [ -n "$PRERELEASE" ] && CHANNEL_FLAG="--prerelease"
  gh release create "$TAG" ${OWLLM_RELEASE_REPO:+--repo "$OWLLM_RELEASE_REPO"} \
    --title "$TAG" --notes "$NOTES_BODY" "$CHANNEL_FLAG" || fail "gh release create $TAG failed"
  echo "PUBLISH_OK: $TAG published (generic gh release — source + notes; set release.command for built artifacts)."
  exit 0
fi

( cd "$REPO" && bash -c "$PUBLISH_CMD" ) || fail "publish command failed: $PUBLISH_CMD"
