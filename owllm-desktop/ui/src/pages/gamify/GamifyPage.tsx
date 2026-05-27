import StubPage from "../../core/StubPage";

// Qt: main.py — Gamify hosts the merged 3D playground (characters
// + arena). Renders a Three.js scene with custom characters, NPCs,
// and quest UI. Heavy work; would benefit from a Web-Worker render
// pipeline.
export default function GamifyPage() {
  return (
    <StubPage spec={{
      icon: "🎮",
      ownlPng: "/Page_icons/owl_studio_square.png",
      title: "Gamify",
      blurb: "3D playground: custom characters + scripted scenarios + quests. Replaces the legacy Characters/Arena split. Native impl will render via Three.js (or a Rust wgpu canvas) — Tauri webview handles it directly, no Python in the loop.",
      qtRef: "LLM/desktop_app/main.py merged Gamify toggle (Characters + Arena)",
    }} />
  );
}
