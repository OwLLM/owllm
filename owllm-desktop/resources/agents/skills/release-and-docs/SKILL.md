---
name: Release and Docs
description: How to ship a signed OwLLM release end-to-end and keep the docs + GitHub Pages current.
triggers:
  - release
  - publish
  - ship
  - deploy
  - version
  - changelog
---

# Release and Docs

You SHIP and you DOCUMENT. Both end in a verified result, never "ready to".

## Shipping a release (the only correct sequence)
1. **Bump the version** in `owllm-desktop/src-tauri/tauri.conf.json` — patch rolls at 100 (`0.6.99 → 0.7.0`, never `0.6.100`). Pick the next version above the latest `git tag`.
2. **Commit, push, tag** with the shell/git tools: commit the bump + changes, `git push`, then create and `git push` the `vX.Y.Z` tag.
3. **Rehearse**: call `publish_release` with `dry_run='true'`. It builds + signs + writes `latest.json` but does NOT publish. Confirm the log ends with `PUBLISH_DRYRUN_OK`. If it fails, fix the real cause first.
4. **Publish**: call `publish_release` (no dry_run, with `notes`). It builds → minisign-signs → creates the GitHub release as **Latest** → verifies the updater + installer. It is done ONLY when the log contains **`PUBLISH_OK`** (updater serves the new version, installer HTTP 200).
5. If it returns a failure, read the tail, fix it, retry. NEVER report a release you didn't watch reach `PUBLISH_OK`.

Do not hand-run `cargo` / the signer / `gh` yourself — `publish_release` runs the vetted `scripts/publish-release.sh` on the host and gets the finicky signing right. One tool call.

## Keeping docs true to what shipped
- **README** (`OwLLM/owllm` repo): update the "✨ Recent highlights" section and the collapsible changelog table — one row per shipped version, current and visual.
- **In-repo docs** under `docs/`: update any page a change affects. Verify behaviour with `read_file`/`grep` before you write about it — never from memory.
- **GitHub Pages**: the site serves from the `docs/` folder. Edit the relevant pages there and commit + push so Pages redeploys. Keep it accurate and current.

## Rules
- "Done" = verified: `PUBLISH_OK` for a release; the doc actually written **and pushed** for docs.
- A genuine tool failure is the only acceptable "not done" — report the exact error + what you tried.
- Stay in your lane: you don't write product code; you ship it and document it.
