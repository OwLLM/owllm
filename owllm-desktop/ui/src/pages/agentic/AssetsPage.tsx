// AssetsPage — per-project media asset library.
//
// Generated images/videos live in the project's asset folder with a JSON
// sidecar (prompt/brief, target platform, campaign, status, tags, notes).
// This page lets the user browse, filter, preview, and approve/reject
// assets before or after posting.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";

const STORAGE_KEY = "owllm:assets:selectedProject";

function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as any;
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__ || w.__TAURI_METADATA__);
}

type ProjectLite = {
  id: string;
  name: string;
  description: string;
  location: string;
};

type MediaAsset = {
  id: string;
  fileName: string;
  path: string;
  kind: "image" | "video" | "unknown";
  status: "draft" | "approved" | "rejected" | "posted";
  prompt: string;
  targetPlatform: string;
  campaign: string;
  tags: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
};

type MediaAssetDetail = MediaAsset & {
  dataUrl?: string;
};

const STATUS_ORDER: Record<MediaAsset["status"], number> = {
  draft: 0,
  approved: 1,
  posted: 2,
  rejected: 3,
};

const STATUS_LABEL: Record<MediaAsset["status"], string> = {
  draft: "Draft",
  approved: "Approved",
  rejected: "Rejected",
  posted: "Posted",
};

const STATUS_COLOR: Record<MediaAsset["status"], string> = {
  draft: "#9aa0a6",
  approved: "#7ff0c5",
  rejected: "#ff9e9e",
  posted: "#74a4ff",
};

const PRESET_PLATFORMS = ["", "Twitter / X", "Instagram", "LinkedIn", "TikTok", "YouTube", "Facebook", "Threads", "Bluesky", "Blog"];
const PRESET_CAMPAIGNS = ["", "Launch", "Awareness", "Engagement", "Conversion", "Recruitment", "Education", "Entertainment"];

