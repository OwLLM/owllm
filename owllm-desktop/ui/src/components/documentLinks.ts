const DOCUMENT_EXTENSIONS = new Set([
  "pdf", "txt", "text", "md", "markdown", "rst", "rtf", "doc", "docx",
  "odt", "pptx", "xlsx", "html", "htm", "csv", "tsv", "json", "jsonl",
  "xml", "yaml", "yml", "log", "ini", "cfg", "toml", "sql", "tex", "py",
  "js", "jsx", "ts", "tsx", "css", "scss", "sh", "ps1", "bat", "cmd",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg",
]);

export type DocumentLinkKind = "web" | "document" | "blocked";

function linkExtension(value: string): string {
  const clean = value.split(/[?#]/, 1)[0].replace(/[)>]+$/, "");
  const match = /\.([a-zA-Z0-9]+)$/.exec(clean);
  return match?.[1]?.toLowerCase() ?? "";
}

/** Classify before invoking anything: website URLs and native files have
 * different trust boundaries and must never share an opener. */
export function classifyDocumentLink(raw?: string): DocumentLinkKind {
  const value = (raw ?? "").trim();
  if (!value) return "blocked";
  if (/^https?:\/\//i.test(value)) return "web";
  if (/^(javascript|data|vbscript):/i.test(value)) return "blocked";
  if (
    /^(file|sandbox):/i.test(value)
    || /^[a-zA-Z]:(?:[\\/]|%5[cC]|%2[fF])/.test(value)
    || /^\\\\/.test(value)
    || /^(?:\/|~[\\/]|\.{1,2}[\\/])/.test(value)
    || DOCUMENT_EXTENSIONS.has(linkExtension(value))
  ) {
    return "document";
  }
  return "blocked";
}

/** react-markdown removes file: and drive-letter URLs by default. Preserve only
 * paths the typed click handler understands; continue rejecting script/data
 * anchors. Image data/blob URLs are allowed only for an image src. */
export function safeMarkdownUrlTransform(
  url: string,
  key: string,
): string {
  if (classifyDocumentLink(url) !== "blocked") return url;
  if (key === "src" && /^(?:data:image\/|blob:|asset:|tauri:)/i.test(url)) return url;
  return "";
}

export function documentLinkName(raw: string, fallback = "document"): string {
  let value = raw.trim().replace(/[?#].*$/, "").replace(/[\\/]+$/, "");
  try { value = decodeURIComponent(value); } catch { /* retain the readable raw path */ }
  const name = value.split(/[\\/]/).pop();
  return name || fallback;
}
