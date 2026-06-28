// The Verification Gate — the source-of-truth check that decides "done".
//
// PURE module (no Tauri/React imports) so the decision logic is unit-tested
// standalone; the wired runner `runGate()` lives in localTools.ts and feeds this
// real captured command output. Core principle (from the agent-reliability
// research, see docs/AGENTIC_DESIGN.md): the executor NEVER grades itself — the
// Gate runs a real command and decides from the captured EXIT CODE. No command
// configured → "unverified" (honest), NEVER a false "passed".

export type GateScope = "frontend" | "backend" | "full" | "custom";

export type GateResult = {
  status: "passed" | "failed" | "unverified";
  command?: string;
  cwd: string;
  scope: GateScope;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  startedAt: string;
  finishedAt: string;
  captured: true;
  /// true when `command` was inferred from the project's marker files
  /// (no .owllm/verify.json) — so the UI can say "auto-detected" and the
  /// user knows why a command ran without them configuring one.
  detected?: boolean;
};

/// `.owllm/verify.json` shape: a top-level `command` (the "full" check) and an
/// optional `lanes` map for scoped checks. Everything optional.
///   { "command": "npm run build", "lanes": { "frontend": "npm run build", "backend": "pytest -q" } }
export type VerifyConfig = { command?: string; lanes?: Partial<Record<GateScope, string>> };

/// Parse verify.json text safely → config (or null when absent/malformed).
export function parseVerifyConfig(text: string | null | undefined): VerifyConfig | null {
  if (!text || !text.trim()) return null;
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object") return j as VerifyConfig;
  } catch { /* malformed → treat as unconfigured (honest 'unverified', not a guess) */ }
  return null;
}

/// Pick the command for a scope: the lane command if defined, else the top-level
/// `command` as the fallback. "" when nothing is configured → the run is unverified.
export function pickGateCommand(cfg: VerifyConfig | null | undefined, scope: GateScope): string {
  if (!cfg) return "";
  const lane = cfg.lanes?.[scope];
  if (lane && lane.trim()) return lane.trim();
  return (cfg.command ?? "").trim();
}

/// Decide status from whether a command ran + its exit code. The ONLY three
/// outcomes — note `failed` is explicit, never collapsed into "not passed".
export function classifyGateStatus(hadCommand: boolean, exitCode: number | undefined): GateResult["status"] {
  if (!hadCommand) return "unverified";
  return exitCode === 0 ? "passed" : "failed";
}

/// Marker files we sniff to infer a check when there's NO .owllm/verify.json,
/// so the gate works out-of-the-box instead of sitting "unverified" forever.
/// `packageJson` is the raw text (we read its scripts); the rest are presence
/// flags. All optional — absence just means we couldn't read it.
export type ProjectProbe = {
  packageJson?: string | null;
  hasCargo?: boolean;
  hasPyproject?: boolean;
  hasPytestIni?: boolean;
  hasGoMod?: boolean;
};

/// Infer a CHEAP, side-effect-light verify command from a project's markers
/// when the user hasn't configured one. Bias: a real "does it compile/pass"
/// check that EXITS (never a watcher), preferring fast checks over full builds.
/// Returns "" when nothing confident can be inferred → the run stays honestly
/// "unverified" rather than running a guessed (possibly destructive) command.
/// NOTE: deliberately does NOT detect `make`/arbitrary task runners — a default
/// target can do anything (deploy, clean), so guessing it is unsafe.
export function detectVerifyCommand(probe: ProjectProbe | null | undefined): string {
  if (!probe) return "";
  // JS/TS first — the most common case and the one with a declared script.
  if (probe.packageJson) {
    try {
      const pkg = JSON.parse(probe.packageJson);
      const scripts = (pkg && typeof pkg === "object" && pkg.scripts) || {};
      // A "build" script is the most reliable "did it compile" signal and
      // virtually always exits (unlike many test watchers).
      if (typeof scripts.build === "string" && scripts.build.trim()) return "npm run build";
      // No build script but TypeScript is present → typecheck without emitting.
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.typescript) return "npx tsc --noEmit";
      // Last JS resort: a test script (some watch, but better than nothing).
      if (typeof scripts.test === "string" && scripts.test.trim()) return "npm test";
    } catch { /* malformed package.json → fall through to other ecosystems */ }
  }
  if (probe.hasCargo) return "cargo check";                 // cheaper than build/test, still catches breakage
  if (probe.hasPyproject || probe.hasPytestIni) return "pytest -q";
  if (probe.hasGoMod) return "go build ./...";
  return "";
}

/// One-line human summary for the Run Report / logs.
export function renderGateLine(g: GateResult): string {
  if (g.status === "unverified") {
    return "🔍 verify: UNVERIFIED — no .owllm/verify.json and no build/test command could be auto-detected. Set a Verify command in project settings (or add .owllm/verify.json, e.g. {\"command\":\"npm run build\"}) to ground \"done\".";
  }
  const how = g.detected ? " (auto-detected)" : "";
  if (g.status === "passed") return `✓ verify passed${how} — \`${g.command}\``;
  return `✗ verify FAILED${how} — \`${g.command}\` (exit ${g.exitCode})\n${(g.stderr || g.stdout || "").trim().slice(-700)}`;
}
