// The Project Card linter — pure, deterministic incongruence detection for the
// Project Card (.owllm/project.json). PURE module (no Tauri/React imports), so the
// rules are unit-tested standalone; the wired runner `runCardLint()` lives in
// localTools.ts and gathers the repo facts these rules need (file existence,
// toolchain markers, whether the origin remote is public).
//
// WHY rule-based: the Steward agent SURFACES these findings and proposes fixes the
// USER approves — but the DETECTION is deterministic here, never the model's guess.
// That is the session-long lesson: don't leave correctness to model choice.

export type ProjectCard = {
  name?: string;
  goal?: string;
  rules?: string | string[];
  mode?: string;
  verify?: { command?: string; lanes?: Record<string, string> };
  release?: { versionFile?: string; versionScheme?: string; stagePath?: string; command?: string };
  [k: string]: any;
};

/// Repo facts the linter can't gather itself (it's pure). The caller (runCardLint)
/// fills in what it can confidently determine; anything left undefined/null means
/// "unknown" and the corresponding rule is SKIPPED — we never warn on a guess.
export type CardFacts = {
  versionFileExists?: boolean | null;   // release.versionFile resolves on disk
  stagePathExists?: boolean | null;     // release.stagePath resolves on disk
  hasPackageJson?: boolean | null;      // for verify commands that run npm/vite/tsc
  hasCargo?: boolean | null;            // for "cargo …"
  hasPyproject?: boolean | null;        // for "pytest"/"python …"
  hasGoMod?: boolean | null;            // for "go build/test …"
  remoteIsPublic?: boolean | null;      // origin remote is a PUBLIC repo (null = unknown)
};

export type CardFinding = {
  severity: "error" | "warn" | "info";
  field: string;        // dotted path into the card, e.g. "release.versionFile"
  problem: string;      // what's wrong, human-readable
  fix?: string;         // a concrete suggested fix the Steward can propose
};

/// Parse card text → object (or null when absent/malformed). Never throws.
export function parseProjectCard(text: string | null | undefined): ProjectCard | null {
  if (!text || !text.trim()) return null;
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object") return j as ProjectCard;
  } catch { /* malformed → treat as absent (the linter reports that) */ }
  return null;
}

/// Flatten the human-authored text of the card (goal + rules) into one lowercased
/// string for keyword checks (publish intent, "private", etc.).
function cardProse(card: ProjectCard): string {
  const rules = Array.isArray(card.rules) ? card.rules.join("\n") : (card.rules ?? "");
  return `${card.goal ?? ""}\n${rules}`.toLowerCase();
}

/// Same publish-intent test the rule-based publish uses, kept local so this module
/// stays import-free (matches teamConfig.goalRequiresPublish).
function mentionsPublish(prose: string): boolean {
  return /\b(publish|releas\w*|ship\s+it|deploy)\b/i.test(prose);
}

/// True only when `command` clearly invokes a toolchain AND we KNOW (fact === false)
/// the marker is absent. cd-into-subdir commands set the marker fact to null in the
/// runner, so this never false-positives on monorepos like OwLLM (verify cds into
/// owllm-desktop/ where package.json actually lives).
function toolchainMismatch(command: string, facts: CardFacts): CardFinding[] {
  const out: CardFinding[] = [];
  const c = command.toLowerCase();
  if (/\b(npm|npx|pnpm|yarn|vite|tsc)\b/.test(c) && facts.hasPackageJson === false)
    out.push({ severity: "warn", field: "verify.command", problem: `verify runs a Node toolchain (\`${command}\`) but no package.json was found at the project root.`, fix: "Point the verify command at the directory that has package.json, or fix the path." });
  if (/\bcargo\b/.test(c) && facts.hasCargo === false)
    out.push({ severity: "warn", field: "verify.command", problem: `verify runs cargo (\`${command}\`) but no Cargo.toml was found.`, fix: "Point the verify command at the crate directory, or remove the cargo check." });
  if (/\b(pytest|python)\b/.test(c) && facts.hasPyproject === false)
    out.push({ severity: "warn", field: "verify.command", problem: `verify runs Python (\`${command}\`) but no pyproject.toml/pytest.ini was found.`, fix: "Point the verify command at the Python project, or remove it." });
  if (/\bgo (build|test|vet)\b/.test(c) && facts.hasGoMod === false)
    out.push({ severity: "warn", field: "verify.command", problem: `verify runs Go (\`${command}\`) but no go.mod was found.`, fix: "Point the verify command at the Go module, or remove it." });
  return out;
}

