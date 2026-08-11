// What each file in a GGUF repo actually IS.
//
// WHY: the weight picker listed every `.gguf` in the repo as if they were
// interchangeable quantizations of the same model, so
// meta-models/Muse-Glimmer-30B-GGUF showed four equal-looking rows:
//
//   muse-glimmer-30B-kquant-dynamic.gguf   18.3 GB   ← main weights
//   muse-glimmer-30B-kquant-17gb.gguf      15.6 GB   ← main weights (smaller)
//   dflash-kquant.gguf                      1.5 GB   ← draft model, optional
//   mmproj-kquant.gguf                      1.3 GB   ← vision projector
//
// Tick only a companion and you download something that cannot run on its own;
// tick a main file and the projector is fetched for you (huggingface.rs
// `spawn_mmproj_fetch`) — neither fact was anywhere on screen. This module is
// the single place that names the roles, so the picker can explain them and
// refuse a selection that has no runnable weights in it.

export type WeightRole = "primary" | "projector" | "draft" | "adapter";

export type RoleInfo = {
  role: WeightRole;
  /** Short badge text, e.g. "vision". */
  label: string;
  /** One sentence the user can act on. */
  hint: string;
};

const ROLE_INFO: Record<WeightRole, Omit<RoleInfo, "role">> = {
  primary: {
    label: "weights",
    hint: "The model itself. Pick exactly one of these — they are alternative sizes of the same model, not parts of it.",
  },
  projector: {
    label: "vision",
    hint: "Vision projector — lets the model read images. It is downloaded automatically with the weights; it cannot run on its own.",
  },
  draft: {
    label: "draft",
    hint: "Optional small draft model for speculative decoding (faster replies). Not required, and it cannot run on its own.",
  },
  adapter: {
    label: "adapter",
    hint: "LoRA adapter — applied on top of a base model. It cannot run on its own.",
  },
};

/**
 * Classify one repo file by its name. Naming follows the conventions llama.cpp
 * and the GGUF publishers use, which is also what our own Rust scanner keys off
 * (`models.rs` skips `mmproj*` / `*-lora-*` as standalone models, and
 * `server.rs` looks for a sibling `mmproj*` to pass as `--mmproj`).
 */
export function weightRole(path: string): WeightRole {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  if (name.startsWith("mmproj") || name.includes("mmproj")) return "projector";
  if (name.includes("-lora-") || name.startsWith("lora") || name.includes("adapter")) return "adapter";
  // Speculative-decoding draft weights. `dflash` is the naming this repo family
  // uses; `draft` is the generic one.
  if (name.startsWith("dflash") || name.includes("-dflash") || name.includes("draft")) return "draft";
  return "primary";
}

export function roleInfo(role: WeightRole): RoleInfo {
  return { role, ...ROLE_INFO[role] };
}

/**
 * Why a selection can't be downloaded yet, or null when it's fine. Companion
 * files with no weights alongside them are the trap this guards: the download
 * "succeeds", the model then refuses to load, and nothing ever said why.
 */
export function selectionProblem(selected: string[]): string | null {
  if (selected.length === 0) {
    return "Pick the model weights you want, or tick “Download all”.";
  }
  const roles = selected.map(weightRole);
  if (!roles.includes("primary")) {
    const named = [...new Set(roles.map((r) => ROLE_INFO[r].label))].join(" + ");
    return `You have only selected the ${named} file${selected.length > 1 ? "s" : ""}. ` +
      "That is a companion to a model, not a model — on its own it cannot be loaded. " +
      "Also tick one of the main weight files.";
  }
  return null;
}

/**
 * What we will fetch beyond the user's ticks, phrased for the confirm button's
 * subtitle. Returns null when there is nothing extra to mention.
 */
export function autoIncludedNote(all: string[], selected: string[]): string | null {
  const picked = new Set(selected);
  const hasPrimary = selected.some((f) => weightRole(f) === "primary");
  if (!hasPrimary) return null;
  const projector = all.find((f) => weightRole(f) === "projector" && !picked.has(f));
  if (!projector) return null;
  return `The vision projector (${projector.split("/").pop()}) is fetched automatically alongside the weights.`;
}
