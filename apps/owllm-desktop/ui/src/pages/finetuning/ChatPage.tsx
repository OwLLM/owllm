import StubPage from "../../core/StubPage";

// Qt: main.py::_build_test_tab (line 18310) + _build_test_sub_tab
// (18396) + _build_tool_chat_sub_tab (19025) + _build_model_to_model
// _sub_tab (19256). Multi-pane chat for testing a loaded model:
// classical chat, tool-use chat, and model-vs-model comparison.
export default function ChatPage() {
  return (
    <StubPage spec={{
      icon: "💬",
      ownlPng: "/Page_icons/owl_chat.png",
      title: "Chat",
      blurb: "Direct chat with the running model. Three sub-modes in Qt: free chat, tool-augmented chat, and model-vs-model arena. Native impl talks to the local llama-server's /v1/chat/completions endpoint directly from React (no Rust proxy needed).",
      qtRef: "LLM/desktop_app/main.py:18310 _build_test_tab",
    }} />
  );
}