/// Lint a Project Card against the repo facts. Returns findings ordered
/// error → warn → info. Empty array = the card is congruent with the repo.
export function lintProjectCard(card: ProjectCard | null | undefined, facts: CardFacts = {}): CardFinding[] {
  const out: CardFinding[] = [];

  if (!card) {
    out.push({ severity: "info", field: "(card)", problem: "No Project Card found.", fix: "Add .owllm/project.json with at least a `goal` and a `verify` command so runs are grounded and travel with the repo." });
    return out;
  }

  const prose = cardProse(card);
  const rel = card.release;
  const wantsPublish = mentionsPublish(prose);

  // --- release section ---
  if (rel && typeof rel === "object") {
    if (!rel.versionFile || !rel.versionFile.trim()) {
      out.push({ severity: "error", field: "release.versionFile", problem: "release is configured but release.versionFile is missing — the version bump has nothing to edit.", fix: 'Set release.versionFile to the file holding the version (e.g. "src-tauri/tauri.conf.json" or "package.json").' });
    } else if (facts.versionFileExists === false) {
      out.push({ severity: "error", field: "release.versionFile", problem: `release.versionFile "${rel.versionFile}" does not exist — the publish will fail at the version bump.`, fix: "Fix the path to the real version file." });
    }
    if (rel.stagePath && rel.stagePath.trim() && facts.stagePathExists === false) {
      out.push({ severity: "error", field: "release.stagePath", problem: `release.stagePath "${rel.stagePath}" does not exist — there is nothing to stage/commit for the release.`, fix: "Fix stagePath to the directory the release should commit." });
    }
    if (!rel.command || !rel.command.trim()) {
      out.push({ severity: "warn", field: "release.command", problem: "release.command is empty — there is no command to actually build/publish.", fix: "Set release.command to your build+publish script." });
    }
  } else if (wantsPublish) {
    // The goal expects a publish but there's no release config to do it by rule.
    out.push({ severity: "warn", field: "release", problem: "The goal/rules mention publishing/releasing, but there is no `release` config — a publish can only be done ad-hoc by the model (unreliable).", fix: 'Add a `release` section (versionFile, stagePath, command) so finishing a release is rule-based.' });
  }

  // --- verify section ---
  const v = card.verify;
  const verifyCmds: string[] = [];
  if (v && typeof v === "object") {
    if (v.command && v.command.trim()) verifyCmds.push(v.command.trim());
    if (v.lanes && typeof v.lanes === "object") {
      for (const k of Object.keys(v.lanes)) {
        const c = v.lanes[k];
        if (c && c.trim()) verifyCmds.push(c.trim());
      }
    }
    if (verifyCmds.length === 0) {
      out.push({ severity: "warn", field: "verify", problem: "verify section is present but has no command or lanes — runs will be honestly \"unverified\".", fix: 'Set verify.command (e.g. "npm run build") so "done" is grounded in an exit code.' });
    } else {
      const seen = new Set<string>();
      for (const c of verifyCmds) {
        for (const f of toolchainMismatch(c, facts)) {
          const key = f.field + f.problem;
          if (!seen.has(key)) { seen.add(key); out.push(f); }
        }
      }
    }
  } else {
    out.push({ severity: "info", field: "verify", problem: "No verify command configured — agent runs cannot be grounded and will report \"unverified\".", fix: 'Add a `verify` section, e.g. {"command":"npm run build"}.' });
  }

  // --- mode ---
  if (card.mode != null && !["solo", "team"].includes(String(card.mode).toLowerCase())) {
    out.push({ severity: "warn", field: "mode", problem: `mode "${card.mode}" is not recognised (expected "solo" or "team").`, fix: 'Set mode to "solo" or "team".' });
  }

  // --- the #1 standing rule: source stays private ---
  if (/\bprivate\b/.test(prose) && facts.remoteIsPublic === true) {
    out.push({ severity: "error", field: "goal", problem: "The card says the source is PRIVATE, but the origin remote is a PUBLIC repository — pushing here would expose the source.", fix: "Point origin at the private source repo (or correct the goal). NEVER push source to a public remote." });
  }

  // Stable order: error → warn → info.
  const rank = { error: 0, warn: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/// One-line-per-finding human summary for the chat / Steward report. Empty findings
/// → a single "congruent" line.
export function renderCardFindings(findings: CardFinding[]): string {
  if (!findings.length) return "✓ Project Card looks congruent with the repo.";
  const icon = (s: CardFinding["severity"]) => (s === "error" ? "❌" : s === "warn" ? "⚠️" : "ℹ️");
  return findings.map(f => `${icon(f.severity)} ${f.field}: ${f.problem}${f.fix ? `\n   → ${f.fix}` : ""}`).join("\n");
}
