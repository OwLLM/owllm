//! Which worktree paths are OWLLM's own runtime churn rather than user work.
//!
//! Split out of `fleet.rs` for one reason: this is the single predicate that
//! decides whether a page may run a model (the refresh gate) and what a Sync is
//! allowed to commit (`unstage_app_scratch`), and every bug it has ever had was
//! a directory it did not recognise. `fleet.rs` cannot be unit-tested on
//! Windows — the lib-test binary aborts with `STATUS_ENTRYPOINT_NOT_FOUND`
//! before a single test runs — so the guard lived in a harness that never
//! executed. This file has NO dependencies, so `fleetScratch.verify.run.mjs`
//! compiles it alone with `rustc --test` and the guard actually runs.
//!
//! Keep it dependency-free. An import here re-breaks that.

/// Name given to a cache directory that has been renamed out of the way but not
/// yet fully deleted. Deliberately not a build-cache name, so no build ever
/// mistakes it for one, and deliberately dot-prefixed so it sorts out of sight.
pub(crate) const QUARANTINE_PREFIX: &str = ".owllm-reclaimed-";

/// App-managed runtime files that must NEVER wedge the worktree workflow. These
/// are tracked in some repos and the app
/// rewrites them, so a `git status` on the source is perpetually "dirty" through
/// no fault of the user — which used to make EVERY `fleet_worktree_create` bounce
/// with DirtyWorkingTree. Deliberately do not classify the whole `.owllm/`
/// directory as scratch: Project Cards, verify config, skills, and media assets
/// are durable project data which users must be able to commit and share.
pub(crate) fn is_app_scratch(path: &str) -> bool {
    let p = path.trim().trim_start_matches("./").replace('\\', "/");
    p == ".owllm-inbox"
        || p.starts_with(".owllm-inbox/")
        || p == ".owllm/brainstorm.json"
        || p == ".owllm/eval-traces.jsonl"
        // npm staged-install scratch: external tooling stages packages in
        // `node_modules.partial/` before renaming into `node_modules/`. A run
        // caught mid-install left it behind as `??` and the refresh gate then
        // refused every model run as "pending edits" (it even got committed
        // once by a Sync — see a0936085). Never user work; also gitignored.
        || p.split('/').any(|seg| seg == "node_modules.partial")
        // Disk-janitor quarantine: `reclaim_cache_dir` renames a build cache to
        // a `.owllm-reclaimed-<stamp>/` sibling before deleting it, so a locked
        // file can never leave a half-gutted `node_modules` behind. The rename
        // moves thousands of files OUT of the `node_modules/` ignore rule in one
        // step, and `.owllm-reclaimed-*/` was only gitignored under
        // `owllm-desktop/` — so in any other subproject the whole cache
        // instantly read as untracked "pending edits" and the refresh gate
        // refused every model run. A Sync then COMMITTED it (a6080592 captured
        // `owllm-website/.owllm-reclaimed-1786307988/@rollup/…node`), the
        // janitor deleted the directory, and the page was stuck dirty on a
        // phantom `D` that no Sync could clear. Janitor-owned at every depth,
        // never user work.
        || p.split('/').any(|seg| seg.starts_with(QUARANTINE_PREFIX))
}

