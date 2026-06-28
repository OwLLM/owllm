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

/// One-line human summary for the Run Report / logs.
export function renderGateLine(g: GateResult): string {
  if (g.status === "unverified") {
    return "🔍 verify: UNVERIFIED — no .owllm/verify.json check configured. Add one (e.g. {\"command\":\"npm run build\"}) to ground \"done\".";
  }
  if (g.status === "passed") return `✓ verify passed — \`${g.command}\``;
  return `✗ verify FAILED — \`${g.command}\` (exit ${g.exitCode})\n${(g.stderr || g.stdout || "").trim().slice(-700)}`;
}
