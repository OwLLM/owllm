// The Code page's SHRUNK outer columns. Each rail carries one recognisable
// icon per feature its column holds, larger than an ordinary control so a
// closed column still reads at a glance (user spec 2026-08-08):
//   • left  — 🧠 memory · 📁 file tree · 🐙 GitHub
//   • right — 📓 notebook · 📊 usage · ⚡ rules · 🌐 browser
// They live here rather than inline in CodePage so they can be rendered and
// clicked in a test without the whole page's Tauri runtime.
import type { CSSProperties, ReactNode } from "react";

/// Rail width when a column is closed — fits a 38px icon plus the rail padding.
export const RAIL_W = 46;

const base: CSSProperties = {
  borderRadius: 6,
  border: "1px solid var(--border-strong)",
  background: "var(--bg-surface)",
  color: "var(--fg)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

/// A rail feature button. Colour keeps the rail's own identity — pink on the
/// left project column, orange on the right utility column.
export const railIconBtn = (color: string, background: string, borderColor: string): CSSProperties => ({
  ...base,
  width: 38, height: 40, padding: 0, flexShrink: 0,
  display: "flex", alignItems: "center", justifyContent: "center",
  color, background, borderColor, lineHeight: 1,
});

export const RAIL_ICON: CSSProperties = { fontSize: 22 };

const PINK = { color: "#ff78b7", bg: "rgba(255, 82, 160, 0.16)", border: "rgba(255, 105, 180, 0.68)" };
const ORANGE = { color: "#ffad42", bg: "rgba(255, 153, 51, 0.17)", border: "rgba(255, 166, 64, 0.7)" };

type Tone = typeof PINK;

function RailButton(
  { id, tone, onClick, label, title, children, iconId }:
  { id: string; tone: Tone; onClick: () => void; label: string; title: string; children: ReactNode; iconId?: string },
) {
  return (
    <button
      data-ui={id}
      onClick={onClick}
      aria-label={label}
      title={title}
      style={railIconBtn(tone.color, tone.bg, tone.border)}
    >
      <span data-ui={iconId} aria-hidden="true" style={RAIL_ICON}>{children}</span>
    </button>
  );
}

function ExpandButton({ id, tone, onClick, label, glyph }: { id: string; tone: Tone; onClick: () => void; label: string; glyph: string }) {
  return (
    <button
      data-ui={id}
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{ ...railIconBtn(tone.color, tone.bg, tone.border), height: 26, fontSize: 19 }}
    >{glyph}</button>
  );
}

const stack: CSSProperties = { display: "flex", flexDirection: "column", alignItems: "center", gap: 6 };

/// `publisher` swaps the third icon: the Agents page's left column carries the
/// release Publisher card where the Code page carries the GitHub cards.
export function CodeProjectRailIcons({ onMemory, onExpand, publisher }: { onMemory: () => void; onExpand: () => void; publisher?: boolean }) {
  return (
    <div data-ui="CodeProjectRailIcons" style={stack}>
      <RailButton
        id="CodeProjectRailCollapsedMemory" iconId="CodeProjectRailCollapsedIcon" tone={PINK}
        onClick={onMemory}
        label="Project memory"
        title="Project Memory — the shared facts and worklog for this project."
      >🧠</RailButton>
      <RailButton
        id="CodeProjectRailCollapsedFiles" tone={PINK}
        onClick={onExpand}
        label="Project files"
        title="Project files — expands this column onto the file tree."
      >📁</RailButton>
      {publisher ? (
        <RailButton
          id="CodeProjectRailCollapsedPublisher" tone={PINK}
          onClick={onExpand}
          label="Publisher"
          title="Publisher — expands this column onto the release Commit / Merge / Publish card."
        >🚀</RailButton>
      ) : (
        <RailButton
          id="CodeProjectRailCollapsedGithub" tone={PINK}
          onClick={onExpand}
          label="GitHub"
          title="GitHub — expands this column onto the repository and publish cards."
        >🐙</RailButton>
      )}
      <ExpandButton id="CodeProjectRailExpand" tone={PINK} onClick={onExpand} label="Expand left project column" glyph="›" />
    </div>
  );
}

/// The browser icon ACTS instead of expanding: shrinking the column must not
/// cost the user the control it holds. `onNotebook` is optional — the Agents
/// page's right column has no notebook page (its Notebook lives in the
/// FlowHeader), so its rail omits the 📓 icon.
export function CodeUtilityRailIcons(
  { onNotebook, onUsage, onRules, onBrowser, onExpand }:
  { onNotebook?: () => void; onUsage: () => void; onRules: () => void; onBrowser: () => void; onExpand: () => void },
) {
  return (
    <div data-ui="CodeUtilityPanelIcons" style={stack}>
      {onNotebook && <RailButton
        id="CodeUtilityPanelCollapsedNotebook" iconId="CodeUtilityPanelCollapsedIcon" tone={ORANGE}
        onClick={onNotebook}
        label="Notebook"
        title="Notebook — expands this column onto the run notebook."
      >📓</RailButton>}
      <RailButton
        id="CodeUtilityPanelCollapsedUsage" tone={ORANGE}
        onClick={onUsage}
        label="Usage"
        title="Usage — expands this column onto the account quota and traffic panel."
      >📊</RailButton>
      <RailButton
        id="CodeUtilityPanelCollapsedRules" tone={ORANGE}
        onClick={onRules}
        label="Project rules"
        title="Super User — expands this column onto this project's rules."
      >⚡</RailButton>
      <RailButton
        id="CodeUtilityPanelCollapsedBrowser" tone={ORANGE}
        onClick={onBrowser}
        label="Open browser side by side"
        title="Browser — opens the welcome page and puts OwLLM and the browser side by side."
      >🌐</RailButton>
      <ExpandButton id="CodeUtilityPanelExpand" tone={ORANGE} onClick={onExpand} label="Expand right utility column" glyph="‹" />
    </div>
  );
}