export default function AssetsPage() {
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | MediaAsset["status"]> ("all");
  const [platformFilter, setPlatformFilter] = useState<string>("");
  const [campaignFilter, setCampaignFilter] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [sortBy, setSortBy] = useState<"newest" | "oldest" | "status">("newest");
  const [previewAsset, setPreviewAsset] = useState<MediaAsset | null>(null);
  const [importing, setImporting] = useState(false);

  // Load projects.
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const list = await invoke<ProjectLite[]>("list_projects");
        if (dead) return;
        setProjects(list || []);
        // Restore last selection or pick the most recently updated project.
        let initial = "";
        try { initial = localStorage.getItem(STORAGE_KEY) || ""; } catch { /* ignore */ }
        if (!initial && list.length > 0) initial = list[0].id;
        if (initial && !list.some((p) => p.id === initial)) initial = list.length > 0 ? list[0].id : "";
        setSelectedProjectId(initial);
      } catch (e: any) {
        if (!dead) setError(String(e?.message ?? e));
      }
    })();
    return () => { dead = true; };
  }, []);

  // Persist selected project.
  useEffect(() => {
    if (!selectedProjectId) return;
    try { localStorage.setItem(STORAGE_KEY, selectedProjectId); } catch { /* ignore */ }
  }, [selectedProjectId]);

  // Load assets when project changes.
  useEffect(() => {
    if (!selectedProjectId) { setAssets([]); return; }
    let dead = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const list = await invoke<MediaAsset[]>("media_assets_list", { projectId: selectedProjectId });
        if (dead) return;
        setAssets(list || []);
      } catch (e: any) {
        if (!dead) setError(String(e?.message ?? e));
      } finally {
        if (!dead) setLoading(false);
      }
    })();
    return () => { dead = true; };
  }, [selectedProjectId]);

  const filteredAssets = useMemo(() => {
    let list = assets.slice();
    if (statusFilter !== "all") list = list.filter((a) => a.status === statusFilter);
    if (platformFilter) list = list.filter((a) => a.targetPlatform.toLowerCase() === platformFilter.toLowerCase());
    if (campaignFilter) list = list.filter((a) => a.campaign.toLowerCase() === campaignFilter.toLowerCase());
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((a) =>
        a.fileName.toLowerCase().includes(q) ||
        a.prompt.toLowerCase().includes(q) ||
        a.campaign.toLowerCase().includes(q) ||
        a.targetPlatform.toLowerCase().includes(q) ||
        a.tags.some((t) => t.toLowerCase().includes(q))
      );
    }
    list.sort((a, b) => {
      if (sortBy === "newest") return b.createdAt.localeCompare(a.createdAt);
      if (sortBy === "oldest") return a.createdAt.localeCompare(b.createdAt);
      return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    });
    return list;
  }, [assets, statusFilter, platformFilter, campaignFilter, search, sortBy]);

  const platforms = useMemo(() => Array.from(new Set(assets.map((a) => a.targetPlatform).filter(Boolean))).sort(), [assets]);
  const campaigns = useMemo(() => Array.from(new Set(assets.map((a) => a.campaign).filter(Boolean))).sort(), [assets]);

  const refresh = async () => {
    if (!selectedProjectId) return;
    setLoading(true);
    try {
      const list = await invoke<MediaAsset[]>("media_assets_list", { projectId: selectedProjectId });
      setAssets(list || []);
      setError(null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async () => {
    if (!selectedProjectId || importing) return;
    let path: string | null = null;
    try {
      path = await invoke<string | null>("pick_file", {
        title: "Import media asset",
        filters: [
          ["Images", ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]],
          ["Videos", ["mp4", "mov", "webm", "avi", "mkv", "m4v"]],
          ["All media", ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "mp4", "mov", "webm", "avi", "mkv", "m4v"]],
        ],
      });
    } catch { /* user cancelled or dialog unavailable */ }
    if (!path) return;
    setImporting(true);
    try {
      await invoke<MediaAsset>("media_assets_import", { projectId: selectedProjectId, sourcePath: path });
      await refresh();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Header */}
      <div style={{
        padding: "14px 18px",
        borderBottom: "1px solid var(--border)",
        display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
        background: "var(--bg-card)",
      }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: "var(--fg-strong)" }}>🖼 Media Assets</span>
        <select
          value={selectedProjectId}
          onChange={(e) => setSelectedProjectId(e.target.value)}
          style={{
            minWidth: 180, padding: "6px 10px", borderRadius: 6,
            background: "var(--bg-panel)", color: "var(--fg)", border: "1px solid var(--border-strong)",
          }}
        >
          <option value="">Select a project…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <button
          onClick={handleImport}
          disabled={!selectedProjectId || importing}
          style={{
            padding: "6px 14px", borderRadius: 6, fontWeight: 600,
            background: selectedProjectId ? "var(--accent)" : "var(--border-strong)",
            color: "var(--accent-fg)", border: "none", cursor: selectedProjectId ? "pointer" : "not-allowed",
          }}
        >
          {importing ? "Importing…" : "＋ Import"}
        </button>
        <button
          onClick={refresh}
          disabled={!selectedProjectId || loading}
          style={{
            padding: "6px 12px", borderRadius: 6, fontWeight: 600,
            background: "transparent", color: "var(--fg)", border: "1px solid var(--border-strong)", cursor: "pointer",
          }}
        >
          {loading ? "⟳" : "↻ Refresh"}
        </button>

        <div style={{ flex: 1 }} />

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search assets…"
          style={{
            minWidth: 160, padding: "6px 10px", borderRadius: 6,
            background: "var(--bg-panel)", color: "var(--fg)", border: "1px solid var(--border-strong)",
          }}
        />
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as any)}
          style={{
            padding: "6px 10px", borderRadius: 6,
            background: "var(--bg-panel)", color: "var(--fg)", border: "1px solid var(--border-strong)",
          }}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="status">By status</option>
        </select>
      </div>

      {/* Filter bar */}
      <div style={{
        padding: "10px 18px",
        borderBottom: "1px solid var(--border)",
        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
        background: "var(--bg-panel)",
      }}>
        <FilterChip label="All" active={statusFilter === "all"} onClick={() => setStatusFilter("all")} />
        {(["draft", "approved", "rejected", "posted"] as MediaAsset["status"][]).map((s) => (
          <FilterChip
            key={s}
            label={STATUS_LABEL[s]}
            active={statusFilter === s}
            onClick={() => setStatusFilter(s)}
            dot={STATUS_COLOR[s]}
          />
        ))}
        <div style={{ width: 1, height: 20, background: "var(--border)", margin: "0 4px" }} />
        <select
          value={platformFilter}
          onChange={(e) => setPlatformFilter(e.target.value)}
          style={{
            padding: "5px 10px", borderRadius: 6, fontSize: 13,
            background: "var(--bg-card)", color: "var(--fg)", border: "1px solid var(--border)",
          }}
        >
          <option value="">All platforms</option>
          {platforms.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select
          value={campaignFilter}
          onChange={(e) => setCampaignFilter(e.target.value)}
          style={{
            padding: "5px 10px", borderRadius: 6, fontSize: 13,
            background: "var(--bg-card)", color: "var(--fg)", border: "1px solid var(--border)",
          }}
        >
          <option value="">All campaigns</option>
          {campaigns.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: 18 }}>
        {error && (
          <div style={{
            marginBottom: 12, padding: "10px 14px", borderRadius: 8,
            background: "rgba(244,67,54,0.15)", color: "#ff9e9e", border: "1px solid rgba(244,67,54,0.35)",
          }}>
            {error}
          </div>
        )}
        {!selectedProjectId && (
          <EmptyState title="No project selected" subtitle="Pick a project above to view its media assets." />
        )}
        {selectedProjectId && !loading && filteredAssets.length === 0 && (
          <EmptyState
            title="No assets yet"
            subtitle="Import generated images or videos to build your asset library."
            action={{ label: "Import asset", onClick: handleImport }}
          />
        )}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: 16,
        }}>
          {filteredAssets.map((asset) => (
            <AssetCard
              key={asset.id}
              asset={asset}
              onPreview={() => setPreviewAsset(asset)}
            />
          ))}
        </div>
      </div>

      {previewAsset && (
        <AssetPreviewModal
          asset={previewAsset}
          projectId={selectedProjectId}
          onClose={() => setPreviewAsset(null)}
          onUpdated={refresh}
        />
      )}
    </div>
  );
}

