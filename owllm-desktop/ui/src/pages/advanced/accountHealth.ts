export type AccountRemediation = "reauth" | "update" | "subscription" | "retry" | null;

export function classifySubscriptionFailure(detail: string): Exclude<AccountRemediation, null> {
  const text = detail.toLowerCase();
  if (/401|unauthori[sz]ed|not authenticated|not logged in|login.*expired|sign-in.*expired|invalid.*(?:token|grant|credential)|grant.*invalid|re-?authenticate/.test(text)) {
    return "reauth";
  }
  if (/newer version|update required|upgrade.*cli|outdated|unsupported version|unknown (?:option|argument)|unrecognized (?:option|argument)|no such option|reinstall/.test(text)) {
    return "update";
  }
  if (/subscription required|not subscribed|upgrade your plan|billing required|quota|rate limit|no credit|free tier|payment/.test(text)) {
    return "subscription";
  }
  return "retry";
}

export function isKimiLoginSuccess(output: string): boolean {
  return /"type"\s*:\s*"success"/i.test(output)
    || /logged in successfully/i.test(output);
}
