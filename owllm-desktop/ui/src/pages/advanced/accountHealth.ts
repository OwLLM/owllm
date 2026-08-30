export type AccountRemediation = "reauth" | "update" | "subscription" | "retry" | null;

export function isProviderUsageLimit(detail: string): boolean {
  return /weekly limit|usage limit|quota exceeded|insufficient_quota|rate_limit_event[^]*?status["']?\s*:\s*["']?rejected/i.test(detail);
}

export function classifySubscriptionFailure(detail: string): Exclude<AccountRemediation, null> {
  const text = detail.toLowerCase();
  if (/401|unauthori[sz]ed|not authenticated|not logged in|login.*expired|sign-in.*expired|invalid.*(?:token|grant|credential)|grant.*invalid|re-?authenticate/.test(text)) {
    return "reauth";
  }
  if (/newer version|update required|upgrade.*cli|outdated|unsupported version|unknown (?:option|argument)|unrecognized (?:option|argument)|no such option|reinstall/.test(text)) {
    return "update";
  }
  if (isProviderUsageLimit(detail) || /subscription required|not subscribed|upgrade your plan|billing required|quota|rate limit|no credit|free tier|payment/.test(text)) {
    return "subscription";
  }
  return "retry";
}

/// What Connect has to do to the CLI BEFORE it can start a sign-in.
export type CliPrepAction = "install" | "update" | "none";

/// Connect used to assume the CLI was already on the machine. On a fresh PC it
/// spawned nothing but `'codex' not found on PATH` and left the user to notice
/// a separate Install button, so decide here instead: install when the binary
/// is missing, upgrade when the last probe blamed the CLI's version, otherwise
/// go straight to sign-in (reinstalling on every Connect would cost 30-90 s).
///
/// Only "update" justifies a reinstall — classifySubscriptionFailure returns it
/// on real version evidence. "retry" is its catch-all for everything it could
/// not classify (a failed sign-in, a timeout, an unrecognised error), and an
/// abandoned login leaves exactly that on the card, including after a restart
/// because the page re-probes on mount. Treating it as "outdated" put a silent
/// 30-90 s npm install in front of every Connect, so the sign-in page stopped
/// opening; a failed install re-sets "retry", making the delay permanent.
export function cliPrepAction(
  installed: boolean,
  remediation: AccountRemediation,
): CliPrepAction {
  if (!installed) return "install";
  if (remediation === "update") return "update";
  return "none";
}

export function isKimiLoginSuccess(output: string): boolean {
  return /"type"\s*:\s*"success"/i.test(output)
    || /logged in successfully/i.test(output);
}
