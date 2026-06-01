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
import { chatRuntime, ChatRuntimeStore } from "./chatRuntime";

const ChatRuntimeContext = createContext<ChatRuntimeStore>(chatRuntime);

export function useChatRuntime(): ChatRuntimeStore {
  return useContext(ChatRuntimeContext);
}

export function ChatRuntimeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
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

    return () => {
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
