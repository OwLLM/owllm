import StubPage from "../../core/StubPage";

// Qt: main.py::_build_logs_tab (line 27594). Aggregated log viewer
// (app.log, freeze_diag.log, install_errors.log, training session
// logs). Filtered by stream + level, with a Live tail toggle.
export default function LogsPage() {
  return (
    <StubPage spec={{
      icon: "📊",
      title: "Logs",
      blurb: "Aggregated viewer for the live app log, freeze diagnostics, install errors, and training-session logs. Native impl tails the log files via tokio::fs::watch and pushes deltas to React over a Tauri event channel — same pattern as server-log.",
      qtRef: "LLM/desktop_app/main.py:27594 _build_logs_tab",
    }} />
  );
}
