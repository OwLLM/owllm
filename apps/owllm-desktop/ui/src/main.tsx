import React from "react";
import ReactDOM from "react-dom/client";
import AgentsPage from "./pages/AgentsPage";
import "./styles.css";

// TwinForge iteration target — for now we mount AgentsPage directly so
// the page is always visible at http://localhost:5173 for screenshot
// capture. App.tsx (the server-control UI) is preserved but unmounted;
// routing returns once a second page exists.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AgentsPage />
  </React.StrictMode>,
);
