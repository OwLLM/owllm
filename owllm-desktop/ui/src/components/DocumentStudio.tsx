import { useEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { documentLinkName, safeMarkdownUrlTransform } from "./documentLinks";

type StudioDocument = {
  path: string;
  filename: string;
  extension: string;
  mime: string;
  size: number;
  kind: "markdown" | "html" | "table" | "json" | "pdf" | "office" | "image" | "text" | "binary";
  editable: boolean;
  text?: string | null;
  previewText?: string | null;
  dataB64?: string | null;
  version?: string | null;
  previewError?: string | null;
};

type Props = {
  href: string;
  label?: string;
  workspace?: string;
  open: boolean;
  onClose: () => void;
  services?: DocumentStudioServices;
};

export type DocumentStudioServices = {
  openDocument: (path: string, workspace?: string) => Promise<StudioDocument>;
  saveDocument: (document: StudioDocument, content: string) => Promise<string>;
  downloadDocument: (document: StudioDocument, workspace?: string) => Promise<string | null>;
  exportEditableCopy: (document: StudioDocument, content: string) => Promise<string | null>;
};

const EDITABLE_FILTERS = [
  { name: "Markdown", extensions: ["md"] },
  { name: "Text", extensions: ["txt"] },
  { name: "HTML", extensions: ["html"] },
  { name: "Data", extensions: ["csv", "json"] },
];

function errorText(error: unknown): string {
  return String((error as { message?: string })?.message ?? error);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function defaultEditableName(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "") || "document";
  return `${stem}-editable.md`;
}

function lockedHtmlPreview(html: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:">`;
  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${policy}`);
  return `<!doctype html><html><head>${policy}</head><body>${html}</body></html>`;
}

function prettyJson(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

async function chooseDestination(filename: string, editableCopy: boolean): Promise<string | null> {
  return save({
    title: editableCopy ? "Save editable document copy" : "Download document",
    defaultPath: editableCopy ? defaultEditableName(filename) : filename,
    filters: editableCopy ? EDITABLE_FILTERS : undefined,
  });
}

export async function downloadDocumentFile(
  source: string,
  filename = documentLinkName(source),
  workspace?: string,
): Promise<string | null> {
  const destination = await chooseDestination(filename, false);
  if (!destination) return null;
  await invoke("document_copy", { source, destination, overwrite: true, cwd: workspace || null });
  return destination;
}

const defaultServices: DocumentStudioServices = {
  openDocument: (path, workspace) =>
    invoke<StudioDocument>("document_open", { path, cwd: workspace || null }),
  saveDocument: (document, content) =>
    invoke<string>("document_save_text", {
      path: document.path,
      content,
      expectedVersion: document.version,
    }),
  downloadDocument: (document, workspace) =>
    downloadDocumentFile(document.path, document.filename, workspace),
  exportEditableCopy: async (document, content) => {
    const destination = await chooseDestination(document.filename, true);
    if (!destination) return null;
    await invoke("document_export_text", { destination, content, overwrite: true });
    return destination;
  },
};

function MarkdownPreview({ text }: { text: string }) {
  return (
    <div className="md-body document-studio-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeMarkdownUrlTransform}
        components={{
          a: ({ children, ...props }: any) => <a {...props} onClick={(event) => event.preventDefault()}>{children}</a>,
          table: ({ children, ...props }: any) => <div style={{ overflowX: "auto" }}><table {...props}>{children}</table></div>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function DocumentPreview({ document }: { document: StudioDocument }) {
  const text = document.previewText ?? document.text ?? "";
  if (document.kind === "image" && document.dataB64) {
    return <div style={centerPreview}><img src={`data:${document.mime};base64,${document.dataB64}`} alt={document.filename} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} /></div>;
  }
  if (document.kind === "pdf" && document.dataB64) {
    return <iframe title={document.filename} src={`data:application/pdf;base64,${document.dataB64}`} style={{ width: "100%", height: "100%", border: 0, background: "#fff" }} />;
  }
  if (document.kind === "html" && text) {
    return <iframe title={document.filename} sandbox="" srcDoc={lockedHtmlPreview(text)} style={{ width: "100%", height: "100%", border: 0, background: "#fff" }} />;
  }
  if (document.kind === "markdown" && text) {
    return <div style={paper}><MarkdownPreview text={text} /></div>;
  }
  if (document.kind === "json" && text) {
    return <pre style={sourcePreview}>{prettyJson(text)}</pre>;
  }
  if (document.kind === "table" && text) {
    return <pre style={{ ...sourcePreview, whiteSpace: "pre", overflow: "auto" }}>{text}</pre>;
  }
  if ((document.kind === "office" || document.kind === "pdf") && text) {
    return (
      <div style={paper}>
        <div style={{ fontSize: 10, color: "var(--fg-subtle)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 24 }}>Extracted offline preview</div>
        <div style={{ whiteSpace: "pre-wrap", color: "var(--fg)", font: "15px/1.75 Georgia, 'Times New Roman', serif" }}>{text}</div>
      </div>
    );
  }
  if (text) return <pre style={sourcePreview}>{text}</pre>;
  return (
    <div style={{ ...centerPreview, flexDirection: "column", gap: 10, color: "var(--fg-muted)", textAlign: "center" }}>
      <div style={{ fontSize: 42 }}>▧</div>
      <div style={{ fontWeight: 700, color: "var(--fg)" }}>Preview unavailable</div>
      <div style={{ maxWidth: 480, lineHeight: 1.5 }}>{document.previewError || "This binary format can still be downloaded and opened in its native application."}</div>
    </div>
  );
}

export default function DocumentStudio({ href, label, workspace, open, onClose, services = defaultServices }: Props) {
  const [doc, setDoc] = useState<StudioDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [draft, setDraft] = useState("");
  const [copyOnly, setCopyOnly] = useState(false);
  const dirty = !!doc && draft !== (doc.text ?? "");
  const canEditCopy = !!doc?.previewText && !doc.editable;

  const load = async () => {
    setLoading(true);
    setError("");
    setStatus("");
    try {
      const result = await services.openDocument(href, workspace);
      setDoc(result);
      setDraft(result.text ?? result.previewText ?? "");
      setCopyOnly(!result.editable);
      setMode("preview");
    } catch (cause) {
      setDoc(null);
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void load();
    else {
      setDoc(null);
      setError("");
      setStatus("");
      setMode("preview");
    }
    // A newly-opened studio always reads the current on-disk version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, href, workspace, services]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!dirty || window.confirm("Discard unsaved document changes?")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, onClose, open]);

  if (!open) return null;

  const close = () => {
    if (!dirty || window.confirm("Discard unsaved document changes?")) onClose();
  };

  const download = async () => {
    if (!doc) return;
    setStatus("Choose where to save the document…");
    try {
      const destination = await services.downloadDocument(doc, workspace);
      setStatus(destination ? `Downloaded to ${destination}` : "");
    } catch (cause) {
      setStatus(`Download failed: ${errorText(cause)}`);
    }
  };

  const exportCopy = async () => {
    if (!doc) return;
    setStatus("Saving editable copy…");
    try {
      const destination = await services.exportEditableCopy(doc, draft);
      setStatus(destination ? `Editable copy saved to ${destination}` : "");
    } catch (cause) {
      setStatus(`Save copy failed: ${errorText(cause)}`);
    }
  };

  const saveOriginal = async () => {
    if (!doc || !doc.editable || !doc.version) return;
    setStatus("Saving…");
    try {
      const version = await services.saveDocument(doc, draft);
      setDoc({ ...doc, text: draft, previewText: draft, version });
      setStatus("Saved");
      setMode("preview");
    } catch (cause) {
      setStatus(`Save failed: ${errorText(cause)}`);
    }
  };

  return createPortal(
    <div
      data-owllm-overlay
      role="dialog"
      aria-modal="true"
      aria-label={`Document Studio: ${doc?.filename || label || "document"}`}
      onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}
      style={overlay}
    >
      <section style={studio}>
        <header style={header}>
          <div style={{ width: 38, height: 38, borderRadius: 11, display: "grid", placeItems: "center", background: "rgba(var(--accent-rgb),.14)", border: "1px solid rgba(var(--accent-rgb),.35)", fontSize: 20 }}>▤</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: "var(--fg-strong)", fontSize: 15, fontWeight: 750, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{doc?.filename || label || documentLinkName(href)}</div>
            <div title={doc?.path || href} style={{ color: "var(--fg-subtle)", fontSize: 10.5, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {doc ? `${doc.extension.toUpperCase() || "FILE"} · ${formatBytes(doc.size)} · ${doc.path}` : href}
            </div>
          </div>
          <button onClick={close} aria-label="Close Document Studio" title="Close" style={iconButton}>×</button>
        </header>

        <div style={toolbar}>
          <button onClick={() => setMode("preview")} disabled={!doc} style={toolbarButton(mode === "preview")}>Preview</button>
          {doc?.editable && <button onClick={() => { setCopyOnly(false); setMode("edit"); }} style={toolbarButton(mode === "edit")}>Edit</button>}
          {canEditCopy && <button onClick={() => { setCopyOnly(true); setMode("edit"); }} style={toolbarButton(mode === "edit")}>Editable copy</button>}
          <div style={{ flex: 1 }} />
          <button onClick={() => void load()} disabled={loading} style={toolbarButton(false)}>↻ Reload</button>
          {doc && <button onClick={() => void download()} style={toolbarButton(false)}>↓ Download</button>}
          {mode === "edit" && (copyOnly || !doc?.editable) && <button onClick={() => void exportCopy()} style={primaryButton}>Save copy</button>}
          {mode === "edit" && doc?.editable && !copyOnly && <button onClick={() => void saveOriginal()} disabled={!dirty} style={{ ...primaryButton, opacity: dirty ? 1 : .55 }}>Save</button>}
        </div>

        <main style={canvas}>
          {loading && <div style={centerPreview}>Preparing local preview…</div>}
          {!loading && error && (
            <div style={{ ...centerPreview, flexDirection: "column", gap: 12, textAlign: "center" }}>
              <div style={{ fontSize: 36 }}>!</div>
              <div style={{ color: "#ff9f9f", fontWeight: 700 }}>Could not open this document</div>
              <div style={{ maxWidth: 620, color: "var(--fg-muted)", lineHeight: 1.55 }}>{error}</div>
            </div>
          )}
          {!loading && doc && mode === "preview" && <DocumentPreview document={doc} />}
          {!loading && doc && mode === "edit" && (
            <div style={{ width: "100%", height: "100%", display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(320px, .8fr)", minHeight: 0 }}>
              <textarea
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                spellCheck
                aria-label={`Edit ${doc.filename}`}
                style={{ width: "100%", height: "100%", resize: "none", border: 0, borderRight: "1px solid var(--border)", outline: "none", padding: 24, boxSizing: "border-box", color: "var(--fg)", background: "var(--bg-input)", font: "13px/1.65 Consolas, 'JetBrains Mono', monospace" }}
              />
              <div style={{ minWidth: 0, minHeight: 0, overflow: "auto", background: "var(--bg-input)", padding: 26 }}>
                <div style={{ ...paper, minHeight: "100%" }}><MarkdownPreview text={draft} /></div>
              </div>
            </div>
          )}
        </main>

        <footer style={footer}>
          <span>{doc?.previewError && doc.previewText ? `Preview note: ${doc.previewError}` : status || "Documents stay on this computer."}</span>
          {mode === "edit" && <span style={{ marginLeft: "auto", color: dirty ? "#ffd97a" : "var(--fg-subtle)" }}>{dirty ? "Unsaved changes" : "No changes"}</span>}
        </footer>
      </section>
    </div>,
    document.body,
  );
}

const overlay: CSSProperties = {
  position: "fixed", inset: 0, zIndex: 10020, padding: "clamp(12px, 3vw, 40px)",
  background: "rgba(3, 5, 10, .78)", backdropFilter: "blur(10px)",
  display: "grid", placeItems: "center",
};
const studio: CSSProperties = {
  width: "min(1180px, 100%)", height: "min(820px, 100%)", minHeight: 420,
  display: "flex", flexDirection: "column", overflow: "hidden",
  background: "var(--bg-panel)", border: "1px solid var(--border-strong)",
  borderRadius: 16, boxShadow: "0 28px 90px rgba(0,0,0,.52)",
};
const header: CSSProperties = {
  minHeight: 64, display: "flex", alignItems: "center", gap: 12, padding: "0 16px",
  borderBottom: "1px solid var(--border)", background: "linear-gradient(100deg, rgba(var(--accent-rgb),.08), transparent 42%)",
};
const toolbar: CSSProperties = {
  minHeight: 44, display: "flex", alignItems: "center", gap: 7, padding: "0 12px",
  borderBottom: "1px solid var(--border)", background: "var(--bg-card)",
};
const toolbarButton = (active: boolean): CSSProperties => ({
  height: 30, borderRadius: 8, padding: "0 11px", cursor: "pointer",
  border: `1px solid ${active ? "rgba(var(--accent-rgb),.48)" : "var(--border)"}`,
  background: active ? "rgba(var(--accent-rgb),.14)" : "var(--bg-input)",
  color: active ? "var(--accent-ink)" : "var(--fg)", fontSize: 11.5, fontWeight: 650,
});
const primaryButton: CSSProperties = {
  ...toolbarButton(true), background: "var(--accent)", color: "var(--accent-fg)", border: 0, fontWeight: 750,
};
const iconButton: CSSProperties = {
  width: 32, height: 32, borderRadius: 9, border: "1px solid var(--border)", cursor: "pointer",
  background: "var(--bg-input)", color: "var(--fg)", fontSize: 20, lineHeight: 1,
};
const canvas: CSSProperties = {
  flex: 1, minHeight: 0, overflow: "auto", background: "radial-gradient(circle at 50% 0, rgba(var(--accent-rgb),.06), transparent 38%), var(--bg-input)",
};
const centerPreview: CSSProperties = {
  width: "100%", height: "100%", minHeight: 280, display: "flex", alignItems: "center", justifyContent: "center",
};
const paper: CSSProperties = {
  width: "min(780px, calc(100% - 34px))", minHeight: "calc(100% - 34px)", margin: "17px auto",
  padding: "clamp(24px, 5vw, 64px)", boxSizing: "border-box", borderRadius: 4,
  background: "var(--bg-card)", color: "var(--fg)", boxShadow: "0 8px 30px rgba(0,0,0,.18)",
};
const sourcePreview: CSSProperties = {
  margin: 0, minHeight: "100%", boxSizing: "border-box", padding: 24,
  whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--fg)",
  background: "var(--bg-input)", font: "13px/1.65 Consolas, 'JetBrains Mono', monospace",
};
const footer: CSSProperties = {
  minHeight: 34, display: "flex", alignItems: "center", gap: 12, padding: "0 14px",
  borderTop: "1px solid var(--border)", color: "var(--fg-subtle)", fontSize: 10.5,
};
