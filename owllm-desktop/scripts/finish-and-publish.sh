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

CONF="$APP/src-tauri/tauri.conf.json"
[ -f "$CONF" ] || fail "tauri.conf.json not found at $CONF"

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

[ -n "$NOTES" ] || NOTES="v$NEW"
MSG="v$NEW: $NOTES"

# 2. Stage ONLY the app dir (keeps root junk — .claude/, scratch icons — out of the
#    release commit, per the audit rule), commit if there's anything, push the branch.
git add -- "$APP" || fail "git add failed"
if ! git diff --cached --quiet; then
  git commit -q -m "$MSG" || fail "git commit failed"
  echo "committed $(git rev-parse --short HEAD)"
else
  echo "nothing new to commit — publishing current tree at v$NEW"
fi
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git push -q origin "$BRANCH" || fail "git push failed (branch $BRANCH)"

# 3. Tag + push the tag.
git tag -a "v$NEW" -m "$MSG" || fail "git tag v$NEW failed (already exists?)"
git push -q origin "v$NEW" || fail "git push tag v$NEW failed"
echo "tagged v$NEW"

# 4. Canonical build → sign → gh release → verify.
bash "$APP/scripts/publish-release.sh" --notes "$NOTES"
