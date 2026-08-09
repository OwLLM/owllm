// The ONE chat composer. Every chat surface (Agents dock, Code agent 1 /
// agent 2 / just-chat, fine-tuning chat) renders this component — a second
// hand-rolled composer IS the bug, exactly like ChatBubble for messages and
// LogBox for logs.
//
// Shape (the container the design review approved):
//
//   ┌ .owc ────────────────────────────────────────────────────────┐
//   │ badge                                 Model [picker ▾] [Term]│  header
//   ├──────────────────────────────────────────────────────────────┤
//   │ [img][img] [📄 doc ×] [#file.ts]                             │  trays
//   │ ┌ textarea ─────────────────────────────────────────┐  [🎤]  │  input
//   │ └───────────────────────────────────────────────────┘        │
//   ├──────────────────────────────────────────────────────────────┤
//   │ [+][/][#][Term] │ ask edit agent │ ⚡Auto  · hint · 120 [Send]│  bar
//   └──────────────────────────────────────────────────────────────┘
//
// Everything except the textarea and the Send/Stop slot is optional: a page
// passes only the capabilities it actually has, so nothing is faked. The model
// picker is a slot (pages pass the shared <ModelPicker/>) so this file never
// duplicates model-listing logic.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Attachment } from "../pages/agentic/dispatch";
import { filesFromClipboard } from "../pages/agentic/clipboardFiles";

export type ComposerSlashCommand = { name: string; hint?: string; run: () => void };
export type ComposerToggle = { key: string; label: string; title?: string; on: boolean; onToggle: () => void };
export type ComposerMode = { key: string; label: string; title?: string };

export type ComposerProps = {
  /** Stable hooks for the release verifiers and for locating a surface in the DOM. */
  dataUi: string;
  toolbarDataUi?: string;

  value: string;
  onChange: (next: string) => void;
  /** Fired by the Send button and by bare Enter (unless onKeyDown preventDefaults). */
  onSend: () => void;
  onStop?: () => void;
  busy?: boolean;
  disabled?: boolean;
  placeholder: string;
  textareaRef?: React.RefObject<HTMLTextAreaElement>;
  rows?: number;
  minHeight?: number;
  maxHeight?: number;
  /** Grow with content up to maxHeight (Agents dock behaviour). */
  autosize?: boolean;
  /** Runs before the built-in Enter/Escape handling; preventDefault() to take over. */
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;

  // ── header ────────────────────────────────────────────────────────
  // NO status / notice slot, deliberately: notifications go to the shared
  // toast surface (components/Toast.tsx). Prose here wraps to several lines,
  // grows the container and shoves the model picker off screen. Pinned by
  // composerNoNotifications.verify.run.mjs.
  badge?: React.ReactNode;
  modelPicker?: React.ReactNode;
  modelLabel?: string;
  /** Rendered at the far right of the header (the Code workspace Terminal button). */
  headerExtra?: React.ReactNode;

  // ── attachments ───────────────────────────────────────────────────
  attachments?: Attachment[];
  onAttachFiles?: (files: FileList | File[]) => void;
  onRemoveAttachment?: (index: number) => void;
  attachmentAccept?: string;
  attachmentInputDataUi?: string;

  /** `#file.ts` style context mentions parsed out of the draft by the page. */
  mentions?: string[];
  onMention?: () => void;

  // ── action bar ────────────────────────────────────────────────────
  slashCommands?: ComposerSlashCommand[];
  modes?: ComposerMode[];
  mode?: string;
  onModeChange?: (key: string) => void;
  toggles?: ComposerToggle[];
  /** Page-specific buttons (fine-tuning Clear / Save). */
  barExtra?: React.ReactNode;
  hint?: React.ReactNode;
  /** Show the draft length. No token estimate — we do not invent numbers. */
  showCounter?: boolean;

  sendLabel?: string;
  sendTitle?: string;
  stopLabel?: string;
  stopTitle?: string;
  /** Defaults to "draft is non-empty or something is attached". */
  canSend?: boolean;

  /** Web Speech dictation into the draft. */
  mic?: boolean;
  /** Surfaced to the page so mic/attachment failures are never silent. */
  onNotice?: (text: string) => void;
};

