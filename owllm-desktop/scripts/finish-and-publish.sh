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

# gh resolver: host `gh` → WSL sandbox `gh` (the host often has no gh; it lives in the
# provisioned distro). Defines gh()/have_gh(). Falls back to a plain check if the lib
# isn't alongside (e.g. an older bundle, or a foreign repo's own copy of this script).
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$_SCRIPT_DIR/lib/gh.sh" ]; then
  # shellcheck source=lib/gh.sh
  . "$_SCRIPT_DIR/lib/gh.sh"
else
  have_gh() { command -v gh >/dev/null 2>&1; }
fi

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

# One app process already has a backend lease, but separate OwLLM windows (or a
# direct script invocation) are separate processes. Use the repository's common
# Git directory so every worktree and every app instance shares one atomic lock.
GIT_COMMON="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
PUBLISH_LOCK="$GIT_COMMON/owllm-publish.lock"
PUBLISH_LOCK_OWNER="$PUBLISH_LOCK/owner"
claim_publish_lock() {
  if mkdir "$PUBLISH_LOCK" 2>/dev/null; then
    printf '%s\n%s\n' "$$" "$(date +%s)" > "$PUBLISH_LOCK_OWNER"
    return
  fi

  local owner=""
  [ -f "$PUBLISH_LOCK_OWNER" ] && owner="$(sed -n '1p' "$PUBLISH_LOCK_OWNER" 2>/dev/null || true)"
  if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
    echo "PUBLISH_FAILED: another publish is already running for this repository (pid $owner)." >&2
    exit 1
  fi

  # The prior publisher died without running its EXIT trap. Rename the stale
  # directory atomically; only one contender can recover it and claim the lock.
  local stale="${PUBLISH_LOCK}.stale.$$"
  if ! mv "$PUBLISH_LOCK" "$stale" 2>/dev/null; then
    echo "PUBLISH_FAILED: another publish is already starting for this repository." >&2
    exit 1
  fi
  rm -f "$stale/owner"
  rmdir "$stale" 2>/dev/null || true
  if ! mkdir "$PUBLISH_LOCK" 2>/dev/null; then
    echo "PUBLISH_FAILED: another publish won the repository lock." >&2
    exit 1
  fi
  printf '%s\n%s\n' "$$" "$(date +%s)" > "$PUBLISH_LOCK_OWNER"
}
release_publish_lock() {
  local owner=""
  [ -f "$PUBLISH_LOCK_OWNER" ] && owner="$(sed -n '1p' "$PUBLISH_LOCK_OWNER" 2>/dev/null || true)"
  if [ "$owner" = "$$" ]; then
    rm -f "$PUBLISH_LOCK_OWNER"
    rmdir "$PUBLISH_LOCK" 2>/dev/null || true
  fi
}
claim_publish_lock
trap release_publish_lock EXIT

# Stream a verbatim copy of this run to a log so a failure can be diagnosed
# without relying on the app's log view (which truncates or may be closed).
# OwLLM keeps its historical location; any other repo logs under .owllm/.
if [ -d "$REPO/owllm-desktop" ]; then LOG_DIR="$REPO/owllm-desktop/.cache"; else LOG_DIR="$REPO/.owllm"; fi
mkdir -p "$LOG_DIR"
LIVE_LOG="$LOG_DIR/publish-latest.log"
: > "$LIVE_LOG"
exec > >(tee -a "$LIVE_LOG") 2>&1
on_publish_exit() {
  cp -f "$LIVE_LOG" "$LOG_DIR/publish-v${NEW:-unknown}.log" 2>/dev/null || true
  release_publish_lock
}
trap on_publish_exit EXIT

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

[ "$MODE" = "host" ] && preflight_host_disk "$REPO"

# Release commits must contain ONLY the deterministic version bump produced by
# this script. If real app changes are already dirty, `git add $STAGE_PATH` would
# fold them into the `vX.Y.Z` bump commit. The notes generator intentionally
# drops release commits (to avoid old stale-app chat prompts leaking into
# What's New), so those real changes would disappear from the release notes and
# users would see "Maintenance release". Force the work to be committed first
# with a human subject, then publish.
# Cargo.lock is EXCLUDED: it's a generated file whose only churn here is the
# version line, which a prior (often crashed) host build bumps and strands
# uncommitted. That is never "real work" for What's New, and blocking on it
# turns every release into a treadmill (build bumps lock → lock dirty → next
# publish blocked). The bump commit still re-stages it via `git add $STAGE_PATH`.
# On Windows, release metadata can remain stat-dirty after a tool rewrites the
# exact bytes already in the index. Plain `git status` reports that as modified
# even though `git diff` is empty, blocking Publish forever. `--really-refresh`
# re-hashes those entries before we decide whether real work is pending. Its
# non-zero exit is expected when genuine changes exist; the scoped status below
# still reports and blocks those changes.
git update-index -q --really-refresh >/dev/null 2>&1 || true
PENDING_STAGE="$(git status --porcelain -- "$STAGE_PATH" ':(exclude)*Cargo.lock' 2>/dev/null || true)"
if [ -n "$PENDING_STAGE" ]; then
  echo "PUBLISH_FAILED: uncommitted release changes under '$STAGE_PATH' would be hidden inside the version-bump commit." >&2
  echo "Commit/merge those changes first with a meaningful message, then run Publish again." >&2
  echo "Pending changes:" >&2
  printf '%s\n' "$PENDING_STAGE" | sed 's/^/  /' | head -40 >&2
  exit 1
