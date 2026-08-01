import React, { type ReactNode } from "react";

export type CreationLaunchMode = {
  id: string;
  icon: string;
  label: string;
  detail: string;
  badge?: string;
};

export type CreationLaunchAction = {
  icon: string;
  label: string;
  detail?: string;
  onClick: () => void;
};

export type CreationLaunchpadProps = {
  eyebrow?: string;
  title: ReactNode;
  subtitle: string;
  prompt: string;
  placeholder: string;
  submitLabel: string;
  selectedMode: string;
  modes: CreationLaunchMode[];
  actions?: CreationLaunchAction[];
  status?: ReactNode;
  onPromptChange: (value: string) => void;
  onModeChange: (mode: string) => void;
  onSubmit: () => void;
};

/**
 * Shared first-run surface for Coding and Agentic pages.
 *
 * The visual is intentionally built from CSS instead of a bitmap: it follows
 * the user's theme/accent, scales cleanly on every OS/WebView and remains fully
 * interactive and accessible at narrow widths.
 */
export default function CreationLaunchpad({
  eyebrow = "OWLLM creation space",
  title,
  subtitle,
  prompt,
  placeholder,
  submitLabel,
  selectedMode,
  modes,
  actions = [],
  status,
  onPromptChange,
  onModeChange,
  onSubmit,
}: CreationLaunchpadProps) {
  const selected = modes.find((mode) => mode.id === selectedMode) ?? modes[0];

  return (
    <section className="creation-launchpad" data-ui="CreationLaunchpad">
      <div className="creation-launchpad__orb creation-launchpad__orb--one" aria-hidden="true" />
      <div className="creation-launchpad__orb creation-launchpad__orb--two" aria-hidden="true" />
      <div className="creation-launchpad__grid" aria-hidden="true" />

      <div className="creation-launchpad__content">
        <div className="creation-launchpad__eyebrow">
          <span className="creation-launchpad__spark" aria-hidden="true">✦</span>
          {eyebrow}
        </div>
        <h1 className="creation-launchpad__title">{title}</h1>
        <p className="creation-launchpad__subtitle">{subtitle}</p>

        <form
          className="creation-launchpad__composer"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <textarea
            data-ui="CreationPrompt"
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSubmit();
              }
            }}
            rows={2}
            placeholder={placeholder}
            aria-label={placeholder}
          />
          <div className="creation-launchpad__composer-bar">
            <span className="creation-launchpad__mode-label">
              <span aria-hidden="true">{selected?.icon ?? "✦"}</span>
              {selected?.label ?? "Create"}
            </span>
            <span className="creation-launchpad__enter-hint">Enter to continue</span>
            <button
              type="submit"
              className="creation-launchpad__submit"
              aria-label={submitLabel}
              title={submitLabel}
            >
              <span>{submitLabel}</span>
              <span aria-hidden="true">↑</span>
            </button>
          </div>
        </form>

        <div className="creation-launchpad__modes" role="group" aria-label="Choose how OWLLM should help">
          {modes.map((mode) => {
            const active = mode.id === selectedMode;
            return (
              <button
                key={mode.id}
                type="button"
                className={`creation-launchpad__mode${active ? " is-active" : ""}`}
                aria-pressed={active}
                onClick={() => onModeChange(mode.id)}
              >
                {mode.badge && <span className="creation-launchpad__badge">{mode.badge}</span>}
                <span className="creation-launchpad__mode-icon" aria-hidden="true">{mode.icon}</span>
                <span className="creation-launchpad__mode-copy">
                  <strong>{mode.label}</strong>
                  <small>{mode.detail}</small>
                </span>
              </button>
            );
          })}
        </div>

        {(actions.length > 0 || status) && (
          <div className="creation-launchpad__footer">
            {actions.length > 0 && (
              <div className="creation-launchpad__actions">
                <span className="creation-launchpad__start-label">or start from</span>
                {actions.map((action) => (
                  <button key={action.label} type="button" onClick={action.onClick} title={action.detail}>
                    <span aria-hidden="true">{action.icon}</span>
                    {action.label}
                  </button>
                ))}
              </div>
            )}
            {status && <div className="creation-launchpad__status">{status}</div>}
          </div>
        )}
      </div>
    </section>
  );
}
