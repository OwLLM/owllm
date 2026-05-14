// CodePage — ported from LLM/desktop_app/pages/code_page.py
// (CodePage.__init__ + UI scaffolding, line 217).
//
// The PySide6 version embeds a bundled VSCodium top-level window inside
// the Qt host via Win32 ``SetParent`` reparenting (see _embed_hwnd,
// line 745). Tauri's webview can NOT reparent a native window, so the
// React port keeps the exact same header controls (workspace picker,
// ``Cline →`` model selector, ``Launch / Re-embed`` primary button,
// status line) and renders a launcher CTA panel where Qt would have
// embedded the VSCodium HWND. The actual ``vscodium_manager.launch``
// call will become a Tauri command — for now the click handlers are
// stubs that only update the status line, mirroring the Qt status
// transitions verbatim.
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type EditorLaunch = {
  editor: string;
  command: string;
  workspace: string;
  message: string;
};

const ICONS = "/Page_icons";

// ---------------------------------------------------------------------
// Verbatim strings + sizes from code_page.py — keep these literal so
// future diffs against the Qt source stay easy.
// ---------------------------------------------------------------------

// QLabel text from line 248: f"Workspace: {self._workspace}"
// QLabel stylesheet from line 249: color: #b0b0b0
const WORKSPACE_LABEL_COLOR = "#b0b0b0";

// QComboBox.setMinimumWidth(420) — line 254. Qt comment explains this is
// wide enough to show "<Pretty Model Name> — <MAKER>  -  running" without
// the truncating ellipsis the previous 220px gave us.
const MODEL_COMBO_MIN_WIDTH = 420;

// QComboBox.setToolTip(...) — lines 256-259.
const MODEL_COMBO_TOOLTIP =
  "Pick which currently-loaded OWLLM model Cline should talk to. " +
  "Refreshes when models start or stop in the Server tab.";

// QPushButton text — line 262.
const LAUNCH_BTN_TEXT = "Launch / Re-embed";

// Header label between workspace and combo — line 268.
const CLINE_ARROW_LABEL = "Cline →";

// Status label initial color — lines 264-265.
const STATUS_COLOR = "#888";

// Status transitions — quoted verbatim from code_page.py. STATUS_INITIAL
// ("Idle.") and STATUS_PREPARING were defined here but never reached by
// the React port (the user enters the page after bootstrap; the
// preparing state belongs to the launcher worker we haven't ported).
// Keeping only the strings the React state machine actually emits.
const STATUS_BUNDLE_READY = "Bundle ready. Click Launch / Re-embed."; // line 299, 322
const STATUS_LAUNCHING = "Launching VSCodium…";                   // line 732

// _BootstrapWorker progress messages — lines 177-184.
const BOOTSTRAP_CHECKING = "Checking VSCodium bundle…";
const BOOTSTRAP_DOWNLOADING =
  "Downloading VSCodium portable (~180 MB) — first run only…";
const BOOTSTRAP_INSTALL_CLINE = "Installing Cline extension…";
const BOOTSTRAP_SEED = "Seeding settings…";

// Empty-dropdown placeholder — line 501.
const NO_MODEL_PLACEHOLDER =
  "(no model onboarded - download one in the Models tab)";

// "  -  running" suffix appended to running models — line 506.
const RUNNING_SUFFIX = "  -  running";

// QMessageBox copy from _on_bootstrap_done — lines 326-333.
const BOOTSTRAP_FAILED_INTRO =
  "Could not prepare the bundled code editor.";
const BOOTSTRAP_FAILED_HINT =
  "Check your internet connection (first run downloads VSCodium " +
  "from GitHub) and try again.";

// ---------------------------------------------------------------------
// Mock model rows — match the shape produced by
// CodePage._list_available_models (line 364): {display, model_id,
// base_path, running, url}. Once a /v1/models endpoint exists this
// will be a useEffect + fetch; for now we hand-roll two entries so the
// dropdown visibly reflects the Qt sort order (running first, then
// alphabetical) and the running suffix.
// ---------------------------------------------------------------------
type ModelRow = {
  display: string;
  model_id: string;
  base_path: string;
  running: boolean;
  url: string | null;
};

const MOCK_MODELS: ModelRow[] = [
  {
    display: "Phi-4 Q4 K M — UNSLOTH",
    model_id: "unsloth/phi-4-GGUF",
    base_path: "C:/models/unsloth/phi-4-GGUF",
    running: true,
    url: "http://127.0.0.1:8001/v1",
  },
  {
    display: "Qwen2.5 Coder 14B Q4 — UNSLOTH",
    model_id: "unsloth/Qwen2.5-Coder-14B-Instruct-GGUF",
    base_path: "C:/models/unsloth/Qwen2.5-Coder-14B-Instruct-GGUF",
    running: false,
    url: null,
  },
];

