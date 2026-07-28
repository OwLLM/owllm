# P0-6 · Fine-tuning environment doctor — notes

Completed 2026-06-13. Probes run:
1. Unit: 5 diagnosis-mapping tests incl. the Blackwell case (gpu_cc=120 vs
   torch arches up to sm_90 → named "sm_120 (Blackwell / RTX 50xx)" + repair).
2. Live (`probe_doctor_live_standard_env`): doctor against the real WSL
   `standard` env — all packages versioned, flash-attn degraded to warn,
   healthy. ~12s.
3. Live destructive (`probe_destructive_break_doctor_repair`): renamed
   bitsandbytes out of site-packages → doctor named it → REAL one-click
   repair (env_profile_install) → doctor healthy again. 28.6s (uv cache warm).

## What already existed (don't rebuild it)

The hardware-adaptive install was ALREADY done before this package:
`version_blackwell`/`index_blackwell` per package, `cuda_wheel` cu-index
resolution, `torch_backend: auto` (uv resolves a GPU-matched stack), uv
gating + auto-provision, atomic tmp→swap installs. The "pinned torch 2.5.1
locks out Blackwell" concern from the plan is handled in env_profiles.yaml
(torch 2.7.1/cu128 + bitsandbytes 0.45.3 on cc≥120). What was missing was
ONLY diagnosis: status checked file-existence + hash, so a broken env could
never say WHY. **Repair == the existing install command** — the doctor
deliberately has no install path of its own.

## Shape

- `env_profile_doctor(name)` → `EnvDoctorReport { checks[], healthy,
  repair_recommended, diagnosis }` in env_manager.rs.
- `DoctorProbes` (raw facts) → `build_doctor_report` (PURE mapping,
  unit-tested) — keep this split; it's what makes the failure taxonomy
  testable without a GPU zoo.
- In-venv python diagnostic emits ONE `OWLLM_DOCTOR=<json>` sentinel line
  (§0.5 banner-proof). torch info nests under `"v"` — the report builder
  reads `t["v"]`, a mismatch I shipped briefly; the unit tests caught it.
- Named failure classes: torch missing / CUDA libs broken (libcud*,
  undefined symbol) / CPU-only build / arch-too-new (cc > max sm_ in
  `torch.cuda.get_arch_list()`, matching torch's own warning semantics —
  ignore `compute_XX` PTX entries) / driver-can't-see-GPU / per-package
  missing-or-broken (optional ⇒ warn) / manifest drift ⇒ stale warn.
- UI: 🩺 Diagnose button per card in EnvironmentModal + checks panel +
  "Repair now" (calls the existing startEnvInstall). Doctor state is modal-
  local (ephemeral diagnostics — re-runs cheaply; the INSTALL state stays in
  the module-level envInstall store as before).

## Lessons

- `tauri::ipc::Channel::new(|_| Ok(()))` works in unit tests — you can drive
  the real `env_profile_install` from a probe test, no Tauri app needed.
- A full env reinstall with warm uv cache is ~25s — cheap enough that
  "Repair = reinstall" is the right one-click fix, no surgical per-package
  repair needed.
- `npx tsc --noEmit` on the UI has ~15 PRE-EXISTING errors in other pages
  (AgentsPage, BridgesPage, ModelsPage, TutorialRecorder, bridgeCore). Do
  not be alarmed; verify only that YOUR files produce none. The vite build
  doesn't gate on them.
- Importing torch in the venv dominates doctor latency (~10s). Fine for a
  button; do NOT wire the doctor into anything periodic.

## Remaining risks

- Non-Windows doctor path compiles via shared code but was not live-probed
  (this box is Windows; Linux runtime is P0-7 territory).
- Arch-mismatch live behavior on a real RTX 50xx still unverified on real
  silicon (unit-tested only). The `feedback_build_for_everyone` rule says
  treat user reports from Blackwell boxes as first-class evidence.
- The doctor doesn't yet check `uv`'s managed-python presence distinctly —
  venv python failing to exec reports as the generic "diagnostic run failed".
