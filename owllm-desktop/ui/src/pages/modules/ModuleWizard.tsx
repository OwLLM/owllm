// ModuleWizard.tsx
//
// First-run + settings-time hardware-aware module installer. Works in two
// modes:
//
//   • Overlay (first run): mounted by AppShell when no modules are
//     installed yet. Full-screen, can be dismissed to skip.
//   • Settings page: addressable from Advanced > Modules to install /
//     uninstall / update later.
//
// Talks to the Rust ModuleManager via these Tauri commands:
//   module_hardware_snapshot  → HardwareSnapshot
//   module_list               → ModuleStatus[]
//   module_install(id)        → InstalledModule (emits 'module-progress')
//   module_uninstall(id)      → void
//   module_set_channel(c)     → void
//
// See data/modules/SCHEMA.md for the manifest shape these types mirror.

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type Category = "runtime" | "training" | "audio" | "bridge" | "content";
type ModuleState =
  | "not-installed"
  | "installed"
  | "update-available"
  | "not-supported";

interface ModuleStatus {
  id: string;
  displayName: string;
  description: string;
  category: Category;
  uiSlots: string[];
  dependsOn: string[];
  state: ModuleState;
  recommendedVariant: string | null;
  recommendedSizeBytes: number | null;
  installedVersion: string | null;
  availableVersion: string | null;
  blockReasons: [string, string][];
}

interface HardwareSnapshot {
  platform: string;
  gpu_vendor: string | null;
  vram_gb: number;
  ram_gb: number;
  free_disk_gb: number;
}

type ProgressEvent =
  | { module: string; stage: "started"; variant: string; version: string; sizeBytes: number }
  | { module: string; stage: "downloading"; bytesDone: number; bytesTotal: number }
  | { module: string; stage: "verifying" }
  | { module: string; stage: "extracting" }
  | { module: string; stage: "completed" }
  | { module: string; stage: "skipped"; reason: string }
  | { module: string; stage: "failed"; error: string };

interface ProgressLine {
  text: string;
  pct: number; // 0..100, -1 = indeterminate
  done: boolean;
  error?: string;
}

const CATEGORY_LABEL: Record<Category, string> = {
  runtime: "Runtime",
  training: "Training",
  audio: "Audio",
  bridge: "Bridges",
  content: "Tools & content",
};