function FilterChip({
  label, active, onClick, dot,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  dot?: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "5px 12px", borderRadius: 999, fontSize: 13, fontWeight: 600,
        background: active ? "rgba(var(--accent-rgb), 0.22)" : "var(--bg-card)",
        color: active ? "#fafafa" : "var(--fg-muted)",
        border: active ? "1px solid rgba(var(--accent-rgb), 0.65)" : "1px solid var(--border)",
        cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
      }}
    >
      {dot && <span style={{ width: 8, height: 8, borderRadius: 4, background: dot }} />}
      {label}
    </button>
  );
}

function EmptyState({ title, subtitle, action }: { title: string; subtitle: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      height: "60%", color: "var(--fg-muted)", textAlign: "center",
    }}>
      <div style={{ fontSize: 42, marginBottom: 12 }}>🖼</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: "var(--fg-strong)", marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, maxWidth: 320 }}>{subtitle}</div>
      {action && (
        <button
          onClick={action.onClick}
          style={{
            marginTop: 16, padding: "8px 16px", borderRadius: 6, fontWeight: 600,
            background: "var(--accent)", color: "var(--accent-fg)", border: "none", cursor: "pointer",
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

function AssetCard({
  asset, onPreview,
}: {
  asset: MediaAsset;
  onPreview: () => void;
}) {
  const thumb = asset.kind === "image" && isTauri() ? convertFileSrc(asset.path) : null;

  return (
    <div
      onClick={onPreview}
      style={{
        borderRadius: 10, overflow: "hidden",
        background: "var(--bg-card)", border: "1px solid var(--border)",
        cursor: "pointer", transition: "transform 0.08s, box-shadow 0.08s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.transform = "translateY(-2px)";
        (e.currentTarget as HTMLDivElement).style.boxShadow = "0 8px 24px rgba(0,0,0,0.25)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.transform = "translateY(0)";
        (e.currentTarget as HTMLDivElement).style.boxShadow = "none";
      }}
    >
      <div style={{
        height: 140, background: "var(--bg-panel)",
        display: "flex", alignItems: "center", justifyContent: "center",
        overflow: "hidden",
      }}>
        {asset.kind === "image" && thumb ? (
          <img src={thumb} alt={asset.fileName} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : asset.kind === "video" ? (
          <div style={{ fontSize: 48 }}>🎬</div>
        ) : (
          <div style={{ fontSize: 42 }}>📄</div>
        )}
      </div>
      <div style={{ padding: "10px 12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span style={{
            fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
            background: `${STATUS_COLOR[asset.status]}22`, color: STATUS_COLOR[asset.status],
            border: `1px solid ${STATUS_COLOR[asset.status]}55`,
          }}>
            {STATUS_LABEL[asset.status]}
          </span>
          <span style={{ fontSize: 11, color: "var(--fg-muted)", flex: 1, textAlign: "right" }}>{asset.kind}</span>
        </div>
        <div style={{
          fontSize: 13, fontWeight: 600, color: "var(--fg-strong)",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }} title={asset.fileName}>
          {asset.fileName}
        </div>
        {(asset.targetPlatform || asset.campaign) && (
          <div style={{ fontSize: 11, color: "var(--fg-muted)", marginTop: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {[asset.targetPlatform, asset.campaign].filter(Boolean).join(" · ")}
          </div>
        )}
      </div>
    </div>
  );
}

function AssetPreviewModal({
  asset: initialAsset,
  projectId,
  onClose,
  onUpdated,
}: {
  asset: MediaAsset;
  projectId: string;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [asset, setAsset] = useState<MediaAssetDetail>(initialAsset);
  const [saving, setSaving] = useState(false);
  const [detailLoading, setDetailLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const detail = await invoke<MediaAssetDetail>("media_assets_get", {
          projectId,
          assetId: initialAsset.id,
          includeData: false,
        });
        if (!dead) setAsset(detail);
      } catch (e: any) {
        if (!dead) setAsset((a) => ({ ...a, dataUrl: undefined }));
      } finally {
        if (!dead) setDetailLoading(false);
      }
    })();
    return () => { dead = true; };
  }, [initialAsset.id, projectId]);

  const updateField = <K extends keyof MediaAsset>(key: K, value: MediaAsset[K]) => {
    setAsset((prev) => ({ ...prev, [key]: value } as MediaAssetDetail));
  };

  const save = async (patch: Partial<MediaAsset>) => {
    if (saving) return;
    setSaving(true);
    try {
      await invoke("media_assets_update", {
        projectId,
        assetId: asset.id,
        patch,
      });
      // Merge into local state.
      setAsset((prev) => ({ ...prev, ...patch, updatedAt: new Date().toISOString() } as MediaAssetDetail));
      await onUpdated();
    } catch (e: any) {
      alert(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  const setStatus = (status: MediaAsset["status"]) => {
    save({ status });
  };

  const handleDelete = async () => {
    try {
      await invoke("media_assets_delete", { projectId, assetId: asset.id });
      await onUpdated();
      onClose();
    } catch (e: any) {
      alert(String(e?.message ?? e));
    }
  };

  const tagsString = asset.tags?.join(", ") || "";
  const setTagsString = (v: string) => {
    updateField("tags", v.split(",").map((t) => t.trim()).filter(Boolean));
  };

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 9000,
        background: "rgba(0,0,0,0.62)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(960px, 94vw)", height: "min(760px, 90vh)",
          background: "var(--bg-panel)", border: "2px solid rgba(var(--accent-rgb), 0.78)",
          borderRadius: 14, boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
          display: "flex", flexDirection: "column", overflow: "hidden",
        }}
      >
        {/* Modal header */}
        <div style={{
          height: 56, background: "var(--bg-header)", color: "var(--bg-header-fg)",
          display: "flex", alignItems: "center", padding: "0 20px",
          borderBottom: "1px solid rgba(var(--accent-rgb), 0.30)",
        }}>
          <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: 1 }}>Asset Preview</span>
          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            style={{
              width: 36, height: 28, border: "none",
              background: "rgba(244,67,54,0.18)", color: "#ff8080",
              fontSize: 13, cursor: "pointer", borderRadius: 5,
            }}
          >✕</button>
        </div>

        {/* Modal body */}
        <div style={{ flex: 1, overflow: "auto", display: "flex", minHeight: 0 }}>
          {/* Left: preview */}
          <AssetPreviewPane asset={asset} detailLoading={detailLoading} videoRef={videoRef} />

          {/* Right: metadata */}
          <div style={{
            flex: "1 1 0", minWidth: 280, minHeight: 0,
            padding: 18, overflow: "auto", display: "flex", flexDirection: "column", gap: 14,
          }}>
            <Field label="Filename" readOnly value={asset.fileName} />
            <Field label="Prompt / brief">
              <textarea
                value={asset.prompt}
                onChange={(e) => updateField("prompt", e.target.value)}
                onBlur={() => save({ prompt: asset.prompt })}
                rows={4}
                style={{
                  width: "100%", padding: "8px 10px", borderRadius: 6,
                  background: "var(--bg-card)", color: "var(--fg)", border: "1px solid var(--border)", resize: "vertical",
                }}
              />
            </Field>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Platform">
                <input
                  list="platform-presets"
                  value={asset.targetPlatform}
                  onChange={(e) => updateField("targetPlatform", e.target.value)}
                  onBlur={() => save({ targetPlatform: asset.targetPlatform })}
                  style={{
                    width: "100%", padding: "8px 10px", borderRadius: 6,
                    background: "var(--bg-card)", color: "var(--fg)", border: "1px solid var(--border)",
                  }}
                />
                <datalist id="platform-presets">
                  {PRESET_PLATFORMS.filter(Boolean).map((p) => <option key={p} value={p} />)}
                </datalist>
              </Field>
              <Field label="Campaign">
                <input
                  list="campaign-presets"
                  value={asset.campaign}
                  onChange={(e) => updateField("campaign", e.target.value)}
                  onBlur={() => save({ campaign: asset.campaign })}
                  style={{
                    width: "100%", padding: "8px 10px", borderRadius: 6,
                    background: "var(--bg-card)", color: "var(--fg)", border: "1px solid var(--border)",
                  }}
                />
                <datalist id="campaign-presets">
                  {PRESET_CAMPAIGNS.filter(Boolean).map((c) => <option key={c} value={c} />)}
                </datalist>
              </Field>
            </div>
            <Field label="Tags (comma separated)">
              <input
                value={tagsString}
                onChange={(e) => setTagsString(e.target.value)}
                onBlur={() => save({ tags: asset.tags })}
                style={{
                  width: "100%", padding: "8px 10px", borderRadius: 6,
                  background: "var(--bg-card)", color: "var(--fg)", border: "1px solid var(--border)",
                }}
              />
            </Field>
            <Field label="Notes">
              <textarea
                value={asset.notes}
                onChange={(e) => updateField("notes", e.target.value)}
                onBlur={() => save({ notes: asset.notes })}
                rows={3}
                style={{
                  width: "100%", padding: "8px 10px", borderRadius: 6,
                  background: "var(--bg-card)", color: "var(--fg)", border: "1px solid var(--border)", resize: "vertical",
                }}
              />
            </Field>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, fontSize: 12, color: "var(--fg-muted)" }}>
              <div>Created: {formatDate(asset.createdAt)}</div>
              <div>Updated: {formatDate(asset.updatedAt)}</div>
            </div>

            {/* Status actions */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: "auto", paddingTop: 12, borderTop: "1px solid var(--border)" }}>
              {(["draft", "approved", "rejected", "posted"] as MediaAsset["status"][]).map((s) => (
                <button
                  key={s}
                  onClick={() => setStatus(s)}
                  disabled={saving || asset.status === s}
                  style={{
                    padding: "8px 14px", borderRadius: 6, fontWeight: 700,
                    background: asset.status === s ? STATUS_COLOR[s] : "transparent",
                    color: asset.status === s ? "#0a0a0a" : STATUS_COLOR[s],
                    border: `1px solid ${STATUS_COLOR[s]}`,
                    cursor: asset.status === s ? "default" : "pointer",
                  }}
                >
                  {asset.status === s ? "✓ " : ""}{STATUS_LABEL[s]}
                </button>
              ))}
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => setDeleteConfirm(true)}
                style={{
                  padding: "8px 14px", borderRadius: 6, fontWeight: 700,
                  background: "rgba(244,67,54,0.18)", color: "#ff8080",
                  border: "1px solid rgba(244,67,54,0.45)", cursor: "pointer",
                }}
              >
                Delete
              </button>
              <button
                onClick={onClose}
                style={{
                  marginLeft: "auto", padding: "8px 18px", borderRadius: 6, fontWeight: 700,
                  background: "var(--accent)", color: "var(--accent-fg)", border: "none", cursor: "pointer",
                }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      </div>

      {deleteConfirm && (
        <div
          onMouseDown={(e) => { if (e.target === e.currentTarget) setDeleteConfirm(false); }}
          style={{
            position: "fixed", inset: 0, zIndex: 9100,
            background: "rgba(0,0,0,0.72)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div style={{
            width: 360, padding: 20, borderRadius: 12,
            background: "var(--bg-panel)", border: "1px solid var(--border-strong)",
          }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--fg-strong)", marginBottom: 8 }}>
              Delete asset?
            </div>
            <div style={{ fontSize: 13, color: "var(--fg)", marginBottom: 18 }}>
              This removes the file and its metadata sidecar. It cannot be undone.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button
                onClick={() => setDeleteConfirm(false)}
                style={{
                  padding: "7px 14px", borderRadius: 6,
                  background: "transparent", color: "var(--fg)", border: "1px solid var(--border)", cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                style={{
                  padding: "7px 14px", borderRadius: 6,
                  background: "#f44336", color: "#fff", border: "none", cursor: "pointer", fontWeight: 700,
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AssetPreviewPane({
  asset, detailLoading, videoRef,
}: {
  asset: MediaAssetDetail;
  detailLoading: boolean;
  videoRef: React.RefObject<HTMLVideoElement>;
}) {
  const icon = asset.kind === "video" ? "🎬" : asset.kind === "image" ? "🖼" : "📄";
  return (
    <div style={{
      flex: "1.2 1 0", minWidth: 0, minHeight: 0,
      background: "#000", display: "flex", alignItems: "center", justifyContent: "center",
      borderRight: "1px solid var(--border)",
    }}>
      {detailLoading ? (
        <div style={{ color: "var(--fg-muted)" }}>Loading…</div>
      ) : asset.kind === "image" && isTauri() ? (
        <img src={convertFileSrc(asset.path)} alt={asset.fileName} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
      ) : asset.kind === "video" ? (
        <video
          ref={videoRef}
          controls
          style={{ maxWidth: "100%", maxHeight: "100%" }}
          src={isTauri() ? convertFileSrc(asset.path) : undefined}
        />
      ) : (
        <div style={{ color: "var(--fg-muted)", textAlign: "center" }}>
          <div style={{ fontSize: 48 }}>{icon}</div>
          <div style={{ marginTop: 8 }}>{asset.fileName}</div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, readOnly, children }: { label: string; value?: string; readOnly?: boolean; children?: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</span>
      {children ? children : (
        <input
          value={value || ""}
          readOnly={readOnly}
          style={{
            width: "100%", padding: "8px 10px", borderRadius: 6,
            background: "var(--bg-card)", color: "var(--fg)", border: "1px solid var(--border)",
            opacity: readOnly ? 0.7 : 1,
          }}
        />
      )}
    </label>
  );
}

function formatDate(iso: string) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}
