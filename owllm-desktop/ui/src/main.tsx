import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import AppShell from "./AppShell";
import ErrorBoundary from "./ErrorBoundary";
import UpdateController from "./UpdatePrompt";
import { ToastHost } from "./components/Toast";
import { ChatRuntimeProvider } from "./runtime/ChatRuntimeProvider";
import { bootstrapTheme } from "./theme";
import { bootstrapLocalization, LocalizationProvider } from "./localization";
import { restoreStateMirror, startStateMirror } from "./runtime/stateMirror";
import { installOwllmWebLinkInterceptor } from "./utils/openWebUrl";
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

// Route every plain user-facing http(s) link through OwLLM's persistent
// browser — including future <a href="https://…"> anchors no page wired up
// explicitly. Local file/download anchors are intentionally unaffected.
if (isTauriContext()) installOwllmWebLinkInterceptor();

function BootCover() {
  // The cover masks the startup flash until the first real frame paints.
  // All three platforms now ship an OPAQUE window (Linux went opaque with
  // the Jetson stale-pixel fix — see AppShell's opaque-Linux comment), so
  // an opaque cover is correct everywhere. On non-Tauri contexts (vite dev,
  // Playwright/TwinForge) we skip it so screenshots see real content.
  //
  // It paints var(--bg-panel) — the token every shell variant uses for the
  // app canvas — for the reason spelled out in index.html: the literal
  // #06080d this used to hardcode matches no theme, so the cover WAS a
  // flash. It mounts after the React tree, so in light mode the sequence
  // was near-black splash → near-white app → near-black cover → near-white
  // app: two full-contrast flips, both originating in this file.
  const [visible, setVisible] = React.useState(() => isTauriContext());

  React.useEffect(() => {
    if (!isTauriContext()) return; // no cover, no listener
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
        background: "var(--bg-panel, #06080d)",
        zIndex: 2147483647,
        pointerEvents: "none",
      }}
    />
  ) : null;
}

// Restore mirrored durable state (Coding pages, notebook, chat state) into
// localStorage BEFORE the first render — pages read localStorage in their
// useState initializers, so restoring later would miss the initial mount.
// restoreStateMirror never throws and self-times-out, so boot can't hang.
async function boot() {
  try {
    await restoreStateMirror();
  } catch {
    /* never block startup on recovery */
  }
  // Re-apply now that the mirror has rehydrated localStorage. On a WebView
  // profile change the theme keys are missing for the call at module scope
  // above, so that one paints the DEFAULT dark/indigo; without this the app
  // would only pick up the user's real theme when useTheme's state
  // initialisers read the restored values at mount — i.e. one frame late,
  // as a visible repaint. bootstrapTheme is memoised, so this costs nothing
  // in the normal case where localStorage was already intact.
  bootstrapTheme();
  startStateMirror();
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
      {/* Every page's transient notices land here — outside any composer. */}
      <ToastHost />
      <BootCover />
    </React.StrictMode>,
  );
}
void boot();
