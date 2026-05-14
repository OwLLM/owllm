import StubPage from "../../core/StubPage";

// Qt: main.py::_build_environment_management_page (line 25680) +
// _build_environments_subtab (25728). Per-model virtual environments:
// list, repair, recreate, inspect pip freeze, switch active env.
export default function EnvironmentPage() {
  return (
    <StubPage spec={{
      icon: "⚙️",
      title: "Environment",
      blurb: "Manage per-model Python virtualenvs. Each model variant has its own env (specific torch/cuda/llama-cpp wheels). Native impl scans LLM/.envs/ + LLM/python_runtime/ and exposes 'repair env' / 'recreate env' as Tauri commands that shell pip in a non-window subprocess.",
      qtRef: "LLM/desktop_app/main.py:25680 _build_environment_management_page",
    }} />
  );
}
