import StubPage from "../../core/StubPage";

// Qt: main.py::_build_info_tab (line 27273). Shows app/version,
// hardware summary, dependency status, build hash, links to docs.
export default function InfoPage() {
  return (
    <StubPage spec={{
      icon: "ℹ️",
      ownlPng: "/Page_icons/owl_startup.png",
      title: "Info",
      blurb: "App version, build hash, runtime versions, and links to docs. The Qt source builds this from the live SystemDetector probe and a few static metadata fields — to be ported once a small `app_info` Tauri command exposes the equivalent.",
      qtRef: "LLM/desktop_app/main.py:27273 _build_info_tab",
    }} />
  );
}
