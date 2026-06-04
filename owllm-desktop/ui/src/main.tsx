import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import AppShell from "./AppShell";
import ErrorBoundary from "./ErrorBoundary";
import UpdateController from "./UpdatePrompt";
import { ChatRuntimeProvider } from "./runtime/ChatRuntimeProvider";
import { bootstrapTheme } from "./theme";
import "./styles.css";

// Apply the persisted theme BEFORE the first React render so the very
// first frame paints with the correct background / accent. Otherwise
// users on light mode would see a flash of the dark default.
bootstrapTheme();

// Detect whether we're inside the actual Tauri webview. When running
// under `vite dev` in a plain browser (or under Playwright for
// TwinForge captures), there's no `__TAURI_INTERNALS__`, the
// `owllm:shown` event never fires, and the BootCover would otherwise
// black out the whole screenshot. In that case we render no cover at
// all so the React UI is immediately visible to whoever opens the URL.
function isTauriContext(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as any;
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__ || w.__TAURI_METADATA__);
}

function BootCover() {
  // Tauri-only: in non-Tauri contexts (vite dev, Playwright/TwinForge)
  // we skip the cover entirely so screenshots see real content.
  const [visible, setVisible] = React.useState(() => isTauriContext());

  React.useEffect(() => {
    if (!isTauriContext()) return; // no listener, no fallback timer
    let alive = true;
    // Shorter fallback (was 3000 ms) so even Tauri builds reveal within
    // any reasonable screenshot window if `owllm:shown` happens to be
    // missed (it's emitted from Rust on_page_load Finished).
    let fallback = window.setTimeout(() => {
      if (alive) setVisible(false);
    }, 1500);

    listen("owllm:shown", () => {
      window.clearTimeout(fallback);
      fallback = window.setTimeout(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (alive) setVisible(false);
            });
          });
        });
      }, 180);
    }).catch(() => {
      window.clearTimeout(fallback);
      if (alive) setVisible(false);
    });

    return () => {
      alive = false;
      window.clearTimeout(fallback);
    };
  }, []);

  return visible ? (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#06080d",
        zIndex: 2147483647,
        pointerEvents: "none",
      }}
    />
  ) : null;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ChatRuntimeProvider>
        <AppShell />
      </ChatRuntimeProvider>
    </ErrorBoundary>
    <UpdateController />
    <BootCover />
  </React.StrictMode>,
);
