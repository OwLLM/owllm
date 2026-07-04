// Deterministic pre-dispatch blocker check for the #1 silent time-sink: the goal
// references a FILE the sandboxed agents can't read — e.g. a brief at
// C:\Users\...\Downloads\BRIEF.md, outside the project root /mnt/c/1_Git/LocaLLM.
// The agents then churn 20+ minutes before surfacing it (a prompt rule the model
// obeys late, if at all). This module finds such paths so the run can test-read
// them and STOP with a clear "move it in / paste it" message BEFORE dispatching.
//
// PURE (no Tauri/React) so the path logic is unit-tested; the wired half in
// AgentsPage.dispatchGoal does the actual read-probe + surfacing.

/// Extract absolute FILE paths mentioned in free text: Windows (C:\a\b.md),
/// WSL (/mnt/c/a/b.md), git-bash (/c/a/b.md), and \\wsl.localhost\...\mnt\c\... UNC.
/// Only matches paths ending in a filename with an extension (…/x.ext) — we're
/// after referenced files, not directories. De-duplicated; original form preserved.
export function extractAbsPaths(text: string | null | undefined): string[] {
  if (!text) return [];
  // URLs are NOT file paths — without this, the drive-letter regex matches
  // inside "https://github.com" ("s:" drive + ".com" extension) and the
  // git-bash regex matches URL path segments like https://x.com/c/y/file.md,
  // aborting the run over a website the agents can perfectly well fetch.
  const scrubbed = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>|]+/gi, " ");
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (m: string) => { const t = m.trim(); if (t && !seen.has(t)) { seen.add(t); out.push(t); } };
  // \\wsl.localhost\distro\... or \\wsl$\... UNC (check before generic backslash).
  for (const m of scrubbed.match(/\\\\wsl[^\s"'`<>|]+\.[A-Za-z0-9]{1,8}/gi) ?? []) add(m);
  // Windows drive path: C:\… or C:/… ending in .ext
  for (const m of scrubbed.match(/[A-Za-z]:[\\/][^\s"'`<>|]*\.[A-Za-z0-9]{1,8}/g) ?? []) add(m);
  // POSIX: /mnt/<d>/… or /<d>/… (single-letter drive) ending in .ext
  for (const m of scrubbed.match(/(?:\/mnt\/[a-zA-Z]|\/[a-zA-Z])\/[^\s"'`<>|]*\.[A-Za-z0-9]{1,8}/g) ?? []) add(m);
  return out;
}

/// Canonicalize a path for cross-format comparison: forward slashes, drop a
/// \\wsl.localhost\<distro> or //wsl$ prefix, map /mnt/<d>/… and /<d>/… and
/// <D>:/… all to "<d>/…" (lowercased), and strip a trailing slash. So a Windows
/// project root and a WSL brief path compare correctly.
export function canonPath(p: string | null | undefined): string {
  if (!p) return "";
  let s = p.trim().replace(/\\/g, "/");
  // \\wsl.localhost/<distro>/mnt/c/… or //wsl$/…/mnt/c/… → from /mnt/…
  if (/wsl/i.test(s)) {
    const i = s.toLowerCase().indexOf("/mnt/");
    if (i >= 0) s = s.slice(i);
  }
  s = s.toLowerCase();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^\/mnt\/([a-z])\/(.*)$/))) s = `${m[1]}/${m[2]}`;        // /mnt/c/x → c/x
  else if ((m = s.match(/^\/([a-z])\/(.*)$/))) s = `${m[1]}/${m[2]}`;         // /c/x → c/x  (git-bash)
  else if ((m = s.match(/^([a-z]):\/(.*)$/))) s = `${m[1]}/${m[2]}`;          // c:/x → c/x
  return s.replace(/\/+$/, "");
}

/// Is `path` inside `root` (both canonicalized)? Root itself counts as inside.
export function isInsideRoot(path: string, root: string): boolean {
  const p = canonPath(path), r = canonPath(root);
  if (!p || !r) return false;
  return p === r || p.startsWith(r + "/");
}

/// Suggest the in-root destination for an out-of-root file: the project root's
/// ORIGINAL form + "/" + the file's basename. Used in the unblock message.
export function suggestInRoot(path: string, rootOriginal: string): string {
  const base = path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "file";
  const root = rootOriginal.replace(/[\\/]+$/, "");
  const sep = root.includes("\\") ? "\\" : "/";
  return `${root}${sep}${base}`;
}
