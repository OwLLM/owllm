/**
 * Return files pasted into a chat composer across the three desktop engines.
 *
 * Chromium usually populates DataTransfer.files. WKWebView and WebKitGTK can
 * leave that list empty for bitmap clipboard content while exposing the image
 * as a `kind: "file"` DataTransferItem instead. Prefer the complete direct list
 * when present, then use the WebKit item path as a fallback.
 */
export function filesFromClipboard(
  clipboard: Pick<DataTransfer, "files" | "items"> | null | undefined,
): File[] {
  const files = Array.from(clipboard?.files ?? []);
  if (files.length > 0) return files;

  return Array.from(clipboard?.items ?? []).flatMap((item) => {
    if (item.kind !== "file") return [];
    const file = item.getAsFile();
    return file ? [file] : [];
  });
}
