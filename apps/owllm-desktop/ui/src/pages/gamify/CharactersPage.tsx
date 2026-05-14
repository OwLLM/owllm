import StubPage from "../../core/StubPage";

// Qt: LLM/desktop_app/pages/characters_3d_page.py. Avatar editor +
// persona dataset for the agent stack. Uses a Three.js viewport
// embedded inside the Qt host via QWebEngineView.
export default function CharactersPage() {
  return (
    <StubPage spec={{
      icon: "🧙‍♂️",
      title: "Characters",
      blurb: "Avatar/persona editor for the agent stack. Three.js viewport for the model preview + an attribute form for the persona spec. Will run entirely in the Tauri webview — no Python.",
      qtRef: "LLM/desktop_app/pages/characters_3d_page.py",
    }} />
  );
}