fi

# 1a. Sync with origin BEFORE bumping. The version math below already respects the
# public release floor, but the push at step 2 is rejected outright if
# origin/<branch> moved (this shared tree IS pushed to by concurrent sessions —
# v0.8.88 stranded exactly this way when a parallel v0.8.87 release landed
# mid-publish). Rebase local work onto the remote now, while no release commit
# exists yet; --autostash carries the tolerated dirty Cargo.lock across. A
# conflict here is real divergent work — fail cleanly before bumping anything.
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if git fetch -q origin "$BRANCH" 2>/dev/null; then
  if ! git rebase --autostash "origin/$BRANCH" >/dev/null 2>&1; then
    git rebase --abort >/dev/null 2>&1 || true
    fail "origin/$BRANCH has diverged with conflicts — reconcile it (merge/rebase), then run Publish again"
  fi
else
  echo "WARN: could not fetch origin/$BRANCH — publishing from the local view only"
fi

# 1. Bump the patch version (string-replace to preserve formatting; rule-based rollover).
CUR="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$CONF")"

# The PUBLIC release chronology is the source of truth for the version floor, not
# just this checkout's file. A stale checkout (e.g. one whose tauri.conf.json still
# says 0.8.43 while 0.8.48 is already public) must NEVER regress or re-issue a
# number — so we take max(local, latest published) and bump from there. Pull the
# published release tags from release.repo (OWLLM_RELEASE_REPO). Non-fatal if gh is
# missing/unauthed or the repo has no releases yet: we warn and fall back to the
# local file, preserving the previous behaviour for card-less / offline runs.
PUBLISHED_TAGS=""
if [ -n "${OWLLM_RELEASE_REPO:-}" ] && have_gh; then
  PUBLISHED_TAGS="$(gh release list --repo "$OWLLM_RELEASE_REPO" --limit 100 \
    --json tagName --jq '.[].tagName' 2>/dev/null || true)"
  if [ -n "$PUBLISHED_TAGS" ]; then
    echo "published-release floor: newest tag on $OWLLM_RELEASE_REPO = $(printf '%s\n' "$PUBLISHED_TAGS" | head -1)"
  else
    echo "WARN: no published releases on $OWLLM_RELEASE_REPO (or gh not authed) — bumping from local file '$VERSION_FILE' only"
  fi
else
  echo "WARN: OWLLM_RELEASE_REPO unset or gh missing — bumping from local file '$VERSION_FILE' only"
fi

# Base = max(local file, every published tag); then rule-based rollover (+1 patch,
# rolls at 100 → minor, at 10 → major), matching the odometer-100 scheme.
_BUMP="$(CUR="$CUR" PUBLISHED_TAGS="$PUBLISHED_TAGS" node -e '
  const parse = v => { const m = String(v).trim().replace(/^v/,"").match(/^(\d+)\.(\d+)\.(\d+)/); return m ? [ +m[1], +m[2], +m[3] ] : null; };
  const cmp = (x,y) => x[0]-y[0] || x[1]-y[1] || x[2]-y[2];
  let base = parse(process.env.CUR);
  if (!base) { console.error("bad local version: " + process.env.CUR); process.exit(3); }
  for (const line of (process.env.PUBLISHED_TAGS || "").split("\n")) {
    const v = parse(line); if (v && cmp(v, base) > 0) base = v;
  }
  let [a,b,p] = base;
  p += 1; if (p >= 100) { p = 0; b += 1; } if (b >= 10) { b = 0; a += 1; }
  process.stdout.write(`${base.join(".")} ${a}.${b}.${p}`);')"
# read from a herestring (always newline-terminated) — a process substitution
# whose node ends with a newline-less stdout.write makes `read` return 1 at EOF
# even though it populated the vars, which `set -e` then treats as fatal. The
# $() capture above still surfaces a genuine node failure (exit 3) as a hard error.
read -r BASE NEW <<< "$_BUMP"
[ -n "$NEW" ] || fail "version bump produced empty result from '$CUR'"
[ "$BASE" != "$CUR" ] && echo "NOTE: local file '$VERSION_FILE' was $CUR but public floor is $BASE — bumping from the public floor"
TAG="v$NEW"

