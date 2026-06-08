import StubPage from "../../core/StubPage";

// The legacy Qt "Environment" page managed one Python venv PER MODEL —
// obsolete under GGUF inference (no per-model Python). The live concept is
// per-SCENARIO fine-tuning envs (pinned torch/CUDA/peft), and they're now
// managed where they're used: the Train page's "Environment" card (pick +
// install/repair, streamed logs). On Windows they build + run inside WSL.
// Backend: src-tauri/src/env_manager.rs (env_profiles_list / _status /
// _install / _uninstall). This page is kept only as a signpost.
export default function EnvironmentPage() {
  return (
    <StubPage spec={{
      icon: "🐧",
      title: "Environment",
      blurb: "Fine-tuning Python environments moved to the Train page → the “🐧 Environment” card, where you pick a profile and Install/Repair it (live log). On Windows they’re built and run inside WSL, and torch auto-matches your GPU’s CUDA. There’s no longer a per-model venv to manage here.",
      qtRef: "owllm-desktop/src-tauri/src/env_manager.rs (env_profile_install/status)",
    }} />
  );
}
