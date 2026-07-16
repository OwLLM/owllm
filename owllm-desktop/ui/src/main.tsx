import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import AppShell from "./AppShell";
import ErrorBoundary from "./ErrorBoundary";
import UpdateController from "./UpdatePrompt";
import { ChatRuntimeProvider } from "./runtime/ChatRuntimeProvider";
import { bootstrapTheme } from "./theme";
import { bootstrapLocalization, LocalizationProvider } from "./localization";
import "./styles.css";

// Apply the persisted theme BEFORE the first React render so the very
// first frame paints with the correct background / accent. Otherwise
// users on light mode would see a flash of the dark default.
bootstrapTheme();
bootstrapLocalization();

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

// webkit2gtk (Linux) is the only Tauri webview whose UA reports "Linux";
// WebView2 (Windows) and WKWebView (macOS) never do.
function isLinuxWebview(): boolean {
  if (typeof navigator === "undefined") return false;
  return navigator.userAgent.indexOf("Linux") !== -1;
}

function BootCover() {
  // The cover masks the WINDOWS overlay-frame startup flash on the OPAQUE
  // window. Linux ships a TRANSPARENT window (tauri.linux.conf.json) with the
  // frame drawn in-page and NO overlay window, so an opaque cover there just
  // paints a solid dark rectangle over the see-through window until it lifts —
  // that IS the "solid at start → flips transparent / semi-transparent dark"
  // flicker (the lift is gated on owllm:shown + timers, hence the racey end
  // state). On Linux we render no cover at all; on non-Tauri contexts (vite
  // dev, Playwright/TwinForge) we also skip it so screenshots see real content.
  const [visible, setVisible] = React.useState(() => isTauriContext() && !isLinuxWebview());

  React.useEffect(() => {
    if (!isTauriContext() || isLinuxWebview()) return; // no cover, no listener
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
      <LocalizationProvider>
        <ChatRuntimeProvider>
          <AppShell />
        </ChatRuntimeProvider>
      </LocalizationProvider>
    </ErrorBoundary>
    <UpdateController />
    <BootCover />
  </React.StrictMode>,
);
