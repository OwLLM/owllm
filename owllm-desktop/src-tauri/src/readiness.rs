// Home-page "Software Requirements & Setup" panel — REAL readiness.
//
// The Qt port shipped four hardcoded rows (Python 3.8+ / PyTorch /
// CUDA / Dependencies) that printed the same fake versions on every
// machine. They were never wired to a probe, and they describe a
// host-Python world that no longer exists — fine-tuning runs in a
// WSL/uv environment now.
//
// This command replaces them with four signals that genuinely gate
// features, each read live:
//   1. WSL / Ubuntu        → wsl::wsl_status()        (fine-tune + tool sandbox)
//   2. GPU & CUDA driver   → hardware probe + nvidia-smi banner
//   3. Fine-tuning env     → env_manager default profile status
//   4. Local LLM runtime   → paths::llama_server_exe()
//
// Each row carries ok / warn so the UI can show ✅ / ⚠️ / ❌ exactly
// like System Status does.

use serde::Serialize;

use crate::{env_manager, hardware, paths};

#[derive(Serialize, Clone, Default)]
pub struct ReadinessRow {
    /// true → ✅ green; false → ❌ red (unless `warn`).
    pub ok: bool,
    /// true → ⚠️ orange "works but degraded" (e.g. CPU-only, no GPU).
    pub warn: bool,
    /// Right-aligned detail string (version / path / hint).
    pub detail: String,
}

#[derive(Serialize, Clone, Default)]
pub struct AppReadiness {
    pub wsl: ReadinessRow,
    pub gpu: ReadinessRow,
    pub env: ReadinessRow,
    pub runtime: ReadinessRow,
}

#[tauri::command]
pub async fn app_readiness() -> Result<AppReadiness, String> {
    Ok(AppReadiness {
        wsl: probe_wsl(),
        gpu: probe_gpu().await,
        env: probe_env().await,
        runtime: probe_runtime(),
    })
}

fn probe_wsl() -> ReadinessRow {
    // Delegate to the guided-setup probe so this row reflects the SAME stages
    // the "Set up WSL" dialog acts on. The old check returned ok=true the
    // moment any distro existed — even a root-only one with no Linux user —
    // which hid the Set-up button and left the user with no path to create
    // their account. Now a missing user / Python / pending reboot shows as a
    // warn so the button appears and routes straight to the right step.
    let st = crate::wsl_setup::wsl_setup_status();
    let distro = st
        .default_distro
        .clone()
        .unwrap_or_else(|| "Ubuntu".to_string());
    match st.stage.as_str() {
        "ready" => ReadinessRow {
            ok: true,
            warn: false,
            detail: st
                .default_user
                .map(|u| format!("{distro} · {u}"))
                .unwrap_or(distro),
        },
        "needsUser" => ReadinessRow {
            ok: false,
            warn: true,
            detail: "Ubuntu installed — no Linux user yet · Set up WSL".to_string(),
        },
        "needsPython" => ReadinessRow {
            ok: false,
            warn: true,
            detail: "Ubuntu installed — needs Python · Set up WSL".to_string(),
        },
        "needsReboot" => ReadinessRow {
            ok: false,
            warn: true,
            detail: "Installed — reboot to finish · Set up WSL".to_string(),
        },
        "needsDistro" => ReadinessRow {
            // WSL IS installed — it just only has Docker's distro, not a real
            // Linux. Say so honestly instead of the old "Not installed" lie.
            ok: false,
            warn: true,
            detail: "WSL installed (Docker only) — add Ubuntu · Set up WSL".to_string(),
        },
        "virtualizationOff" => ReadinessRow {
            ok: false,
            warn: false,
            detail: "Enable virtualization in BIOS · Set up WSL".to_string(),
        },
        "unsupported" => ReadinessRow {
            ok: true,
            warn: false,
            detail: "Not required on this OS".to_string(),
        },
        _ => ReadinessRow {
            ok: false,
            warn: false,
            detail: "Not installed · Set up WSL".to_string(),
        },
    }
}

async fn probe_gpu() -> ReadinessRow {
    // hardware_info always returns Ok; degrade gracefully on any error.
    let hw = hardware::hardware_info().await.unwrap_or_default();
    let cuda = hardware::cuda_driver_version().await;
    if hw.gpus.is_empty() {
        return ReadinessRow {
            ok: false,
            warn: true, // not fatal — inference falls back to CPU
            detail: "No GPU detected — CPU only".to_string(),
        };
    }
    let first = hw.gpus[0].name.clone();
    let unified = hw.gpus[0].unified;
    let extra = hw.gpus.len().saturating_sub(1);
    let mut detail = if extra > 0 {
        format!("{first} +{extra}")
    } else {
        first
    };
    if unified {
        detail = format!("{detail} · {:.0} GB unified memory", hw.gpus[0].vram_gb);
    }
    match cuda {
        Some(v) => detail = format!("{detail} · CUDA {v}"),
        // Non-NVIDIA (Apple/AMD/Intel): no CUDA is expected, not a defect.
        None if unified => {}
        None => detail = format!("{detail} · driver CUDA n/a"),
    }
    ReadinessRow {
        ok: true,
        warn: false,
        detail,
    }
}

async fn probe_env() -> ReadinessRow {
    // Report the BEST state across ALL fine-tuning profiles. Checking only
    // the first ("standard") missed a user whose ONLY installed profile was
    // unsloth: Train showed it ready while Home insisted "Not set up"
    // (bug report #33). A ready profile short-circuits, so the common
    // installed case stays a single status probe.
    let profiles = match env_manager::env_profiles_list().await {
        Ok(p) => p,
        Err(e) => {
            return ReadinessRow {
                ok: false,
                warn: true,
                detail: format!("profile list error: {e}"),
            }
        }
    };
    if profiles.is_empty() {
        return ReadinessRow {
            ok: false,
            warn: true,
            detail: "No fine-tuning profiles defined".to_string(),
        };
    }
    // Best non-ready state seen so far, ranked: installing > stale > broken > error.
    let mut fallback: Option<(u8, String)> = None;
    for p in &profiles {
        let label = p.display.clone();
        let (rank, detail) = match env_manager::env_profile_status(p.name.clone()).await {
            Ok(env_manager::EnvProfileState::Ready { .. }) => {
                return ReadinessRow {
                    ok: true,
                    warn: false,
                    detail: format!("{label} · ready"),
                }
            }
            Ok(env_manager::EnvProfileState::Installing) => (0u8, format!("{label} · installing…")),
            Ok(env_manager::EnvProfileState::Stale { .. }) => {
                (1, format!("{label} · update available"))
            }
            Ok(env_manager::EnvProfileState::Broken { .. }) => {
                (2, format!("{label} · needs repair"))
            }
            Ok(env_manager::EnvProfileState::NotInstalled) => continue,
            Err(e) => (3, format!("env check failed: {e}")),
        };
        if fallback.as_ref().map(|(r, _)| rank < *r).unwrap_or(true) {
            fallback = Some((rank, detail));
        }
    }
    ReadinessRow {
        ok: false,
        warn: true, // optional until the user wants to train
        detail: fallback
            .map(|(_, d)| d)
            .unwrap_or_else(|| "Not set up — install on Train".to_string()),
    }
}

fn probe_runtime() -> ReadinessRow {
    match paths::llama_server_exe() {
        Some(_) => ReadinessRow {
            ok: true,
            warn: false,
            detail: "llama.cpp server found".to_string(),
        },
        None => ReadinessRow {
            ok: false,
            warn: false,
            detail: "Not installed — add the local-inference module".to_string(),
        },
    }
}
