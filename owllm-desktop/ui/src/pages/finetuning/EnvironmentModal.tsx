// Fine-tuning Environment popup — one place to see ALL environments, what's
// installed, and install/repair them. Opened from the Train page's big
// "Environment" button (and from Home's "Set up" button via the
// `owllm:open-env` event). Replaces the cramped inline Environment card.
//
// Each environment shows: name + description, a live status pill (ready /
// not installed / update / broken / installing), an Install/Reinstall/Update/
// Repair action with a streamed log, and a "Use for training" selector that
// tells the Train page which env a run should use.
//
// The install itself lives in a module-level store (envInstall.ts), NOT in
// this component's state — so navigating away mid-install does NOT kill it,
// and reopening the dialog reconnects to the live progress instead of
// snapping back to an Install button.
import React from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  EnvProfile,
  EnvProfileState,
  EnvDoctorReport,
  listEnvProfiles,
  envProfileStatus,
  envProfileDoctor,
  envStateLabel,
} from "./envProfiles";
import {
  startEnvInstall,
  getEnvInstallState,
  isInstalling,
  anyInstalling,
  subscribeEnvInstall,
} from "./envInstall";

export default function EnvironmentModal({
  open,
  onClose,
  selected,
  onSelect,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  selected: string;
  onSelect: (name: string) => void;
  onChanged?: () => void;
}) {
  const [profiles, setProfiles] = React.useState<EnvProfile[]>([]);
  const [status, setStatus] = React.useState<Record<string, EnvProfileState | null>>({});
  const [openLog, setOpenLog] = React.useState<string | null>(null);
  // Doctor: per-env diagnosis report + which env is mid-diagnosis. Targeted
  // probes with NAMED failures (e.g. "torch 2.5.1 doesn't support sm_120") —
  // Repair is the normal install button (atomic, hardware-adaptive reinstall).
  const [doctor, setDoctor] = React.useState<Record<string, EnvDoctorReport | null>>({});
  const [diagnosing, setDiagnosing] = React.useState<string | null>(null);
  // WSL readiness — environments build inside WSL, so if it has no Linux user
  // (root-only, the "closed the first-run window" case) or isn't installed,
  // we surface a banner that routes to the guided setup instead of letting the
  // install fail or silently land under /root.
  const [wslStage, setWslStage] = React.useState<string | null>(null);
  const [wslDetail, setWslDetail] = React.useState<string>("");
  // Re-render whenever the module-level install store changes (it owns the
  // streaming install so it survives navigation away from this page).
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  const finishedSeen = React.useRef<Record<string, number>>({});

  const refreshOne = React.useCallback(async (name: string) => {
    try {
      const s = await envProfileStatus(name);
      setStatus((m) => ({ ...m, [name]: s }));
    } catch {
      setStatus((m) => ({ ...m, [name]: null }));
    }
  }, []);

  const refreshAll = React.useCallback(async (ps: EnvProfile[]) => {
    await Promise.all(ps.map((p) => refreshOne(p.name)));
  }, [refreshOne]);

  React.useEffect(() => {
    if (!open) return;
    invoke<{ stage: string; detail: string }>("wsl_setup_status")
      .then((s) => { setWslStage(s.stage); setWslDetail(s.detail); })
      .catch(() => { setWslStage(null); });
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    let dead = false;
    listEnvProfiles()
      .then((ps) => {
        if (dead) return;
        setProfiles(ps);
        if (!selected && ps.length > 0) onSelect(ps[0].name);
        refreshAll(ps);
        // Auto-expand the log of any env currently mid-install.
        const live = ps.find((p) => isInstalling(p.name));
        if (live) setOpenLog(live.name);
      })
      .catch(() => { /* leave empty */ });
    return () => { dead = true; };
  }, [open, selected, onSelect, refreshAll]);

  // Subscribe to the persistent install store: re-render on progress, and
  // when an install finishes, refresh that env's status once.
  React.useEffect(() => {
    return subscribeEnvInstall(() => {
      force();
      for (const p of profiles) {
        const f = getEnvInstallState(p.name).finishedAt;
        if (f && finishedSeen.current[p.name] !== f) {
          finishedSeen.current[p.name] = f;
          refreshOne(p.name);
          onChanged?.();
        }
      }
    });
  }, [profiles, refreshOne, onChanged]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!open) return null;

  const install = (name: string) => {
    setOpenLog(name);
    setDoctor((m) => ({ ...m, [name]: null })); // stale diagnosis after a reinstall
    startEnvInstall(name); // idempotent + survives navigation
  };

  const diagnose = async (name: string) => {
    setDiagnosing(name);
    try {
      const r = await envProfileDoctor(name);
      setDoctor((m) => ({ ...m, [name]: r }));
    } catch (e) {
      setDoctor((m) => ({
        ...m,
        [name]: {
          profile: name,
          checks: [],
          healthy: false,
          repairRecommended: false,
          diagnosis: `Doctor failed to run: ${e}`,
        },
      }));
    } finally {
      setDiagnosing(null);
    }
  };

  const actionLabel = (s: EnvProfileState | null, busy: boolean) =>
    busy ? "⏳ Installing…"
      : s?.kind === "ready" ? "↻ Reinstall"
      : s?.kind === "stale" ? "⟳ Update"
      : s?.kind === "broken" ? "🔧 Repair"
      : "⬇ Install";

  const busyAnywhere = anyInstalling();
  // Every env has had its status probe resolve at least once. Until then we
  // ghost the action buttons rather than show a premature "Install".
  const allChecked = profiles.length > 0 && profiles.every((p) => p.name in status);

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 9500,
        background: "rgba(0,0,0,0.62)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <style>{`@keyframes owllm-spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{
        width: "min(720px, 94%)", maxHeight: "88%",
        background: "var(--bg-panel)",
        border: "2px solid rgba(var(--accent-rgb),0.78)",
        borderRadius: 14, boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        <div style={{
          height: 54, background: "var(--bg-header)", color: "var(--bg-header-fg)",
          display: "flex", alignItems: "center", padding: "0 20px",
          borderBottom: "1px solid rgba(var(--accent-rgb),0.30)",
        }}>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: 0.5 }}>🐧 Fine-tuning Environments</div>
          <div style={{ flex: 1 }} />
          <button
            onClick={onClose} title="Close (Esc)"
            style={{
              width: 34, height: 26, border: "none",
              background: "rgba(244,67,54,0.18)", color: "#ff8080",
              fontSize: 13, cursor: "pointer", borderRadius: 5,
            }}
          >✕</button>
        </div>

        <div style={{ padding: 16, overflow: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ color: "var(--fg-muted)", fontSize: 12.5, lineHeight: 1.5 }}>
            On Windows these run inside WSL/Ubuntu. Install the one you want, then it's
            picked automatically when you Start a training run. torch auto-matches your GPU.
            {busyAnywhere && (
              <span style={{ color: "#d9b24a", fontWeight: 700 }}>
                {" "}An install is running — it keeps going even if you leave this page.
              </span>
            )}
          </div>

          {/* WSL not fully set up (commonly: installed but no Linux user yet,
              because the first-run window was closed). Environments build
              inside WSL, so route the user to the guided setup first. */}
          {wslStage && wslStage !== "ready" && wslStage !== "unsupported" && (
            <div style={{
              display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
              background: "rgba(255,179,0,0.10)", border: "1px solid rgba(255,179,0,0.45)",
              borderRadius: 10, padding: "10px 12px",
            }}>
              <div style={{ flex: 1, minWidth: 220, color: "#ffcf99", fontSize: 12.5, lineHeight: 1.5 }}>
                <b style={{ color: "#ffb74d" }}>WSL needs a quick setup first.</b>{" "}
                {wslStage === "needsUser"
                  ? "Ubuntu is installed but has no Linux user yet — create your account so environments install under your home (not root)."
                  : (wslDetail || "Finish WSL setup before installing an environment.")}
              </div>
              <button
                onClick={() => {
                  onClose();
                  window.dispatchEvent(new CustomEvent("owllm:navigate", { detail: { key: "home" } }));
                  setTimeout(() => window.dispatchEvent(new CustomEvent("owllm:open-wsl-setup")), 200);
                }}
                style={{
                  padding: "8px 14px", borderRadius: 9, border: "none",
                  background: "linear-gradient(180deg, #ffb74d, #f59e0b)",
                  color: "#241a05", fontSize: 12.5, fontWeight: 800, cursor: "pointer",
                }}
              >🐧 Set up WSL</button>
            </div>
          )}

          {/* Until the first status probe resolves, the cards below show
              ghosted buttons + a "checking…" pill so we never flash a wrong
              "not installed" for an env that's actually ready. */}
          {profiles.length > 0 && !allChecked && (
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              color: "#d9b24a", fontSize: 12.5, fontWeight: 700,
            }}>
              <span style={{
                width: 13, height: 13, borderRadius: "50%",
                border: "2px solid rgba(217,178,74,0.35)", borderTopColor: "#d9b24a",
                display: "inline-block", animation: "owllm-spin 0.7s linear infinite",
              }} />
              Checking which environments are installed…
            </div>
          )}

          {profiles.length === 0 && (
            <div style={{ color: "var(--fg-muted)", fontSize: 13 }}>No environments available.</div>
          )}

          {profiles.map((p) => {
            const s = status[p.name] ?? null;
            const known = p.name in status; // has the status probe resolved?
            const busy = isInstalling(p.name);
            const inst = getEnvInstallState(p.name);
            const pill = busy
              ? { text: "installing…", color: "#d9b24a" }
              : !known
                ? { text: "checking…", color: "var(--fg-muted)" }
                : envStateLabel(s);
            const isSel = p.name === selected;
            return (
              <div key={p.name} style={{
                border: `1px solid ${isSel ? "rgba(var(--accent-rgb),0.6)" : "var(--border)"}`,
                borderRadius: 12, padding: 14,
                background: isSel ? "rgba(var(--accent-rgb),0.06)" : "var(--bg-card)",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg-strong)", flex: 1 }}>
                    {p.display}
                  </div>
                  <span style={{
                    fontSize: 11, fontWeight: 700, color: pill.color,
                    border: `1px solid ${pill.color}`, borderRadius: 999, padding: "2px 10px",
                  }}>{pill.text}</span>
                </div>

                <div style={{ color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.5, marginTop: 6 }}>
                  {p.description}
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  <button
                    onClick={() => install(p.name)}
                    disabled={busyAnywhere || !known}
                    style={{
                      padding: "8px 14px", borderRadius: 9, border: "none",
                      background: "linear-gradient(180deg, color-mix(in srgb, var(--accent) 88%, #fff), var(--accent))",
                      color: "var(--accent-fg)", fontSize: 13, fontWeight: 700,
                      cursor: !known ? "wait" : busyAnywhere ? "wait" : "pointer",
                      opacity: !known ? 0.45 : busyAnywhere && !busy ? 0.5 : 1,
                    }}
                  >{!known ? "Checking…" : actionLabel(s, busy)}</button>

                  <button
                    onClick={() => onSelect(p.name)}
                    disabled={isSel || !known}
                    title="Use this environment for training runs"
                    style={{
                      padding: "8px 14px", borderRadius: 9,
                      border: `1px solid ${isSel ? "rgba(var(--accent-rgb),0.6)" : "var(--border-strong)"}`,
                      background: isSel ? "rgba(var(--accent-rgb),0.14)" : "var(--bg-elevated)",
                      color: "var(--fg-strong)", fontSize: 13, fontWeight: 700,
                      cursor: isSel || !known ? "default" : "pointer",
                      opacity: !known ? 0.45 : 1,
                    }}
                  >{isSel ? "✓ Used for training" : "Use for training"}</button>

                  <button
                    onClick={() => (doctor[p.name] ? setDoctor((m) => ({ ...m, [p.name]: null })) : diagnose(p.name))}
                    disabled={diagnosing !== null || busy}
                    title="Run targeted checks: venv, GPU, torch-vs-GPU architecture, every package"
                    style={{
                      padding: "8px 12px", borderRadius: 9, border: "1px solid var(--border-strong)",
                      background: "var(--bg-elevated)", color: "var(--fg)", fontSize: 12.5, fontWeight: 700,
                      cursor: diagnosing !== null || busy ? "wait" : "pointer",
                      opacity: diagnosing !== null && diagnosing !== p.name ? 0.5 : 1,
                    }}
                  >{diagnosing === p.name ? "⏳ Checking…" : doctor[p.name] ? "Hide checks" : "🩺 Diagnose"}</button>

                  {inst.log.length > 0 && (
                    <button
                      onClick={() => setOpenLog((v) => (v === p.name ? null : p.name))}
                      style={{
                        padding: "8px 12px", borderRadius: 9, border: "1px solid var(--border-strong)",
                        background: "var(--bg-elevated)", color: "var(--fg)", fontSize: 12.5, fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >{openLog === p.name ? "Hide log" : "Show log"}</button>
                  )}

                  {s?.kind === "broken" && !busy && (
                    <span style={{ color: "#f08a7f", fontSize: 11.5 }}>
                      {(s as { probe_error?: string }).probe_error?.slice(0, 80)}
                    </span>
                  )}
                </div>

                {doctor[p.name] && (
                  <div style={{
                    marginTop: 10, border: "1px solid var(--border)", borderRadius: 8,
                    background: "rgba(0,0,0,0.22)", padding: "10px 12px",
                  }}>
                    <div style={{
                      fontSize: 12.5, fontWeight: 800, marginBottom: 8,
                      color: doctor[p.name]!.healthy ? "#7ff0c5" : "#f08a7f",
                    }}>
                      {doctor[p.name]!.healthy ? "✓ " : "✗ "}{doctor[p.name]!.diagnosis}
                    </div>
                    {doctor[p.name]!.checks.map((c) => (
                      <div key={c.id} style={{ display: "flex", gap: 8, fontSize: 11.5, lineHeight: 1.7, alignItems: "baseline" }}>
                        <span style={{ width: 14, color: c.ok ? (c.warn ? "#d9b24a" : "#7ff0c5") : "#f08a7f" }}>
                          {c.ok ? (c.warn ? "⚠" : "✓") : "✗"}
                        </span>
                        <span style={{ minWidth: 130, fontWeight: 700, color: "var(--fg-strong)" }}>{c.label}</span>
                        <span style={{ color: "var(--fg-muted)", wordBreak: "break-word", flex: 1 }}>
                          {c.detail}
                          {c.fix && <span style={{ color: "#ffcf99" }}> — {c.fix}</span>}
                        </span>
                      </div>
                    ))}
                    {doctor[p.name]!.repairRecommended && !busy && (
                      <button
                        onClick={() => install(p.name)}
                        disabled={busyAnywhere}
                        style={{
                          marginTop: 8, padding: "8px 14px", borderRadius: 9, border: "none",
                          background: "linear-gradient(180deg, #ffb74d, #f59e0b)", color: "#241a05",
                          fontSize: 12.5, fontWeight: 800, cursor: busyAnywhere ? "wait" : "pointer",
                        }}
                      >🔧 Repair now (reinstall, matched to your hardware)</button>
                    )}
                  </div>
                )}

                {openLog === p.name && inst.log.length > 0 && (
                  <pre style={{
                    marginTop: 10, maxHeight: 200, overflow: "auto",
                    background: "rgba(0,0,0,0.35)", border: "1px solid var(--border)",
                    borderRadius: 8, padding: "8px 10px", fontSize: 11,
                    fontFamily: "Consolas, monospace", color: "var(--fg)",
                    whiteSpace: "pre-wrap", wordBreak: "break-all",
                  }}>{inst.log.join("\n")}</pre>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
