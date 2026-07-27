// Login CLIs write authorization URLs through a PTY, so a single URL can be
// split across arbitrary byte chunks. Only return a URL after its terminating
// delimiter has arrived; accepting a match at the current buffer end opened
// Kimi's `?user_cod` before the next chunk completed `?user_code=...`.
export function firstCompleteAuthUrl(output: string): string | null {
  const plain = output
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const matches = plain.match(/https?:\/\/[^\s"'<>\\]+(?=[\s"'<>\\])/g) ?? [];
  for (const raw of matches) {
    const url = raw.replace(/[),.;\]}]+$/, "");
    if (url) return url;
  }
  return null;
}
