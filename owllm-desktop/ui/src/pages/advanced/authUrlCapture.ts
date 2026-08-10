const KIMI_DEVICE_ORIGIN = "https://www.kimi.com";
const KIMI_DEVICE_PATH = "/code/authorize_device";
const CLAUDE_AUTH_ENDPOINTS = new Set([
  "https://claude.ai/oauth/authorize",
  "https://claude.com/cai/oauth/authorize",
]);
const CLAUDE_AUTH_HOSTS = new Set(["claude.ai", "claude.com"]);

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
  // Claude Code prints a long PKCE authorization URL. ConPTY commonly wraps
  // it immediately after client_id; that prefix still parses and its
  // `/oauth/authorize` path used to make us open it prematurely. Claude then
  // rejects the request with "Missing redirect_uri parameter". Do not accept
  // a Claude authorization prefix until the parameters required to bind the
  // callback and PKCE exchange have arrived.
  //
  // Match on the host, not on the endpoint: a row-truncated prefix such as
  // `https://claude.com/cai/oau` is not one of the endpoints, and its `/cai/`
  // path segment satisfies the generic authentication-path test, so checking
  // the endpoint alone let a fragment through as if it were the whole URL.
  if (CLAUDE_AUTH_HOSTS.has(url.hostname)) {
    if (!CLAUDE_AUTH_ENDPOINTS.has(`${url.origin}${url.pathname}`)) return false;
    return ["client_id", "redirect_uri", "code_challenge", "state"]
      .every((key) => Boolean(url.searchParams.get(key)?.trim()));
  }
  return isAuthenticationUrl(url);
}

const MAX_WRAPPED_LINES = 32;

// ConPTY inserts a real CRLF when a CLI line reaches the terminal width, so any
// provider's login URL can arrive split — `user_cod\r\ne=ABCD-1234` or
// `https://www\r\n.kimi.com/...`. Rebuild the URL one wrapped line at a time.
//
// Only ever offer a join whose END has been observed. Presence of the required
// parameters is NOT evidence that the URL is whole: Claude puts `state` last, so
// a hard wrap or a PTY chunk boundary landing inside that value yields a URL
// that passes every parameter check and is silently truncated — the browser then
// opens an authorization request the server rejects. A hard-wrapped row is
// exactly the terminal width, so the wrap group ends at the first row narrower
// than that; a narrower row that runs to the end of the buffer is still growing
// and must not be treated as the end of the URL.
function wrappedCandidates(tail: string): string[] {
  const lines = tail.split(/\r?\n/);
  const segment = (line: string) => line.match(/^[^\s"'<>\\]*/)?.[0] ?? "";
  const candidates: string[] = [];
  if (lines.length < 2) return candidates;
  // The URL ended inside its own row, so it was never wrapped; the URL exactly
  // as printed already covers it and joining rows would only fabricate one.
  if (segment(lines[0]).length < lines[0].length) return candidates;
  const width = lines[1].length;
  if (!width) return candidates;
  let joined = segment(lines[0]);
  for (let i = 1; i < lines.length && i <= MAX_WRAPPED_LINES; i += 1) {
    const line = lines[i];
    const next = segment(line);
    // A row wider than the wrap width cannot be a continuation of it, and a row
    // starting with a delimiter is new output rather than more URL.
    if (!next || line.length > width) break;
    joined += next;
    if (line.length < width) {
      // The wrap group ends on this row. Accept it only once we can see past
      // the URL — either a delimiter inside this row, or further output after
      // it. Otherwise more bytes of the same URL may still be arriving.
      if (next.length < line.length || i + 1 < lines.length) candidates.push(joined);
      break;
    }
    // A full-width row that stops early ends the URL right there.
    if (next.length < line.length) {
      candidates.push(joined);
      break;
    }
  }
  if (candidates.length) return candidates;
  // A URL can also arrive split by something other than a terminal wrap — a
  // JSON payload, a chunk boundary, a CLI that inserts its own breaks — and
  // then the rows are not all one width. Reassemble those too, but still only
  // once the end of the URL has actually been seen: a join that runs to the
  // last byte in the buffer may still be growing.
  let irregular = segment(lines[0]);
  for (let i = 1; i < lines.length && i <= MAX_WRAPPED_LINES; i += 1) {
    const next = segment(lines[i]);
    // This row opens with a delimiter, so the URL ended at the row boundary.
    if (!next) return [irregular];
    irregular += next;
    if (next.length < lines[i].length) return [irregular];
  }
  return candidates;
}

// Login CLIs write authorization URLs through a PTY, so a single URL can be
// split across arbitrary byte chunks or hard-wrapped by the PTY. Only return a
// URL after its terminating delimiter has arrived, and validate provider-
// required parameters before opening it.
export function firstCompleteAuthUrl(output: string): string | null {
  // An OSC string ends at BEL *or* ST (ESC \), and Claude Code prints its login
  // URL as an OSC-8 hyperlink. Stopping the payload only at BEL let a greedy
  // match swallow everything up to the last ST in the buffer — the visible URL
  // included — so an ST-terminated hyperlink erased the very URL we look for.
  const plain = output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  // Start at the scheme, not at `://`: a narrow terminal wraps mid-scheme
  // (`https:` / `//claude.com/...`), and requiring the slashes meant the scan
  // never began. Candidates that are not real URLs are rejected downstream.
  const starts = /https?:/g;
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
