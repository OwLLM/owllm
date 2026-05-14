import React from "react";
import ReactDOM from "react-dom/client";
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
