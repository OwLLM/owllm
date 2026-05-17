import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import AppShell from "./AppShell";
import { bootstrapTheme } from "./theme";
import "./styles.css";

// Apply the persisted theme BEFORE the first React render so the very
// first frame paints with the correct background / accent. Otherwise
// users on light mode would see a flash of the dark default.
bootstrapTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppShell />
  </React.StrictMode>,
);

// Show the OS window only AFTER React has painted its first frame.
// tauri.conf.json sets `visible: false` so the window is created
// hidden — without this call it would stay hidden forever. The
// requestAnimationFrame loop waits one paint cycle so the window
// appears with the dark theme already rendered, eliminating the
// white WebView2 flash that the MSVC build otherwise shows.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    getCurrentWindow().show().catch((e) => {
      // If we ever ship a non-Tauri build (web preview, Storybook…)
      // this invoke fails harmlessly — the window concept doesn't
      // exist there. Silent catch keeps the boot path clean.
      console.warn("window.show() failed:", e);
    });
  });
});
