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
import {
  EnvProfile,
  EnvProfileState,
  listEnvProfiles,
  envProfileStatus,
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
    startEnvInstall(name); // idempotent + survives navigation
  };

  const actionLabel = (s: EnvProfileState | null, busy: boolean) =>
    busy ? "⏳ Installing…"
      : s?.kind === "ready" ? "↻ Reinstall"
      : s?.kind === "stale" ? "⟳ Update"
      : s?.kind === "broken" ? "🔧 Repair"
      : "⬇ Install";

  const busyAnywhere = anyInstalling();

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 9500,
        background: "rgba(0,0,0,0.62)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
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

          {profiles.length === 0 && (
            <div style={{ color: "var(--fg-muted)", fontSize: 13 }}>No environments available.</div>
          )}

          {profiles.map((p) => {
            const s = status[p.name] ?? null;
            const busy = isInstalling(p.name);
            const inst = getEnvInstallState(p.name);
            const pill = busy ? { text: "installing…", color: "#d9b24a" } : envStateLabel(s);
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
                    disabled={busyAnywhere}
                    style={{
                      padding: "8px 14px", borderRadius: 9, border: "none",
                      background: "linear-gradient(180deg, color-mix(in srgb, var(--accent) 88%, #fff), var(--accent))",
                      color: "var(--accent-fg)", fontSize: 13, fontWeight: 700,
                      cursor: busyAnywhere ? "wait" : "pointer", opacity: busyAnywhere && !busy ? 0.5 : 1,
                    }}
                  >{actionLabel(s, busy)}</button>

                  <button
                    onClick={() => onSelect(p.name)}
                    disabled={isSel}
                    title="Use this environment for training runs"
                    style={{
                      padding: "8px 14px", borderRadius: 9,
                      border: `1px solid ${isSel ? "rgba(var(--accent-rgb),0.6)" : "var(--border-strong)"}`,
                      background: isSel ? "rgba(var(--accent-rgb),0.14)" : "var(--bg-elevated)",
                      color: "var(--fg-strong)", fontSize: 13, fontWeight: 700,
                      cursor: isSel ? "default" : "pointer",
                    }}
                  >{isSel ? "✓ Used for training" : "Use for training"}</button>

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
