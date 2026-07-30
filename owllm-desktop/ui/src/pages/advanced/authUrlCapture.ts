const KIMI_DEVICE_ORIGIN = "https://www.kimi.com";
const KIMI_DEVICE_PATH = "/code/authorize_device";

// A PTY hard-wrap can split a URL anywhere, including inside its host, and
// `https://www` still parses as a valid URL. Require a host that can actually
// resolve so a wrapped prefix is never opened as if it were the whole URL.
function hasRoutableHost(url: URL): boolean {
  const host = url.hostname;
  if (host === "localhost" || host.startsWith("[")) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  return /\.[a-z]{2,}$/i.test(host);
}

// Login CLIs also print ordinary links in banners, release notes, upgrade
// notices, and errors. Opening the first arbitrary URL is unsafe and, for
// Claude Code, allowed a promotional support.claude.com link to consume the
// one automatic browser open before `/login` printed the real OAuth URL.
// Require an authentication-shaped path or OAuth query before opening it.
function isAuthenticationUrl(url: URL): boolean {
  const path = url.pathname.toLowerCase();
  const authPath = /(?:^|\/)(?:oauth2?|cai)(?:\/|$)/.test(path)
    || /(?:^|\/)(?:auth|authorize|authorization|device|login)(?:\/|$)/.test(path)
    || path === KIMI_DEVICE_PATH;
  const authQuery = ["client_id", "code_challenge", "redirect_uri", "response_type", "user_code"]
    .some((key) => Boolean(url.searchParams.get(key)?.trim()));
  return authPath || authQuery;
}

function isCompleteAuthUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (!hasRoutableHost(url)) return false;
  if (url.origin === KIMI_DEVICE_ORIGIN && url.pathname === KIMI_DEVICE_PATH) {
    return Boolean(url.searchParams.get("user_code")?.trim());
  }
  return isAuthenticationUrl(url);
}

const MAX_WRAPPED_LINES = 8;

// ConPTY inserts a real CRLF when a CLI line reaches the terminal width, so any
// provider's login URL can arrive split — `user_cod\r\ne=ABCD-1234` or
// `https://www\r\n.kimi.com/...`. Rebuild the URL one wrapped line at a time and
// return the shortest join that validates, so a genuine line break after a
// complete URL is never glued onto the next line.
function wrappedCandidates(tail: string): string[] {
  const lines = tail.split(/\r?\n/);
  const segment = (line: string) => line.match(/^[^\s"'<>\\]*/)?.[0] ?? "";
  let joined = segment(lines[0]);
  const candidates: string[] = [];
  for (let i = 1; i < lines.length && i <= MAX_WRAPPED_LINES; i += 1) {
    const next = segment(lines[i]);
    if (!next) break;
    joined += next;
    candidates.push(joined);
    // The continuation stopped before the end of its line, so the URL ended
    // there — joining further lines would fabricate one.
    if (next.length < lines[i].length) break;
  }
  return candidates;
}

// Login CLIs write authorization URLs through a PTY, so a single URL can be
// split across arbitrary byte chunks or hard-wrapped by the PTY. Only return a
// URL after its terminating delimiter has arrived, and validate provider-
// required parameters before opening it.
export function firstCompleteAuthUrl(output: string): string | null {
  const plain = output
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const starts = /https?:\/\//g;
  for (let hit = starts.exec(plain); hit; hit = starts.exec(plain)) {
    const tail = plain.slice(hit.index);
    // Prefer the URL exactly as printed; only rebuild it across wrapped lines
    // when what was printed is not a usable URL on its own.
    const direct = tail.match(/^https?:\/\/[^\s"'<>\\]+(?=[\s"'<>\\])/)?.[0];
    for (const raw of direct ? [direct, ...wrappedCandidates(tail)] : wrappedCandidates(tail)) {
      const url = raw.replace(/[),.;\]}]+$/, "");
      if (url && isCompleteAuthUrl(url)) return url;
    }
  }
  return null;
}
