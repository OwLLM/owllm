import { useEffect, useState } from "react";
import {
  ACCENTS,
  type AccentSelection,
  applyAccentToDocument,
  getInitialAccent,
  getInitialMode,
  THEME_ACCENT_KEY,
  THEME_MODE_KEY,
  type Mode,
} from "../lib/theme";

export default function ThemeToggle() {
  const [mode, setMode] = useState<Mode>("dark");
  const [accent, setAccent] = useState<AccentSelection>("indigo");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setMode(getInitialMode());
    setAccent(getInitialAccent());
  }, []);

  useEffect(() => {
    if (!mounted) return;
    document.documentElement.setAttribute("data-theme", mode);
    try {
      localStorage.setItem(THEME_MODE_KEY, mode);
    } catch {
      /* ignore */
    }
  }, [mode, mounted]);

  useEffect(() => {
    if (!mounted) return;
    applyAccentToDocument(accent);
    try {
      localStorage.setItem(THEME_ACCENT_KEY, accent);
    } catch {
      /* ignore */
    }
  }, [accent, mounted]);

  const toggleMode = () => {
    setMode((prev) => (prev === "dark" ? "light" : "dark"));
  };

  if (!mounted) {
    return (
      <div className="theme-toggle" aria-hidden="true">
        <span className="mode-placeholder" />
      </div>
    );
  }

  return (
    <div className="theme-toggle">
      <button
        type="button"
        className="mode-button"
        onClick={toggleMode}
        aria-label={`Switch to ${mode === "dark" ? "light" : "dark"} mode`}
        title={`Switch to ${mode === "dark" ? "light" : "dark"} mode`}
      >
        {mode === "dark" ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="12" cy="12" r="5" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        )}
        <span className="sr-only">{mode === "dark" ? "Dark mode" : "Light mode"}</span>
      </button>

      <div className="accent-swatches" role="group" aria-label="Accent color">
        {ACCENTS.map((a) => (
          <button
            key={a.key}
            type="button"
            className={`accent-swatch${accent === a.key ? " active" : ""}`}
            style={{ backgroundColor: a.color }}
            onClick={() => setAccent(a.key)}
            aria-label={`Set accent to ${a.label}`}
            aria-pressed={accent === a.key}
            title={a.label}
          />
        ))}
      </div>
    </div>
  );
}