/**
 * Web Speech dictation, extracted from the Agents dock so every composer gets
 * the same mic. Appends the live transcript to whatever was already typed.
 * Returns `supported: false` where the WebView has no SpeechRecognition rather
 * than pretending the button works.
 */
export function useDictation(
  value: string,
  onChange: (next: string) => void,
  onNotice?: (text: string) => void,
) {
  const recogRef = useRef<any>(null);
  const [recording, setRecording] = useState(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => () => { try { recogRef.current?.stop?.(); } catch {} }, []);

  const supported = typeof window !== "undefined"
    && !!((window as any).webkitSpeechRecognition || (window as any).SpeechRecognition);

  const toggle = () => {
    if (recording) {
      try { recogRef.current?.stop?.(); } catch {}
      setRecording(false);
      return;
    }
    const Ctor = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
    if (!Ctor) {
      onNotice?.("Mic dictation unavailable in this WebView. Use the Telegram bridge for voice messages.");
      return;
    }
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    const baseline = valueRef.current;
    rec.onresult = (ev: any) => {
      let partial = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) partial += ev.results[i][0].transcript;
      onChange((baseline ? baseline.trimEnd() + " " : "") + partial);
    };
    rec.onend = () => setRecording(false);
    rec.onerror = (ev: any) => {
      setRecording(false);
      onNotice?.(`Mic error: ${ev?.error ?? "unknown"}`);
    };
    try { rec.start(); recogRef.current = rec; setRecording(true); }
    catch (e) { onNotice?.(`Mic start failed: ${String(e)}`); }
  };

  return { recording, supported, toggle };
}

