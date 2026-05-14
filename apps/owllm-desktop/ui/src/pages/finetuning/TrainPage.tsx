import StubPage from "../../core/StubPage";

// Qt: main.py::_build_train_tab (line 14511). Fine-tuning dashboard:
// pick dataset, choose base model, LoRA params, watch loss curve,
// resume from checkpoint, export adapter. This is the FIRST page
// that will spawn Python on-demand (training scripts in an isolated
// venv) — every other page is pure Rust.
export default function TrainPage() {
  return (
    <StubPage spec={{
      icon: "🎯",
      ownlPng: "/Page_icons/owl_FineTuning.png",
      title: "Train",
      blurb: "Fine-tune a base model on your dataset. LoRA / QLoRA / full-finetune. Watches loss / lr / step curves live. This is the only page that invokes Python — a one-shot training subprocess in a per-recipe isolated venv. Native shell, Python guest.",
      qtRef: "LLM/desktop_app/main.py:14511 _build_train_tab",
    }} />
  );
}