// Mirrors _list_available_models sort key (line 474):
//   (not running, display.lower())
function sortModels(models: ModelRow[]): ModelRow[] {
  return [...models].sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    return a.display.toLowerCase().localeCompare(b.display.toLowerCase());
  });
}

export default function CodePage() {
  // QSettings("LocaLLM", "OWLLM").value("code_page/workspace", ...) — line 229.
  // The Qt code falls back to ``Path.cwd()`` when no remembered workspace
  // exists; we use the repo root as a sensible default until a Tauri
  // command exposes the real persisted setting.
  // setWorkspace will be hooked up once a Tauri command exposes the
  // real persisted setting + a native folder-picker dialog.
  const [workspace] = useState<string>("C:/1_Git/LocaLLM");

  const sortedModels = sortModels(MOCK_MODELS);
  const [modelBasePath, setModelBasePath] = useState<string>(
    sortedModels[0]?.base_path ?? "",
  );
  const [status, setStatus] = useState<string>(STATUS_BUNDLE_READY);

  // ``_launch_or_relaunch`` (line 703) kills any existing bundled
  // VSCodium, seeds Cline's settings + globalState with the proxy URL,
  // spawns VSCodium pointed at the workspace, and then polls for the
  // top-level HWND so it can reparent it. None of that is reachable
  // from a Tauri webview, so this stub only mirrors the visible status
  // transitions: ``Launching VSCodium…`` then a faux ``embedded`` line.
  const onLaunch = async () => {
    setStatus(STATUS_LAUNCHING);
    try {
      const res = await invoke<EditorLaunch>("launch_external_editor", { workspace });
      setStatus(`${res.editor} launched in its own window. (${res.command})`);
    } catch (e) {
      setStatus(`Launch failed: ${e}`);
    }
  };

  const onBrowseWorkspace = () => {
    // Will become invoke("pick_directory") via Tauri's dialog plugin.
    // No-op stub — the Qt side uses a QFileDialog.getExistingDirectory
    // in callers, but code_page.py itself only reads/writes the
    // QSettings value, so there's no Qt source to quote here.
  };

  const onModelChanged = (basePath: string) => {
    setModelBasePath(basePath);
    const row = sortedModels.find((m) => m.base_path === basePath);
    if (!row) return;
    // Status copy mirrors _on_model_changed (line 645) for the
    // already-running branch and (line 661) for the start-needed branch.
    if (row.running) {
      setStatus(`Cline -> ${row.display} (already running).`);
    } else {
      setStatus(`Starting ${row.display}…`);
    }
  };

  const noModels = sortedModels.length === 0;

  return (
    <div
      style={{
        // QVBoxLayout.setContentsMargins(8, 6, 8, 8) + setSpacing(6) — lines 242-243.
        padding: "6px 8px 8px 8px",
        height: "100%",
        background: "var(--bg-panel)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {/* Header row — QHBoxLayout with spacing 8 (line 246). Order matches
          lines 267-270:
            workspace_label (stretch=1)  "Cline →"  model_combo  launch_btn */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          style={{
            flex: 1,
            color: WORKSPACE_LABEL_COLOR,
            fontSize: 12,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={workspace}
        >
          {/* Verbatim from QLabel(f"Workspace: {self._workspace}") — line 248. */}
          Workspace:{" "}
          <span style={{ color: "var(--fg)", fontFamily: "Consolas, monospace" }}>
            {workspace}
          </span>
        </div>

        {/* Browse — not in code_page.py itself (the Qt page only reads
            QSettings), but the webview port needs an explicit picker
            because we can't write a default Path.cwd() from JS. Kept
            small + ghost-styled so it doesn't visually compete with the
            primary Launch button. */}
        <button
          onClick={onBrowseWorkspace}
          className="ghost-btn"
          style={{
            height: 28,
            padding: "0 10px",
            borderRadius: 6,
            border: "1px solid var(--border-strong)",
            background: "transparent",
            color: "#cfd2d6",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Browse
        </button>

        <div style={{ fontSize: 13, color: "#cfd2d6", fontWeight: 600 }}>
          {CLINE_ARROW_LABEL}
        </div>

        <select
          value={modelBasePath}
          disabled={noModels}
          title={MODEL_COMBO_TOOLTIP}
          onChange={(e) => onModelChanged(e.target.value)}
          style={{
            // QComboBox.setMinimumWidth(420) — line 254.
            minWidth: MODEL_COMBO_MIN_WIDTH,
            height: 30,
            padding: "0 10px",
            borderRadius: 6,
            border: "1px solid var(--border-strong)",
            background: "var(--bg-input)",
            color: "var(--fg-strong)",
            fontSize: 13,
          }}
        >
          {noModels ? (
            <option value="">{NO_MODEL_PLACEHOLDER}</option>
          ) : (
            sortedModels.map((m) => (
              <option key={m.base_path} value={m.base_path}>
                {/* Visible label uses the "  -  running" suffix from line 506. */}
                {m.display + (m.running ? RUNNING_SUFFIX : "")}
              </option>
            ))
          )}
        </select>

        <button
          onClick={onLaunch}
          style={{
            height: 32,
            padding: "0 16px",
            borderRadius: 8,
            background: "linear-gradient(180deg, #4a6cff, #3a55cc)",
            color: "var(--fg-strong)",
            border: "none",
            fontWeight: 700,
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          {LAUNCH_BTN_TEXT}
        </button>
      </div>

      {/* Status label — QLabel("Idle.") with stylesheet color: #888,
          lines 264-265. Sits directly under the header before the host
          stack (outer.addWidget(self.status_label) — line 272). */}
      <div style={{ fontSize: 11, color: STATUS_COLOR }}>{status}</div>

      {/* Host stack — in PySide6 this is a QStackedWidget whose only page
          is ``self.host`` (lines 282-288). On embed_hwnd (line 745) the
          foreign VSCodium QWindow is added into ``self.host_layout``.
          The webview can't host a foreign HWND, so we render a CTA panel
          here that explains what the Qt version does and offers the
          same Launch button. */}
      <div
        style={{
          flex: 1,
          background: "var(--bg-app)",
          border: "1px dashed rgba(127,223,255,0.18)",
          borderRadius: 12,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          padding: 40,
        }}
      >
        {/* Real Page_icons PNG — same asset the sidebar uses for the
            Code tab (AppShell.tsx line 36 = 💻 emoji label, real owl
            artwork lives at /Page_icons/owl_coding.png). */}
        <img
          src={`${ICONS}/owl_coding.png`}
          alt="VSCodium / Cline"
          style={{
            width: 160,
            height: 160,
            objectFit: "contain",
            opacity: 0.92,
            filter: "drop-shadow(0 6px 18px rgba(0,0,0,0.6))",
          }}
        />
        <div style={{ fontSize: 18, fontWeight: 700, color: "var(--fg)" }}>
          Bundled VSCodium with Cline
        </div>
        <div
          style={{
            fontSize: 13,
            color: "var(--fg-muted)",
            maxWidth: 620,
            textAlign: "center",
            lineHeight: 1.6,
          }}
        >
          {/* Paraphrase of the module-level docstring (lines 1-12) and
              the _on_bootstrap_done copy (lines 327-332). */}
          First open runs ``vscodium_manager.ensure_ready`` — it
          bootstraps a portable VSCodium, installs the Cline extension,
          and seeds Cline's settings so the OpenAI-Compatible provider
          is pre-pointed at the OWLLM proxy. Pick a loaded model in the
          dropdown above and click {LAUNCH_BTN_TEXT.toLowerCase()} to
          spawn VSCodium pinned to your workspace.
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
          <button
            onClick={onLaunch}
            style={{
              height: 42,
              padding: "0 22px",
              borderRadius: 10,
              background: "linear-gradient(180deg, #4CAF50, #388E3C)",
              color: "var(--fg-strong)",
              border: "none",
              fontWeight: 700,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            {LAUNCH_BTN_TEXT}
          </button>
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--fg-muted)",
            marginTop: 8,
            textAlign: "center",
            maxWidth: 560,
          }}
        >
          {/* Verbatim from _BootstrapWorker.run progress sequence — the
              ~180 MB figure is the literal string at line 179. */}
          {BOOTSTRAP_DOWNLOADING}
          <br />
          Subsequent launches reuse the bundle ({BOOTSTRAP_CHECKING}{" "}
          {BOOTSTRAP_INSTALL_CLINE} {BOOTSTRAP_SEED}).
        </div>
        <div
          style={{
            fontSize: 11,
            color: "#5a6478",
            marginTop: 4,
            textAlign: "center",
            maxWidth: 560,
          }}
        >
          {/* QMessageBox.warning copy from _on_bootstrap_done (lines 326-333). */}
          If the bootstrap fails: {BOOTSTRAP_FAILED_INTRO} {BOOTSTRAP_FAILED_HINT}
        </div>
      </div>
    </div>
  );
}