function formatBytes(n: number | null): string {
  if (!n) return "?";
  if (n > 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  if (n > 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

export interface ModuleWizardProps {
  mode: "first-run" | "settings";
  onClose?: () => void;
}

export default function ModuleWizard({ mode, onClose }: ModuleWizardProps) {
  const [hardware, setHardware] = useState<HardwareSnapshot | null>(null);
  const [modules, setModules] = useState<ModuleStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<Record<string, ProgressLine>>({});
  const [installing, setInstalling] = useState(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  // Load hardware + module list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const hw = await invoke<HardwareSnapshot>("module_hardware_snapshot");
        const mods = await invoke<ModuleStatus[]>("module_list");
        if (cancelled) return;
        setHardware(hw);
        setModules(mods);
        // Pre-select supported, non-installed, recommended modules
        // when in first-run mode. Settings mode starts empty.
        if (mode === "first-run") {
          const pre = new Set<string>();
          for (const m of mods) {
            if (m.state === "not-installed" && m.recommendedVariant) {
              // First-run defaults: local-inference always; audio-stt if GPU detected.
              if (m.id === "local-inference") pre.add(m.id);
              if (m.id === "audio-stt" && hw.gpu_vendor) pre.add(m.id);
            }
          }
          setSelected(pre);
        }
      } catch (e: any) {
        if (!cancelled) setLoadError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode]);

  // Subscribe to progress events.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    (async () => {
      unlisten = await listen<ProgressEvent>("module-progress", (evt) => {
        const p = evt.payload;
        setProgress((prev) => {
          const next = { ...prev };
          const current = next[p.module] ?? { text: "", pct: -1, done: false };
          if (p.stage === "started") {
            next[p.module] = { text: `downloading ${p.version}…`, pct: 0, done: false };
          } else if (p.stage === "downloading") {
            const pct = p.bytesTotal > 0 ? Math.round((p.bytesDone / p.bytesTotal) * 100) : -1;
            next[p.module] = {
              text: `${formatBytes(p.bytesDone)} / ${formatBytes(p.bytesTotal)}`,
              pct,
              done: false,
            };
          } else if (p.stage === "verifying") {
            next[p.module] = { ...current, text: "verifying hash…", pct: -1, done: false };
          } else if (p.stage === "extracting") {
            next[p.module] = { ...current, text: "extracting…", pct: -1, done: false };
          } else if (p.stage === "completed") {
            next[p.module] = { text: "installed", pct: 100, done: true };
          } else if (p.stage === "skipped") {
            next[p.module] = { text: `skipped — ${p.reason}`, pct: 100, done: true };
          } else if (p.stage === "failed") {
            next[p.module] = { text: "failed", pct: 100, done: true, error: p.error };
          }
          return next;
        });
      });
    })();
    unlistenRef.current = unlisten;
    return () => {
      try {
        unlistenRef.current?.();
      } catch {}
    };
  }, []);

  const totalSize = useMemo(() => {
    let bytes = 0;
    for (const id of selected) {
      const m = modules.find((m) => m.id === id);
      if (m?.recommendedSizeBytes) bytes += m.recommendedSizeBytes;
    }
    return bytes;
  }, [selected, modules]);

  const groups = useMemo(() => {
    const g: Record<Category, ModuleStatus[]> = {
      runtime: [],
      training: [],
      audio: [],
      bridge: [],
      content: [],
    };
    for (const m of modules) g[m.category].push(m);
    return g;
  }, [modules]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const installSelected = async () => {
    setInstalling(true);
    for (const id of selected) {
      try {
        await invoke("module_install", { id });
      } catch (e) {
        // Per-module error already surfaced via progress event; continue
        // with the next module so a single failure doesn't block the rest.
      }
    }
    // Refresh status.
    try {
      const mods = await invoke<ModuleStatus[]>("module_list");
      setModules(mods);
    } catch {}
    setInstalling(false);
    // First-run: persist "wizard seen" so we don't re-prompt.
    try {
      localStorage.setItem("owllm.wizard.completed", "1");
    } catch {}
  };

  const uninstall = async (id: string) => {
    try {
      await invoke("module_uninstall", { id });
      const mods = await invoke<ModuleStatus[]>("module_list");
      setModules(mods);
    } catch (e) {
      alert(`uninstall failed: ${e}`);
    }
  };

  const skip = () => {
    try {
      localStorage.setItem("owllm.wizard.completed", "1");
    } catch {}
    onClose?.();
  };

  if (loading) {
    return (
      <div style={styles.overlay}>
        <div style={styles.panel}>
          <div style={styles.spinner}>probing hardware…</div>
        </div>
      </div>
    );
  }
  if (loadError) {
    return (
      <div style={styles.overlay}>
        <div style={styles.panel}>
          <h2>Could not load module registry</h2>
          <pre style={styles.err}>{loadError}</pre>
          <button style={styles.btnSecondary} onClick={onClose}>
            Continue without installing
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        <header style={styles.header}>
          <h2 style={styles.title}>
            {mode === "first-run" ? "Welcome to OwLLM" : "Modules"}
          </h2>
          {hardware && (
            <div style={styles.hwLine}>
              {hardware.gpu_vendor ? `${hardware.gpu_vendor.toUpperCase()} GPU · ${hardware.vram_gb} GB VRAM · ` : "No GPU detected · "}
              {hardware.ram_gb} GB RAM · {hardware.platform}
            </div>
          )}
        </header>

        <div style={styles.body}>
          {(Object.keys(groups) as Category[]).map((cat) =>
            groups[cat].length === 0 ? null : (
              <section key={cat} style={styles.section}>
                <h3 style={styles.sectionTitle}>{CATEGORY_LABEL[cat]}</h3>
                {groups[cat].map((m) => {
                  const isInstalled = m.state === "installed";
                  const isUpdate = m.state === "update-available";
                  const isSupported = m.state !== "not-supported";
                  const checked = selected.has(m.id) || isInstalled;
                  const prog = progress[m.id];
                  return (
                    <div
                      key={m.id}
                      style={{
                        ...styles.row,
                        opacity: isSupported ? 1 : 0.5,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!isSupported || isInstalled || installing}
                        onChange={() => toggle(m.id)}
                        style={styles.checkbox}
                      />
                      <div style={styles.rowMain}>
                        <div style={styles.rowHeader}>
                          <span style={styles.rowName}>{m.displayName}</span>
                          <span style={styles.rowSize}>
                            {formatBytes(m.recommendedSizeBytes)}
                          </span>
                          {isInstalled && <span style={styles.tagOk}>installed</span>}
                          {isUpdate && <span style={styles.tagWarn}>update available</span>}
                          {!isSupported && (
                            <span style={styles.tagErr}>not supported</span>
                          )}
                        </div>
                        <div style={styles.rowDesc}>{m.description}</div>
                        {m.dependsOn.length > 0 && (
                          <div style={styles.rowDeps}>
                            depends on: {m.dependsOn.join(", ")}
                          </div>
                        )}
                        {!isSupported && m.blockReasons.length > 0 && (
                          <div style={styles.rowErr}>
                            {m.blockReasons.map(([variant, why], i) => (
                              <div key={i}>
                                · {variant}: {why}
                              </div>
                            ))}
                          </div>
                        )}
                        {prog && (
                          <div style={styles.progressBox}>
                            <div style={styles.progressBar}>
                              <div
                                style={{
                                  ...styles.progressFill,
                                  width:
                                    prog.pct >= 0 ? `${prog.pct}%` : "30%",
                                  background: prog.error ? "#c83b3b" : "#3ec5d8",
                                  animation:
                                    prog.pct < 0 && !prog.done
                                      ? "owllmIndeterminate 1.4s linear infinite"
                                      : "none",
                                }}
                              />
                            </div>
                            <div style={styles.progressText}>
                              {prog.error ? prog.error : prog.text}
                            </div>
                          </div>
                        )}
                        {isInstalled && mode === "settings" && (
                          <button
                            onClick={() => uninstall(m.id)}
                            style={styles.btnLink}
                          >
                            Uninstall
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </section>
            )
          )}
        </div>

        <footer style={styles.footer}>
          <div style={styles.totalLine}>
            {selected.size > 0 && (
              <>
                {selected.size} module{selected.size === 1 ? "" : "s"} selected ·{" "}
                {formatBytes(totalSize)} total
              </>
            )}
          </div>
          <div style={styles.btnRow}>
            {mode === "first-run" && (
              <button onClick={skip} style={styles.btnSecondary}>
                Skip — use cloud models only
              </button>
            )}
            {mode === "settings" && (
              <button onClick={onClose} style={styles.btnSecondary}>
                Close
              </button>
            )}
            <button
              onClick={installSelected}
              disabled={installing || selected.size === 0}
              style={{
                ...styles.btnPrimary,
                opacity: installing || selected.size === 0 ? 0.5 : 1,
              }}
            >
              {installing
                ? "Installing…"
                : `Install ${selected.size > 0 ? selected.size : ""} module${selected.size === 1 ? "" : "s"}`}
            </button>
          </div>
        </footer>
      </div>
      <style>{`
        @keyframes owllmIndeterminate {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </div>
  );
}

// Hook: returns true on first launch before any modules are installed
// AND the user hasn't dismissed the wizard yet. Mount the overlay when
// this returns true; AppShell will hide regular content behind it.
export function useNeedsFirstRunWizard(): {
  needed: boolean;
  setDismissed: () => void;
} {
  const [needed, setNeeded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const dismissed = localStorage.getItem("owllm.wizard.completed") === "1";
      if (dismissed) return;
      try {
        const mods = await invoke<ModuleStatus[]>("module_list");
        if (cancelled) return;
        const anyInstalled = mods.some((m) => m.state === "installed");
        if (!anyInstalled) setNeeded(true);
      } catch {
        // If the module manager isn't ready yet, skip — second mount will retry.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return {
    needed,
    setDismissed: () => {
      try {
        localStorage.setItem("owllm.wizard.completed", "1");
      } catch {}
      setNeeded(false);
    },
  };
}

// --- inline styles (dark theme, cyan accent matching HybridFrame) ---

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(6, 8, 13, 0.92)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 9999,
    overflow: "hidden",
  },
  panel: {
    width: "min(880px, 92vw)",
    maxHeight: "88vh",
    background: "#0c1018",
    border: "1px solid #1a2030",
    borderRadius: 8,
    color: "#dfe6f0",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    boxShadow: "0 12px 60px rgba(0,0,0,0.6)",
  },
  header: {
    padding: "18px 24px 10px 24px",
    borderBottom: "1px solid #1a2030",
  },
  title: { margin: 0, fontSize: 20, fontWeight: 600 },
  hwLine: {
    fontSize: 12,
    color: "#7e8aa0",
    marginTop: 4,
    fontFamily: "ui-monospace, Menlo, Consolas, monospace",
  },
  body: { overflowY: "auto", padding: "12px 24px", flex: 1 },
  section: { marginBottom: 18 },
  sectionTitle: {
    fontSize: 11,
    color: "#5d6b80",
    textTransform: "uppercase",
    letterSpacing: 1,
    margin: "16px 0 8px 0",
    fontWeight: 600,
  },
  row: { display: "flex", gap: 12, padding: "10px 0", borderBottom: "1px solid #131825" },
  rowMain: { flex: 1, minWidth: 0 },
  rowHeader: { display: "flex", alignItems: "center", gap: 8 },
  rowName: { fontSize: 14, fontWeight: 500 },
  rowSize: { fontSize: 12, color: "#7e8aa0" },
  rowDesc: { fontSize: 12, color: "#9aa5b8", marginTop: 4, lineHeight: 1.4 },
  rowDeps: { fontSize: 11, color: "#6b7896", marginTop: 4, fontStyle: "italic" },
  rowErr: { fontSize: 11, color: "#c87878", marginTop: 4, lineHeight: 1.4 },
  checkbox: { marginTop: 4, width: 16, height: 16, accentColor: "#3ec5d8" },
  tagOk: {
    fontSize: 10,
    background: "#1f3a3a",
    color: "#3ec5d8",
    padding: "2px 6px",
    borderRadius: 3,
  },
  tagWarn: {
    fontSize: 10,
    background: "#3a341c",
    color: "#d8a93e",
    padding: "2px 6px",
    borderRadius: 3,
  },
  tagErr: {
    fontSize: 10,
    background: "#3a1f1f",
    color: "#d87878",
    padding: "2px 6px",
    borderRadius: 3,
  },
  progressBox: { marginTop: 8 },
  progressBar: {
    height: 4,
    background: "#1a2030",
    borderRadius: 2,
    overflow: "hidden",
    position: "relative",
  },
  progressFill: {
    height: "100%",
    width: "0%",
    background: "#3ec5d8",
    transition: "width 0.2s",
  },
  progressText: { fontSize: 11, color: "#7e8aa0", marginTop: 4, fontFamily: "ui-monospace, monospace" },
  footer: {
    padding: "14px 24px",
    borderTop: "1px solid #1a2030",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  totalLine: { fontSize: 12, color: "#7e8aa0" },
  btnRow: { display: "flex", gap: 8 },
  btnPrimary: {
    background: "#3ec5d8",
    color: "#06080d",
    border: "none",
    padding: "8px 16px",
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  btnSecondary: {
    background: "transparent",
    color: "#9aa5b8",
    border: "1px solid #2a3245",
    padding: "8px 16px",
    borderRadius: 4,
    fontSize: 13,
    cursor: "pointer",
  },
  btnLink: {
    background: "transparent",
    color: "#7e8aa0",
    border: "none",
    fontSize: 11,
    padding: "4px 0",
    cursor: "pointer",
    textDecoration: "underline",
    marginTop: 4,
  },
  spinner: { color: "#7e8aa0", fontSize: 13, fontFamily: "ui-monospace, monospace" },
  err: {
    background: "#1a0d0d",
    color: "#d87878",
    padding: 12,
    borderRadius: 4,
    fontSize: 11,
    overflow: "auto",
  },
};