export default function Composer(props: ComposerProps) {
  const {
    dataUi, toolbarDataUi, value, onChange, onSend, onStop, busy = false, disabled = false,
    placeholder, textareaRef, rows = 1, minHeight = 40, maxHeight = 200, autosize = true, onKeyDown,
    badge, modelPicker, modelLabel = "Model", headerExtra,
    attachments = [], onAttachFiles, onRemoveAttachment, attachmentAccept, attachmentInputDataUi,
    mentions = [], onMention,
    slashCommands = [], modes, mode, onModeChange, toggles = [], barExtra, hint, showCounter = false,
    sendLabel = "Send", sendTitle, stopLabel = "Stop", stopTitle = "Stop generating", canSend,
    mic = false, onNotice,
  } = props;

  const ownRef = useRef<HTMLTextAreaElement>(null);
  const areaRef = textareaRef ?? ownRef;
  const fileRef = useRef<HTMLInputElement>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const dictation = useDictation(value, onChange, onNotice);

  const hasContent = !!value.trim() || attachments.length > 0;
  const sendEnabled = (canSend ?? hasContent) && !disabled;

  // Grow the textarea with its content, exactly like the Agents dock did.
  useLayoutEffect(() => {
    if (!autosize) return;
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(minHeight, Math.min(el.scrollHeight, maxHeight))}px`;
  }, [value, autosize, minHeight, maxHeight, areaRef]);

  const slashActive = slashCommands.length > 0
    && (paletteOpen || value.split("\n")[0]?.trim().startsWith("/"));
  const filtered = slashActive
    ? slashCommands.filter((c) => {
        const first = value.split("\n")[0]?.trim() ?? "";
        return !first.startsWith("/") || c.name.startsWith(first.split(/\s/)[0]);
      })
    : [];

  const takeFiles = (files: FileList | File[] | null | undefined) => {
    const list = Array.from(files ?? []);
    if (list.length && onAttachFiles) { onAttachFiles(list); return true; }
    return false;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === "Escape" && paletteOpen) { setPaletteOpen(false); return; }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (busy && onStop && !hasContent) { onStop(); return; }
      if (sendEnabled) onSend();
    }
  };

  return (
    <div
      data-ui={dataUi}
      className="owc"
      onDragOver={(e) => {
        if (onAttachFiles && Array.from(e.dataTransfer?.items ?? []).some((it) => it.kind === "file")) e.preventDefault();
      }}
      onDrop={(e) => { if (takeFiles(e.dataTransfer?.files)) e.preventDefault(); }}
    >
      {(badge || modelPicker || headerExtra) && (
        <div className="owc__header" data-ui={toolbarDataUi}>
          {badge}
          {modelPicker && (
            <>
              <span className="owc__model-label">{modelLabel}</span>
              <div className="owc__model">{modelPicker}</div>
            </>
          )}
          {headerExtra}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="owc__tray">
          {attachments.map((a, i) => (
            <div key={i} className={`owc__chip owc__chip--${a.kind === "image" ? "image" : "file"}`}>
              {a.kind === "image"
                ? <img src={`data:${a.mime};base64,${a.data_b64}`} alt={a.filename ?? "image"} />
                : <span>{a.kind === "audio" ? "🎧" : "📄"} {a.filename ?? "document"}</span>}
              {onRemoveAttachment && (
                <button className="owc__chip-x" title="Remove" onClick={() => onRemoveAttachment(i)}>×</button>
              )}
            </div>
          ))}
        </div>
      )}

      {mentions.length > 0 && (
        <div className="owc__tray owc__tray--mentions">
          {mentions.map((m) => <span key={m} className="owc__mention">{m}</span>)}
        </div>
      )}

      <div className="owc__input">
        <textarea
          data-ui={`${dataUi}Area`}
          ref={areaRef}
          value={value}
          rows={rows}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onPaste={(e) => { if (takeFiles(filesFromClipboard(e.clipboardData))) e.preventDefault(); }}
          onKeyDown={handleKeyDown}
          style={{ minHeight, maxHeight, resize: autosize ? "none" : "vertical" }}
        />
        {mic && (
          <button
            className={`owc__mic${dictation.recording ? " is-recording" : ""}`}
            onClick={dictation.toggle}
            title={dictation.recording ? "Stop dictation" : "Start dictation (Web Speech)"}
            aria-label={dictation.recording ? "Stop dictation" : "Start dictation"}
          >🎤</button>
        )}
      </div>

      <div className="owc__bar">
        {onAttachFiles && (
          <>
            <input
              data-ui={attachmentInputDataUi}
              ref={fileRef}
              type="file"
              multiple
              accept={attachmentAccept}
              style={{ display: "none" }}
              onChange={(e) => { takeFiles(e.target.files); e.target.value = ""; }}
            />
            <button className="owc__btn" onClick={() => fileRef.current?.click()} title="Attach images or documents">+</button>
          </>
        )}
        {slashCommands.length > 0 && (
          <button
            className={`owc__btn${paletteOpen ? " is-on" : ""}`}
            onClick={() => setPaletteOpen((v) => !v)}
            title="Slash commands"
          >/</button>
        )}
        {onMention && <button className="owc__btn" onClick={onMention} title="Add context mention">#</button>}

        {modes && modes.length > 0 && (
          <div className="owc__modes" role="group" aria-label="Composer mode">
            {modes.map((m) => (
              <button
                key={m.key}
                className={`owc__mode${mode === m.key ? " is-on" : ""}`}
                title={m.title}
                onClick={() => onModeChange?.(m.key)}
              >{m.label}</button>
            ))}
          </div>
        )}

        {toggles.map((t) => (
          <button
            key={t.key}
            className={`owc__toggle${t.on ? " is-on" : ""}`}
            title={t.title}
            aria-pressed={t.on}
            onClick={t.onToggle}
          >{t.label}</button>
        ))}

        {barExtra}

        <span className="owc__spacer" />
        {hint && <span className="owc__hint">{hint}</span>}
        {showCounter && value.length > 0 && <span className="owc__counter">{value.length}</span>}

        {busy && onStop ? (
          <button className="owc__send owc__send--stop" onClick={onStop} title={stopTitle} aria-label={stopTitle}>
            ■ {stopLabel}
          </button>
        ) : (
          <button
            className="owc__send"
            onClick={onSend}
            disabled={!sendEnabled}
            title={sendTitle ?? (sendEnabled ? "Send (Enter)" : "Type a message first")}
            aria-label={sendLabel}
          >{sendLabel}</button>
        )}
      </div>

      {slashActive && filtered.length > 0 && (
        <div className="owc__palette" data-ui={`${dataUi}SlashPalette`}>
          {filtered.map((c) => (
            <button
              key={c.name}
              onMouseDown={(e) => { e.preventDefault(); c.run(); setPaletteOpen(false); }}
            >
              <b>{c.name}</b>{c.hint ? <span>{c.hint}</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
