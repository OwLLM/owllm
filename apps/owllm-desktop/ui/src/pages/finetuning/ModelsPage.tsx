import StubPage from "../../core/StubPage";

// Qt: main.py::_build_models_tab (line 7997). Catalog + downloader for
// HF models, GGUF browser, per-variant download/install/delete. Heavy
// page — uses background download threads, GGUF probe, disk-usage
// reporting. Native impl will use reqwest + indicatif + a small
// `models_catalog` Tauri command surface.
export default function ModelsPage() {
  return (
    <StubPage spec={{
      icon: "📦",
      ownlPng: "/Page_icons/owl_training.png",
      title: "Models",
      blurb: "Browse / search / download Hugging Face models and GGUF variants. Tracks per-variant disk usage, install state, and onboarding readiness. Native impl will mirror the Qt download manager but run all subprocesses with CREATE_NO_WINDOW.",
      qtRef: "LLM/desktop_app/main.py:7997 _build_models_tab",
    }} />
  );
}
