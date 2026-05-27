import StubPage from "../../core/StubPage";

// Qt: main.py::_build_arena_sub_tab (line 20103). Model-vs-model
// arena — two loaded servers side by side, same prompt fed to both,
// human picks the winner. The "Chat" page also has a model-vs-model
// sub-tab; this is the legacy standalone version under Gamify.
export default function ArenaPage() {
  return (
    <StubPage spec={{
      icon: "🏟",
      title: "Arena",
      blurb: "Model-vs-model preference arena: same prompt to two running llama-server instances, you rate which response is better. Useful for evaluating fine-tuned variants. React talks to both /v1/chat/completions endpoints directly.",
      qtRef: "LLM/desktop_app/main.py:20103 _build_arena_sub_tab",
    }} />
  );
}