# Set the PRIMARY version file to NEW. Absolute-set (match whatever version is
# currently there) so it heals even if the file had drifted below the public floor.
NEW="$NEW" CONF="$CONF" node -e '
  const fs=require("fs");
  let s=fs.readFileSync(process.env.CONF,"utf8");
  // Whitespace-tolerant: "version": "x", "version":"x", etc. — a compact
  // package.json is as valid as a pretty-printed tauri.conf.json.
  const re=/("version"\s*:\s*")([^"]+)(")/;
  if (!re.test(s)) { console.error("version line not found"); process.exit(3); }
  fs.writeFileSync(process.env.CONF, s.replace(re,`$1${process.env.NEW}$3`));'
echo "version $CUR -> $NEW"

# Keep sibling version files in lockstep so NO tool ever reads a stale number.
# The bumper historically touched only tauri.conf.json, leaving the Rust crate's
# Cargo.toml to drift (it sat at 0.8.47 while the app shipped 0.8.48) — every
# `cargo metadata`/grep then reported the wrong version and looked like the repo
# "wasn't on" the released version. Heal it here: set the [package] version to NEW
# regardless of what it currently says. Only the [package] section is touched, so
# dependency versions are never affected.
CARGO="$(dirname "$CONF")/Cargo.toml"
if [ -f "$CARGO" ] && [ "$(basename "$CONF")" != "Cargo.toml" ]; then
  NEW="$NEW" CARGO="$CARGO" node -e '
    const fs=require("fs");
    let s=fs.readFileSync(process.env.CARGO,"utf8");
    // Anchor to the [package] table, then its first version key; [^\[]*? keeps the
    // match inside that table (never crosses into another [section]).
    const re=/(\[package\][^\[]*?\bversion\s*=\s*")([^"]+)(")/;
    const m=s.match(re);
    if (m) {
      fs.writeFileSync(process.env.CARGO, s.replace(re, `$1${process.env.NEW}$3`));
      console.error(`Cargo.toml [package] version ${m[2]} -> ${process.env.NEW}`);
    } else {
      console.error("WARN: Cargo.toml has no [package] version — left unchanged");
    }'
fi

# Cargo.lock records the workspace package version too. Update that generated
# entry before the release commit so the tag, Cargo metadata, and lockfile stay
# aligned; otherwise the subsequent local build rewrites Cargo.lock and leaves
# a misleading dirty tree after every publish.
LOCK="$(dirname "$CONF")/Cargo.lock"
if [ -f "$LOCK" ] && [ "$(basename "$CONF")" != "Cargo.lock" ]; then
  NEW="$NEW" LOCK="$LOCK" node -e '
    const fs=require("fs");
    let s=fs.readFileSync(process.env.LOCK,"utf8");
    const re=/(\[\[package\]\]\s+name = "owllm-desktop"\s+version = ")([^"]+)(")/;
    if (re.test(s)) {
      fs.writeFileSync(process.env.LOCK, s.replace(re, `$1${process.env.NEW}$3`));
    } else {
      console.error("WARN: Cargo.lock has no owllm-desktop package entry — left unchanged");
    }'
fi

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
# The push can still race a session that pushed AFTER the 1a sync. The bump
# commit is deterministic and version-file-scoped, so rebase it onto the fresh
# remote and retry instead of dying on "fetch first". A conflict means the
# remote grew its own release commit — that needs eyes, so fail cleanly.
_PUSH_OK=""
for _try in 1 2 3; do
  if git push -q origin "$BRANCH"; then _PUSH_OK=1; break; fi
  echo "push rejected (attempt $_try/3): origin/$BRANCH moved — rebasing the release commit and retrying"
  git fetch -q origin "$BRANCH" 2>/dev/null || true
  if ! git rebase --autostash "origin/$BRANCH" >/dev/null 2>&1; then
    git rebase --abort >/dev/null 2>&1 || true
    fail "git push failed (branch $BRANCH): remote moved and the release commit does not rebase cleanly"
  fi
done
[ -n "$_PUSH_OK" ] || fail "git push failed (branch $BRANCH) after 3 attempts"

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
# Any pre-existing v$NEW tag (local or on origin) is debris from a crashed
# publish: when the published floor is known, NEW is computed strictly ABOVE
# every published release tag, so v$NEW can never name a shipped release.
# Clear both copies, else the re-tag or the tag push collides and strands the
# release AGAIN (v0.8.88 died at "git push tag": origin still held the same
# tag from the previous crashed run, pointing at the abandoned commit).
# Guarded on PUBLISHED_TAGS: without the public floor the above-all-releases
# proof doesn't hold, so never touch remote tags in gh-less/offline runs.
if [ -n "$PUBLISHED_TAGS" ]; then
  git tag -d "v$NEW" >/dev/null 2>&1 || true
  git push -q origin ":refs/tags/v$NEW" >/dev/null 2>&1 || true
fi
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
  have_gh || fail "gh not on PATH — needed for the generic release (or set release.command on the Project Card)"
  CHANNEL_FLAG="--latest"
  [ -n "$PRERELEASE" ] && CHANNEL_FLAG="--prerelease"
  gh release create "$TAG" ${OWLLM_RELEASE_REPO:+--repo "$OWLLM_RELEASE_REPO"} \
    --title "$TAG" --notes "$NOTES_BODY" "$CHANNEL_FLAG" || fail "gh release create $TAG failed"
  echo "PUBLISH_OK: $TAG published (generic gh release — source + notes; set release.command for built artifacts)."
  exit 0
fi

( cd "$REPO" && bash -c "$PUBLISH_CMD" ) || fail "publish command failed: $PUBLISH_CMD"
