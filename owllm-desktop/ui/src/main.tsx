import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import AppShell from "./AppShell";
import ErrorBoundary from "./ErrorBoundary";
import { ChatRuntimeProvider } from "./runtime/ChatRuntimeProvider";
import { bootstrapTheme } from "./theme";
import "./styles.css";

// Tauri 2's updater plugin does NOT auto-poll; the dialog:true config
// in tauri.conf.json is a v1 leftover that does nothing in v2. You
// have to explicitly call check() from JS. Without this code, the
// in-app "Update available" dialog never fires no matter what's in
// latest.json.
//
// Triggered once on app boot, ~2 seconds after the window is shown so
// network probing doesn't compete with the first paint. Errors are
// swallowed: if the user is offline / behind a corp proxy / the
// endpoint is briefly 404, we just don't prompt — they can re-launch.
async function maybeOfferUpdate() {
  try {
    const [{ check }, { ask }, { relaunch }] = await Promise.all([
      import("@tauri-apps/plugin-updater"),
      import("@tauri-apps/plugin-dialog"),
      import("@tauri-apps/plugin-process"),
    ]);
    const update = await check();
    if (!update) return;
    const proceed = await ask(
      `A new version is available: ${update.version}\n\n${update.body ?? ""}\n\nInstall now? The app will restart.`,
      { title: "OwLLM Desktop — Update available", kind: "info" },
    );
    if (!proceed) return;
    await update.downloadAndInstall();
    await relaunch();
  } catch (e) {
    console.warn("[updater] check failed:", e);
  }
}

if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
  // Delay so the boot cover + first paint complete before the network
  // call. The dialog still appears within seconds of the window being
  // interactive.
  window.setTimeout(maybeOfferUpdate, 2500);
}

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
    <BootCover />
  </React.StrictMode>,
);
