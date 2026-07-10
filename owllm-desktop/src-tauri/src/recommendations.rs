// recommendations — curated list of ~20 popular base models with size +
// hardware-aware compatibility ranking. Replaces the hand-typed list in
// React with a real Rust source of truth.
//
// Selection criteria (held constant — refresh manually as new SOTA
// models drop):
//   • >10K monthly downloads on HF
//   • Maintained / non-deprecated
//   • Covers small / mid / large size tiers so users on any hardware
//     see "Fits" cards, not just "Too large"
//   • Mix of instruct / chat / reasoning / vision so all card filters
//     have something to show
//
// VRAM math used for compat:
//   • inference_gb  ≈ params_b * 2  (fp16 weight bytes)
//   • lora_train_gb ≈ inference_gb * 2  (weights + activations + opt)
//   • qlora_gb      ≈ inference_gb * 0.5  (4-bit base)
// "Fits" = lora_train_gb <= user_vram_gb (training headroom).
// "Tight" = inference_gb <= user_vram_gb < lora_train_gb (runs but no
//   training room).
// "Too large" = inference_gb > user_vram_gb (won't even load).

use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecommendedModel {
    pub id: String,
    pub name: String,
    pub family: String,
    pub description: String,
    pub params_b: f32,
    pub inference_gb: f32,
    pub lora_train_gb: f32,
    pub qlora_gb: f32,
    /// HF download count snapshot at curation time. Real count is
    /// fetched via hf_search and overrides this when the UI shows live
    /// data.
    pub downloads: u64,
    pub likes: u64,
    pub is_new: bool,
    pub gated: bool,
    pub tags: Vec<String>,
    /// One of: "instruct" / "chat" / "reasoning" / "vision" / "code".
    pub category: String,
    /// compat tag computed from current VRAM. None when no NVIDIA GPU
    /// is detected — UI hides the badge in that case rather than
    /// guessing.
    pub compat: Option<CompatTag>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompatTag {
    pub color: String, // "green" | "orange" | "red" | "gray"
    pub text: String,
    pub tooltip: String,
}

/// Static curated set. Numbers come from HF model cards as of
/// 2026-05-20. params_b is parameter count in billions; the GB columns
/// fall out of the formulas above (we precompute so the React side
/// doesn't have to).
fn curated() -> Vec<Seed> {
    vec![
        // ---- Small (fits even on 6 GB cards) ----
        Seed::new(
            "meta-llama/Llama-3.2-1B-Instruct",
            "Llama 3.2 1B Instruct",
            "Llama",
            1.2,
            "Tiny Llama for edge / CPU use. Best for fast iteration.",
            "instruct",
            850_000,
            6_400,
            true,
            true,
        ),
        Seed::new(
            "meta-llama/Llama-3.2-3B-Instruct",
            "Llama 3.2 3B Instruct",
            "Llama",
            3.2,
            "Mid-small Llama. Sweet spot for laptops with 8 GB GPUs.",
            "instruct",
            1_400_000,
            10_200,
            true,
            true,
        ),
        Seed::new(
            "Qwen/Qwen2.5-1.5B-Instruct",
            "Qwen 2.5 1.5B Instruct",
            "Qwen",
            1.5,
            "Compact Qwen — strong multilingual for its size.",
            "instruct",
            320_000,
            2_700,
            true,
            false,
        ),
        Seed::new(
            "google/gemma-2-2b-it",
            "Gemma 2 2B IT",
            "Gemma",
            2.6,
            "Google's small instruction-tuned model.",
            "instruct",
            580_000,
            5_100,
            false,
            true,
        ),
        Seed::new(
            "microsoft/Phi-3.5-mini-instruct",
            "Phi 3.5 mini",
            "Phi",
            3.8,
            "MS Phi 3.5 — punches above its weight on reasoning.",
            "reasoning",
            420_000,
            3_800,
            true,
            false,
        ),
        // ---- Mid (fits on 16–24 GB cards) ----
        Seed::new(
            "meta-llama/Llama-3.1-8B-Instruct",
            "Llama 3.1 8B Instruct",
            "Llama",
            8.0,
            "The default chat workhorse. Strong on general tasks.",
            "instruct",
            4_200_000,
            28_400,
            false,
            true,
        ),
        Seed::new(
            "Qwen/Qwen2.5-7B-Instruct",
            "Qwen 2.5 7B Instruct",
            "Qwen",
            7.6,
            "Best mid-size model for multilingual + code tasks.",
            "instruct",
            1_900_000,
            14_300,
            true,
            false,
        ),
        Seed::new(
            "mistralai/Mistral-7B-Instruct-v0.3",
            "Mistral 7B Instruct v0.3",
            "Mistral",
            7.3,
            "Mistral's reliable 7B instruct — Apache-2.0 friendly.",
            "instruct",
            2_800_000,
            18_700,
            false,
            false,
        ),
        Seed::new(
            "google/gemma-2-9b-it",
            "Gemma 2 9B IT",
            "Gemma",
            9.2,
            "Google's mid-tier instruct model. Best Gemma for chat.",
            "chat",
            760_000,
            7_400,
            false,
            true,
        ),
        Seed::new(
            "01-ai/Yi-1.5-9B-Chat",
            "Yi 1.5 9B Chat",
            "Yi",
            8.8,
            "Yi chat — strong English + Chinese performance.",
            "chat",
            110_000,
            1_800,
            false,
            false,
        ),
        Seed::new(
            "deepseek-ai/deepseek-coder-6.7b-instruct",
            "DeepSeek Coder 6.7B",
            "DeepSeek",
            6.7,
            "Code-tuned base model. Use for repo-level coding tasks.",
            "code",
            540_000,
            4_300,
            false,
            false,
        ),
        Seed::new(
            "Qwen/QwQ-32B-Preview",
            "QwQ 32B Preview",
            "Qwen",
            32.5,
            "Qwen's reasoning preview — chain-of-thought tuned.",
            "reasoning",
            420_000,
            7_800,
            true,
            false,
        ),
        Seed::new(
            "microsoft/Phi-3-medium-4k-instruct",
            "Phi 3 Medium 4k",
            "Phi",
            14.0,
            "MS Phi 3 medium — 4k context, instruction-tuned.",
            "instruct",
            280_000,
            2_200,
            false,
            false,
        ),
        // ---- Large (fits on 48 GB+ cards or with QLoRA on 24 GB) ----
        Seed::new(
            "mistralai/Mistral-Nemo-Instruct-2407",
            "Mistral Nemo 12B Instruct",
            "Mistral",
            12.2,
            "Mistral + NVIDIA collab. 128k context, strong instruct.",
            "instruct",
            1_200_000,
            9_500,
            false,
            false,
        ),
        Seed::new(
            "Qwen/Qwen2.5-32B-Instruct",
            "Qwen 2.5 32B Instruct",
            "Qwen",
            32.5,
            "Larger Qwen — frontier-level reasoning on consumer 48 GB.",
            "instruct",
            680_000,
            5_300,
            true,
            false,
        ),
        Seed::new(
            "deepseek-ai/DeepSeek-V2-Lite",
            "DeepSeek V2 Lite",
            "DeepSeek",
            15.7,
            "DeepSeek MoE — small active params, huge expert pool.",
            "instruct",
            220_000,
            1_900,
            false,
            false,
        ),
        Seed::new(
            "meta-llama/Llama-3.1-70B-Instruct",
            "Llama 3.1 70B Instruct",
            "Llama",
            70.0,
            "Frontier-tier chat. Needs 2×A100 or QLoRA on 48 GB.",
            "chat",
            2_100_000,
            18_200,
            false,
            true,
        ),
        Seed::new(
            "Qwen/Qwen2.5-72B-Instruct",
            "Qwen 2.5 72B Instruct",
            "Qwen",
            72.7,
            "Top-tier Qwen. Same hardware ask as Llama 70B.",
            "chat",
            480_000,
            4_900,
            true,
            false,
        ),
        Seed::new(
            "mistralai/Mixtral-8x7B-Instruct-v0.1",
            "Mixtral 8×7B Instruct",
            "Mistral",
            46.7,
            "Mixtral MoE — ~12B active params per token.",
            "instruct",
            1_400_000,
            12_400,
            false,
            false,
        ),
        // ---- Vision ----
        Seed::new(
            "Qwen/Qwen2-VL-7B-Instruct",
            "Qwen2-VL 7B",
            "Qwen",
            8.3,
            "Vision-language Qwen. Image + text in, text out.",
            "vision",
            540_000,
            4_900,
            true,
            false,
        ),
    ]
}

struct Seed {
    id: &'static str,
    name: &'static str,
    family: &'static str,
    params_b: f32,
    description: &'static str,
    category: &'static str,
    downloads: u64,
    likes: u64,
    is_new: bool,
    gated: bool,
}
impl Seed {
    fn new(
        id: &'static str,
        name: &'static str,
        family: &'static str,
        params_b: f32,
        description: &'static str,
        category: &'static str,
        downloads: u64,
        likes: u64,
        is_new: bool,
        gated: bool,
    ) -> Self {
        Self {
            id,
            name,
            family,
            params_b,
            description,
            category,
            downloads,
            likes,
            is_new,
            gated,
        }
    }
}

fn tags_for(seed: &Seed) -> Vec<String> {
    let mut t = Vec::new();
    match seed.category {
        "instruct" => {
            t.push("instruct".into());
        }
        "chat" => {
            t.push("chat".into());
        }
        "reasoning" => {
            t.push("reasoning".into());
            t.push("instruct".into());
        }
        "vision" => {
            t.push("vision".into());
        }
        "code" => {
            t.push("code".into());
            t.push("instruct".into());
        }
        _ => {}
    }
    // Every HF base model in our list is trainable (transformers format
    // with full weights). Adapters/quantized variants would be tagged
    // separately if/when we add them.
    t.push("trainable".into());
    t
}

/// Parse the parameter-count "Nb" / "N.NB" hint out of a model name
/// or directory slug. Returns the first match (left-to-right). Used by
/// the Downloaded and Tuned card builders so they can produce the same
/// GPU-fit badge the curated Browse cards use.
///
/// Examples:
///   "Llama-3.1-8B-Instruct"     → Some(8.0)
///   "unsloth__gemma-2-2b-it"    → Some(2.0)
///   "Qwen2.5-7B-Instruct"       → Some(7.0)
///   "Mixtral-8x7B-Instruct"     → Some(7.0)  // active params (best effort)
///   "260504_kbeauty_finetune"   → None
pub fn parse_params_b(model_name: &str) -> Option<f32> {
    let bytes = model_name.as_bytes();
    let n = bytes.len();
    let mut i = 0;
    while i < n {
        if bytes[i].is_ascii_digit() {
            let num_start = i;
            while i < n && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i + 1 < n && bytes[i] == b'.' && bytes[i + 1].is_ascii_digit() {
                i += 1;
                while i < n && bytes[i].is_ascii_digit() {
                    i += 1;
                }
            }
            let num_end = i;
            while i < n && bytes[i] == b' ' {
                i += 1;
            }
            if i < n && (bytes[i] == b'b' || bytes[i] == b'B') {
                let after = i + 1;
                let is_boundary = after >= n || !bytes[after].is_ascii_alphabetic();
                if is_boundary {
                    let s = std::str::from_utf8(&bytes[num_start..num_end]).ok()?;
                    return s.parse::<f32>().ok();
                }
            }
            i = num_start + 1;
        } else {
            i += 1;
        }
    }
    None
}

/// Convenience: given a parsed params_b + detected VRAM, return the
/// same compat tag we attach to curated Browse cards. Hides the
/// inference/lora/qlora arithmetic from callers that only know the
/// parameter count (Downloaded + Tuned card builders).
pub fn compat_for_params(params_b: f32, vram_gb: Option<f32>) -> Option<CompatTag> {
    if params_b <= 0.0 {
        return None;
    }
    let inference_gb = params_b * 2.0;
    let lora_train_gb = inference_gb * 2.0;
    let qlora_gb = inference_gb * 0.5;
    compat_for(inference_gb, lora_train_gb, qlora_gb, vram_gb)
}

/// Compat tag for a Downloaded GGUF. The .gguf file size IS the
/// runtime memory footprint (weights mmap'd directly + ~10–15 %
/// overhead for KV cache, scratch buffers). Using actual bytes here
/// is far more accurate than `params_b * 2` — that path assumes FP16
/// and was flagging quantised models like Qwen3.6-35B-A3B-Q4_K_S
/// (19.5 GB on disk, fits a 22.5 GB GPU comfortably) as 'Too large'
/// because it read "35B" and decided 70 GB FP16 wouldn't fit. MoE
/// models hit the same trap — the active-params number doesn't
/// reduce the weight footprint, but the actual file size already
/// reflects what's on disk.
pub fn compat_for_gguf_size(file_bytes: u64, vram_gb: Option<f32>) -> Option<CompatTag> {
    let v = vram_gb?;
    let weights_gb = file_bytes as f32 / (1024.0 * 1024.0 * 1024.0);
    // 5 % runtime overhead — at the default 4 K context window the KV
    // cache for a 35 B Q4 model is ~0.5 GB; activation buffers another
    // ~0.2 GB. Applies to BOTH GGUF and pre-quantised HF formats
    // (bnb-4bit, etc.) — the file on disk is the runtime footprint.
    let runtime_gb = weights_gb * 1.05;
    if runtime_gb <= v * 0.95 {
        Some(CompatTag {
            color: "green".into(),
            text: "Fits".into(),
            tooltip: format!(
                "On-disk {:.1} GB; runtime ≈{:.1} GB fits your {:.1} GB VRAM with room for the default context window.",
                weights_gb, runtime_gb, v,
            ),
        })
    } else if runtime_gb <= v {
        Some(CompatTag {
            color: "orange".into(),
            text: "Tight fit".into(),
            tooltip: format!(
                "On-disk {:.1} GB; runtime ≈{:.1} GB just inside your {:.1} GB VRAM — keep the context window short.",
                weights_gb, runtime_gb, v,
            ),
        })
    } else {
        Some(CompatTag {
            color: "red".into(),
            text: "Too large".into(),
            tooltip: format!(
                "On-disk {:.1} GB; runtime ≈{:.1} GB exceeds your {:.1} GB VRAM. Pick a smaller quant or offload to CPU.",
                weights_gb, runtime_gb, v,
            ),
        })
    }
}

pub fn compat_for(
    inference_gb: f32,
    lora_train_gb: f32,
    qlora_gb: f32,
    vram_gb: Option<f32>,
) -> Option<CompatTag> {
    let v = vram_gb?;
    if lora_train_gb <= v * 0.95 {
        Some(CompatTag {
            color: "green".into(),
            text: "Fits".into(),
            tooltip: format!(
                "Runs inference (≈{:.1} GB) AND fine-tunes (≈{:.1} GB) within your {:.1} GB VRAM.",
                inference_gb, lora_train_gb, v
            ),
        })
    } else if inference_gb <= v * 0.95 {
        Some(CompatTag {
            color: "orange".into(),
            text: "Tight fit".into(),
            tooltip: format!(
                "Runs inference (≈{:.1} GB) but LoRA training needs ≈{:.1} GB > {:.1} GB. Try QLoRA (≈{:.1} GB).",
                inference_gb, lora_train_gb, v, qlora_gb
            ),
        })
    } else if qlora_gb <= v * 0.95 {
        Some(CompatTag {
            color: "orange".into(),
            text: "QLoRA only".into(),
            tooltip: format!(
                "Full inference needs ≈{:.1} GB > {:.1} GB. QLoRA-quantized inference fits (≈{:.1} GB).",
                inference_gb, v, qlora_gb
            ),
        })
    } else {
        Some(CompatTag {
            color: "red".into(),
            text: "Too large".into(),
            tooltip: format!(
                "Needs ≈{:.1} GB even quantized — exceeds your {:.1} GB VRAM. Use cloud or a smaller model.",
                qlora_gb, v
            ),
        })
    }
}

/// Detect the effective GPU memory budget in GB — the largest among the
/// user's selected GPUs (training/inference usually target one device).
/// Goes through hardware::gpu_memory_budget so unified-memory machines
/// (Apple Silicon, AMD APUs, Intel iGPUs) report their real shared-RAM
/// budget instead of a tiny dedicated pool — previously a 7B model
/// showed "Too large" on a 32 GB APU. Returns None when no GPU is found.
pub async fn detect_vram_gb() -> Option<f32> {
    crate::hardware::gpu_memory_budget()
        .await
        .map(|b| b.gb as f32)
}

/// Returns the curated list with hardware-aware compat tags filled in.
/// The React UI calls this on mount of the Models → Browse tab.
#[tauri::command]
pub async fn models_recommended() -> Result<Vec<RecommendedModel>, String> {
    let vram_gb = detect_vram_gb().await;
    let mut out: Vec<RecommendedModel> = curated()
        .into_iter()
        .map(|seed| {
            let inference_gb = seed.params_b * 2.0;
            let lora_train_gb = inference_gb * 2.0;
            let qlora_gb = inference_gb * 0.5;
            let compat = compat_for(inference_gb, lora_train_gb, qlora_gb, vram_gb);
            RecommendedModel {
                id: seed.id.to_string(),
                name: seed.name.to_string(),
                family: seed.family.to_string(),
                description: seed.description.to_string(),
                params_b: seed.params_b,
                inference_gb,
                lora_train_gb,
                qlora_gb,
                downloads: seed.downloads,
                likes: seed.likes,
                is_new: seed.is_new,
                gated: seed.gated,
                tags: tags_for(&seed),
                category: seed.category.to_string(),
                compat,
            }
        })
        .collect();
    // Sort by compat (green first), then by downloads desc — so users
    // see what's runnable on their box at the top.
    out.sort_by(|a, b| {
        let rank = |c: &Option<CompatTag>| match c.as_ref().map(|x| x.color.as_str()) {
            Some("green") => 0,
            Some("orange") => 1,
            Some("red") => 2,
            _ => 3,
        };
        rank(&a.compat)
            .cmp(&rank(&b.compat))
            .then(b.downloads.cmp(&a.downloads))
    });
    Ok(out)
}
