// Bug-report redaction (P0-8 Slice 6). Runs over the WHOLE serialized
// bundle before the user ever previews it — secrets must not even reach
// the preview. Over-redaction is acceptable; leakage is not.

const RULES: Array<[RegExp, string]> = [
  // Provider API keys / tokens by well-known prefixes.
  [/sk-[A-Za-z0-9_\-]{8,}/g, "[REDACTED:key]"],
  [/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, "[REDACTED:github-token]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED:github-token]"],
  [/hf_[A-Za-z0-9]{16,}/g, "[REDACTED:hf-token]"],
  [/xox[baprs]-[A-Za-z0-9\-]{10,}/g, "[REDACTED:slack-token]"],
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED:aws-key]"],
  [/AIza[0-9A-Za-z_\-]{30,}/g, "[REDACTED:google-key]"],
  // Telegram bot tokens (digits:secret).
  [/\b\d{8,10}:[A-Za-z0-9_\-]{30,}\b/g, "[REDACTED:bot-token]"],
  // Bearer headers wherever they appear in captured text.
  [/Bearer\s+[A-Za-z0-9._\-]{12,}/g, "Bearer [REDACTED]"],
  // JWTs (three base64url segments).
  [/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g, "[REDACTED:jwt]"],
  // Home paths → anonymize the USERNAME only, preserving the matched
  // separator style ($1) so redacting an escaped-JSON string keeps it
  // valid JSON (C:\\Users\\mc → C:\\Users\\[user]).
  [/([A-Za-z]:\\+Users\\+)[^\\/"']+/g, "$1[user]"],
  [/(\/home\/)[^\\/"']+/g, "$1[user]"],
  [/(\/Users\/)[^\\/"']+/g, "$1[user]"],
];

/// Redact a string (typically the serialized report bundle).
export function redactForReport(s: string): string {
  let out = s;
  for (const [re, repl] of RULES) out = out.replace(re, repl);
  return out;
}
