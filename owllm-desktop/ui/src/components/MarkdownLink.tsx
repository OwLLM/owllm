// Shared markdown link renderer for every chat surface.
//
// Websites go through OwLLM's persistent browser. Native document paths go
// through Document Studio instead: sending both through the browser was why a
// generated file link looked clickable but could never be downloaded.

import { useState } from "react";
import { openWebUrl } from "../utils/openWebUrl";
import DocumentStudio, { downloadDocumentFile } from "./DocumentStudio";
import { classifyDocumentLink, documentLinkName } from "./documentLinks";

export default function MarkdownLink(props: any) {
  const href: string | undefined = props.href;
  const workspace: string | undefined = props.workspace;
  const [studioOpen, setStudioOpen] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const kind = classifyDocumentLink(href);
  const sharedStyle = {
    color: "var(--accent-ink)",
    textDecoration: "underline",
    cursor: "pointer",
  };

  if (kind === "document" && href) {
    const filename = documentLinkName(href, String(props.children ?? "document"));
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, maxWidth: "100%" }}>
        <a
          href={href}
          style={sharedStyle}
          title={`Preview or edit ${filename}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setStudioOpen(true);
          }}
        >
          {props.children}
        </a>
        <button
          type="button"
          aria-label={`Download ${filename}`}
          title={downloadError || `Download ${filename}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setDownloadError("");
            void downloadDocumentFile(href, filename, workspace).catch((error) => {
              setDownloadError(`Download failed: ${String(error?.message ?? error)}`);
              setStudioOpen(true);
            });
          }}
          style={{
            width: 23,
            height: 23,
            display: "inline-grid",
            placeItems: "center",
            borderRadius: 6,
            border: "1px solid var(--border)",
            padding: 0,
            background: "rgba(var(--accent-rgb),.08)",
            color: "var(--accent-ink)",
            cursor: "pointer",
            fontSize: 13,
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          ↓
        </button>
        <DocumentStudio
          href={href}
          label={filename}
          workspace={workspace}
          open={studioOpen}
          onClose={() => setStudioOpen(false)}
        />
      </span>
    );
  }

  if (kind !== "web" || !href) {
    return <span title={href ? "This link type is blocked for safety" : undefined}>{props.children}</span>;
  }

  return (
    <a
      href={href}
      style={sharedStyle}
      title={href}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openWebUrl(href).catch((error) => console.error("open link failed", error));
      }}
    >
      {props.children}
    </a>
  );
}
