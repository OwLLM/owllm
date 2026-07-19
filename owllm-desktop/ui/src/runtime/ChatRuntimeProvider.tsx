// ChatRuntimeProvider — mounts the chat store above the router and hosts
// the global stream-control window listeners that must outlive page
// unmounts. Wraps <AppShell/> in main.tsx.
//
// Step 0 (scaffold): this just exposes the singleton via context and
// wires the two global events to the store. Pages don't consume it yet,
// so behaviour is unchanged. Later steps move ChatPage / AgentsPage chat
// state into the store.

import React, { createContext, useContext, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { chatRuntime, ChatRuntimeStore } from "./chatRuntime";
import { applyCachedRemoteCatalogue, refreshRemoteCatalogue } from "../pages/agentic/cloudCatalogue";
import { startVaultSync } from "./vaultSync";
import { migratePageSettings } from "../state/pageSettings";

// Apply the last cached remote model catalogue synchronously at module
// load so the picker shows up-to-date models on the very first render,
// even offline.
applyCachedRemoteCatalogue();

const ChatRuntimeContext = createContext<ChatRuntimeStore>(chatRuntime);
const USER_INTERACTED_KEY = "owllm:session:user-interacted";

export function useChatRuntime(): ChatRuntimeStore {
  return useContext(ChatRuntimeContext);
}

export function ChatRuntimeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Vault adoption may need a full repaint on a completely idle fresh boot,
    // but it must never restart the WebView after the user has begun working.
    // The sync engine reads this session-only flag before considering reload.
    const markUserInteraction = () => {
      try { sessionStorage.setItem(USER_INTERACTED_KEY, "1"); } catch { /* ignore */ }
    };
    window.addEventListener("pointerdown", markUserInteraction, { passive: true });
    window.addEventListener("keydown", markUserInteraction);

    // Global "stop everything" — fired by the dock Stop / dispatch-abort.
    const onAbort = () => chatRuntime.stopAll();
    window.addEventListener("owllm:dispatch-abort", onAbort);

    // Cold-load banner — dispatch.ts fires owllm:llama:loading on each
    // 503 retry. We can't know which session here, so this listener is a
    // no-op placeholder until pages register their active session; the
    // per-page banner wiring stays page-local for now (Step 0).

    // llama-ready (Tauri) — model finished loading into VRAM.
    let unlistenReady: (() => void) | null = null;
    listen("llama-ready", () => { /* pages clear their own banner today */ })
      .then((u) => { unlistenReady = u; })
      .catch(() => {});

    // Post-ship model updates: pull the latest cloud catalogue from the
    // remote registry once at startup. Fire-and-forget; on success new
    // models (e.g. a newly-released Claude) appear in the picker with no
    // rebuild. Failures keep the cached/bundled catalogue.
    refreshRemoteCatalogue(invoke).catch(() => {});

    // Consolidate legacy per-page/per-project model prefs into the sync-ready
    // settings document BEFORE the vault engine takes its first snapshot, so a
    // fresh device seeds and pushes the migrated copy. Idempotent + local-only.
    try { migratePageSettings(); } catch { /* never block boot on a pref migration */ }

    // Cross-device sync: adopt newer state from the user's owllm-vault, then
    // keep it pushed. No-ops when logged out / no vault (local-only).
    startVaultSync().catch(() => {});

    return () => {
      window.removeEventListener("pointerdown", markUserInteraction);
      window.removeEventListener("keydown", markUserInteraction);
      window.removeEventListener("owllm:dispatch-abort", onAbort);
      unlistenReady?.();
    };
  }, []);

  return (
    <ChatRuntimeContext.Provider value={chatRuntime}>
      {children}
    </ChatRuntimeContext.Provider>
  );
}
