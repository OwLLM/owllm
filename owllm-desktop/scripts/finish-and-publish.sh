#!/usr/bin/env bash
# Rule-based, host-side "finish & publish" — the deterministic release the SOLO path
# fires when the goal says publish, so finishing a release never depends on the model
# choosing to commit/tag/dispatch (which it does unreliably). Does, in order:
#   1. bump the patch version in src-tauri/tauri.conf.json (rolls at 100: 0.6.99→0.7.0)
#   2. stage ONLY owllm-desktop/ (the app — excludes root scratch/icons/.claude junk),
#      commit, push the branch
#   3. tag v<version>, push the tag
#   4. hand off to the canonical publish-release.sh (build → sign → gh release → verify)
# Runs on the HOST (has git auth + the signing key + Windows build), invoked by
# release.rs::finish_and_publish. Idempotent-ish: if there is nothing to commit it
# still bumps+tags+publishes the current tree.
set -euo pipefail

NOTES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --notes) NOTES="${2:-}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"        # owllm-desktop/
REPO="$(cd "$APP/.." && pwd)"        # repo root
cd "$REPO"

fail() { echo "PUBLISH_FAILED: $*" >&2; exit 1; }

# --- Project Card (.owllm/project.json): per-project release config so this works
#     for ANY project on ANY OS, not just this repo. Defaults preserve the OwLLM
#     behaviour, so a card-less repo still publishes exactly as before. ---
CARD="$REPO/.owllm/project.json"
VERSION_FILE="owllm-desktop/src-tauri/tauri.conf.json"
STAGE_PATH="owllm-desktop"
PUBLISH_CMD='bash "owllm-desktop/scripts/publish-release.sh" --notes "$OWLLM_RELEASE_NOTES"'
if [ -f "$CARD" ]; then
  _rd() { CARD="$CARD" K="$1" node -e 'try{const r=(require(process.env.CARD).release)||{};process.stdout.write(String(r[process.env.K]||""))}catch{}'; }
  vf="$(_rd versionFile)"; sp="$(_rd stagePath)"; pc="$(_rd command)"
  [ -n "$vf" ] && VERSION_FILE="$vf"
  [ -n "$sp" ] && STAGE_PATH="$sp"
  [ -n "$pc" ] && PUBLISH_CMD="$pc"
fi
CONF="$REPO/$VERSION_FILE"
[ -f "$CONF" ] || fail "version file '$VERSION_FILE' not found — set release.versionFile in .owllm/project.json"

# 1. Bump the patch version (string-replace to preserve formatting; rule-based rollover).
CUR="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$CONF")"
NEW="$(CUR="$CUR" node -e '
  let [a,b,p] = process.env.CUR.split(".").map(Number);
  p += 1; if (p >= 100) { p = 0; b += 1; } if (b >= 10) { b = 0; a += 1; }
  process.stdout.write(`${a}.${b}.${p}`);')"
[ -n "$NEW" ] || fail "version bump produced empty result from '$CUR'"
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
# Every release commit this script makes is prefixed "vX.Y.Z: <headline>", so
# recover the human <headline> by STRIPPING that prefix — don't drop the line
# (dropping it discarded the only real info and left the notes as raw git
# shortstat/name-status plumbing, which is what users complained about). Bare
# version-bump commits with no headline collapse to empty and are dropped.
SUBJECTS="$(git log --no-merges --pretty='- %s' "$RANGE" 2>/dev/null \
  | sed -E 's/^- v[0-9]+\.[0-9]+\.[0-9]+:?[[:space:]]*/- /' \
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
export OWLLM_RELEASE_NOTES="$NOTES_BODY"
( cd "$REPO" && bash -c "$PUBLISH_CMD" ) || fail "publish command failed: $PUBLISH_CMD"