/// Extract the file path from one `git status --porcelain` line, resolving the
/// rename form (`R  old -> new`) to the new path. Returns "" for a malformed line.
pub(crate) fn porcelain_path(line: &str) -> &str {
    // Format: two status columns + a space, then the path (columns 3..).
    let rest = line.get(3..).unwrap_or("").trim();
    match rest.rsplit_once(" -> ") {
        Some((_, new)) => new.trim(),
        None => rest,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_scratch_is_ignored_but_source_is_not() {
        // The perpetually-"dirty" app-managed paths that used to wedge creates.
        assert!(is_app_scratch(".owllm-inbox/image_1.png"));
        assert!(is_app_scratch(".owllm-inbox"));
        assert!(is_app_scratch(".owllm/brainstorm.json"));
        assert!(is_app_scratch(".owllm/eval-traces.jsonl"));
        assert!(is_app_scratch("./.owllm-inbox/x.png"));
        assert!(is_app_scratch(".owllm-inbox\\image_1.png")); // porcelain can emit backslashes
                                                             // npm staged-install scratch left behind mid-install must never read as
                                                             // "pending edits" (regression: blocked all Coding-page runs, 2026-08-25).
        assert!(is_app_scratch("owllm-desktop/node_modules.partial/"));
        assert!(is_app_scratch(
            "owllm-desktop/node_modules.partial/esbuild/package.json"
        ));
        assert!(is_app_scratch("node_modules.partial"));
        assert!(!is_app_scratch("owllm-desktop/node_modules.partial.md")); // sibling file, not the dir

        // Disk-janitor quarantine at ANY depth. Only `owllm-desktop/.gitignore`
        // covered this name, so in a sibling subproject the renamed cache read
        // as "pending edits", blocked every run, and got committed by a Sync
        // (regression: a6080592 tracked a rollup .node binary, leaving the page
        // permanently dirty on a `D` no Sync could clear).
        assert!(is_app_scratch(
            "owllm-website/.owllm-reclaimed-1786307988/@rollup/rollup-win32-x64-msvc/rollup.win32-x64-msvc.node"
        ));
        assert!(is_app_scratch(".owllm-reclaimed-1786307988"));
        assert!(is_app_scratch("owllm-website/.owllm-reclaimed-1/x.node"));
        assert!(is_app_scratch("owllm-website\\.owllm-reclaimed-1\\x.node")); // porcelain backslashes
        assert!(!is_app_scratch("owllm-website/.owllm-reclaimed.md")); // sibling file, not the dir

        // Real source changes must STILL block (branch cuts from HEAD).
        assert!(!is_app_scratch("src/main.rs"));
        assert!(!is_app_scratch("owllm-desktop/ui/src/App.tsx"));
        assert!(!is_app_scratch(".owllm/project.json"));
        assert!(!is_app_scratch(".owllm/verify.json"));
        assert!(!is_app_scratch(".owllm/skills/example/SKILL.md"));
        assert!(!is_app_scratch(".owllm/assets/mockup.png"));
        assert!(!is_app_scratch(".owllm-inbox-notes.md")); // sibling file, not the dir
        assert!(!is_app_scratch(".github/workflows/ci.yml"));
    }

    /// The exact porcelain lines from the report that blocked the page, run
    /// through the gate's own filter. A `D` line is the poisoned-branch case: a
    /// quarantine file a Sync committed, whose directory the janitor then
    /// deleted, so it stays dirty until this predicate excuses it.
    #[test]
    fn refresh_gate_filter_drops_janitor_churn_and_keeps_user_edits() {
        let status = [
            " M owllm-desktop/ui/src/bridges/WebhookBridgeRunner.tsx",
            " M owllm-desktop/ui/src/pages/agentic/AgentsPage.tsx",
            " D owllm-website/.owllm-reclaimed-1786307988/@rollup/rollup-win32-x64-msvc/rollup.win32-x64-msvc.node",
            "?? owllm-website/.owllm-reclaimed-1786307988/vite/index.js",
            "?? owllm-website/src/assets/app/adaptive-workspace.png",
        ];
        let dirty: Vec<&str> = status
            .iter()
            .copied()
            .filter(|line| !line.trim().is_empty() && !is_app_scratch(porcelain_path(line)))
            .collect();
        assert_eq!(
            dirty,
            vec![
                " M owllm-desktop/ui/src/bridges/WebhookBridgeRunner.tsx",
                " M owllm-desktop/ui/src/pages/agentic/AgentsPage.tsx",
                "?? owllm-website/src/assets/app/adaptive-workspace.png",
            ],
            "janitor quarantine must not count as a pending edit; real edits must still block"
        );
    }

    #[test]
    fn porcelain_path_parsing() {
        assert_eq!(
            porcelain_path(" M .owllm-inbox/image_1.png"),
            ".owllm-inbox/image_1.png"
        );
        assert_eq!(porcelain_path("A  src/new.rs"), "src/new.rs");
        assert_eq!(
            porcelain_path("R  old/path.rs -> new/path.rs"),
            "new/path.rs"
        );
        assert_eq!(porcelain_path("?? untracked.txt"), "untracked.txt");
        // A source file next to a scratch change is still seen as source.
        assert!(!is_app_scratch(porcelain_path("M  Cargo.toml")));
    }
}
