// Guard for auth codes routed back from the browser to a login PTY.
//
// Claude's callback delivers `<code>#<state>`, and its CLI exits permanently
// on the FIRST rejected submission ("Login failed: Request failed with status
// code 400" → exit 1, no re-prompt). A code minted by an earlier attempt's
// sign-in tab must therefore never be typed into the current CLI: its state
// cannot match the state of the authorize URL this session printed.

/// `state` query parameter of an authorize URL, or "" when absent/unparsable
/// (the guard stays permissive without a session state to compare against).
export function authStateFromUrl(url: string): string {
  try {
    return new URL(url).searchParams.get("state") ?? "";
  } catch {
    return "";
  }
}

/// True when a `<code>#<state>` callback value belongs to a DIFFERENT sign-in
/// attempt than the session that printed `sessionAuthState`. Codes without a
/// state suffix are not judged stale — there is nothing to compare.
export function isStaleAuthCode(code: string, sessionAuthState: string): boolean {
  const codeState = code.split("#")[1] ?? "";
  return sessionAuthState !== "" && codeState !== "" && codeState !== sessionAuthState;
}
