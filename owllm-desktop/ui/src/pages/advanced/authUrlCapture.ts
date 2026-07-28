const KIMI_DEVICE_ORIGIN = "https://www.kimi.com";
const KIMI_DEVICE_PATH = "/code/authorize_device";

function isCompleteAuthUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.origin === KIMI_DEVICE_ORIGIN && url.pathname === KIMI_DEVICE_PATH) {
      return Boolean(url.searchParams.get("user_code")?.trim());
    }
    return true;
  } catch {
    return false;
  }
}

// ConPTY can insert a real CRLF when a CLI line reaches the terminal width.
// Kimi prints its device URL inside JSON, so `user_code` can arrive as
// `user_cod\r\ne=ABCD-1234`. Rejoin only Kimi's known device URL and still
// require its mandatory user_code before opening it.
function completeWrappedKimiUrl(output: string): string | null {
  const prefix = `${KIMI_DEVICE_ORIGIN}${KIMI_DEVICE_PATH}?`;
  let start = output.indexOf(prefix);
  while (start >= 0) {
    const tail = output.slice(start);
    const match = tail.match(
      /^https:\/\/www\.kimi\.com\/code\/authorize_device\?[^\s"'<>\\]*(?:\r?\n[^\s"'<>\\]+)+(?=[\s"'<>\\])/,
    );
    if (match) {
      const url = match[0].replace(/\r?\n/g, "");
      if (isCompleteAuthUrl(url)) return url;
    }
    start = output.indexOf(prefix, start + prefix.length);
  }
  return null;
}

// Login CLIs write authorization URLs through a PTY, so a single URL can be
// split across arbitrary byte chunks or hard-wrapped by the PTY. Only return a
// URL after its terminating delimiter has arrived, and validate provider-
// required parameters before opening it.
export function firstCompleteAuthUrl(output: string): string | null {
  const plain = output
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const matches = plain.match(/https?:\/\/[^\s"'<>\\]+(?=[\s"'<>\\])/g) ?? [];
  for (const raw of matches) {
    const url = raw.replace(/[),.;\]}]+$/, "");
    if (url && isCompleteAuthUrl(url)) return url;
  }
  return completeWrappedKimiUrl(plain);
}
