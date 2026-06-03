# Module manifest schema (v1)

OwLLM ships a minimal shell. Optional capabilities (local inference, fine-tuning, audio backends, bridges) are downloaded as **modules** at first-run or on demand, and updated independently of the shell.

## Two manifests

| File | Where | Source of truth for | Updated by |
|---|---|---|---|
| **`registry.json`** | `data/modules/registry.json` in this repo, served via `raw.githubusercontent.com/OwLLM/owllm/main/data/modules/registry.json` | Every module + variant + channel + URL that exists | A maintainer commits a new entry |
| **`installed.json`** | `%APPDATA%/com.localllm.owllm-desktop/modules/installed.json` on the user's machine | What the user has on disk right now | The app, when it installs / updates / removes a module |

The app fetches `registry.json` on launch, diffs it against `installed.json`, and surfaces available updates / new modules.

## Concepts

- **Module** — a logical capability (`local-inference`, `finetune`, `audio-whisper`). Identified by stable `id`. Declares which UI areas it enables via `uiSlots`.
- **Variant** — a hardware-/platform-specific implementation of a module. `local-inference` has variants `cuda`, `vulkan`, `cpu`. The resolver picks the best one the user's hardware supports; user can override.
- **Channel** — release track (`stable` | `beta` | `nightly`) per variant. Each channel pins one version with its download URL + hash.
- **Requirement predicate** — declarative hardware/platform check (`gpu`, `vramGb`, `ramGb`, `diskGb`, `platform`). Resolver filters out variants the user's machine doesn't satisfy.
- **Module dependency** — a module can declare `dependsOn: ["python-runtime", ...]`. When the wizard installs that module it auto-installs the deps first. Cycles are forbidden; the resolver flattens deps via topological sort.

## Beyond modules — three sibling concerns the registry tracks

Modules are downloadable ZIPs. The registry also documents three things that *aren't* modules, so the wizard knows what NOT to offer for download:

1. **`shellEmbedded`** — features compiled into the Tauri exe. Always available; never offered as installable. Includes: cloud connectors (Anthropic/OpenAI/Moonshot), Telegram bridge, audio codecs (Symphonia), agent runtime, MCP spawner, fleet substrate, PTY terminal, hardware probe, HuggingFace browser, all UI pages.
2. **`dataLayer`** — JSON/YAML files (team templates, role prompts, skill packs, model sampling profiles, MCP server recommendations) pulled from `raw.githubusercontent.com/OwLLM/owllm/main/data/...` with local cache fallback, hot-reloadable without restart. Updated by committing to `main`, no release cycle.
3. **`systemPrerequisites`** — external programs that must be on PATH (Git for fleet worktrees; optionally VSCodium/Cursor/VS Code for the Code page). Wizard probes via `checkCommand`; surfaces `installHint` URL if missing. We do not bundle these — too big, too OS-managed.

There's also a `futureModules` section listing capabilities the roadmap mentions (TTS, vision inference, image/music/video generation, WhatsApp bridge, Kanban cards UI, director-mode approval gates) so the registry shape stays forward-compatible. Move an entry into `modules[]` when shipped.

## `registry.json` shape

```jsonc
{
  "schemaVersion": 1,
  "registryVersion": "2026.06.03",       // bumped per publish; for UI "your registry is stale" hints
  "publishedAt": "2026-06-03T00:00:00Z",
  "channels": ["stable", "beta", "nightly"],
  "modules": [
    {
      "id": "local-inference",            // stable identifier
      "displayName": "Local Inference",
      "description": "...",
      "category": "runtime",              // runtime | training | audio | bridge | content
      "required": false,                  // true = shell refuses to start without it (none today)
      "uiSlots": [                        // UI sections this module unlocks
        "server-page", "model-browser", "chat-local-models"
      ],
      "variants": [
        {
          "id": "local-inference-cuda",
          "displayName": "NVIDIA CUDA build",
          "platform": "windows-x86_64",   // windows-x86_64 | linux-x86_64 | macos-aarch64 | …
          "requires": {                   // any field omitted = no constraint
            "gpu": "nvidia",              // nvidia | amd | intel | apple | null
            "vramGb": 4,                  // minimum VRAM
            "ramGb": null,                // minimum system RAM
            "diskGb": 1                   // free disk required to install
          },
          "sizeBytes": 285212672,
          "channels": {
            "stable": {
              "version": "b3850-cuda12.4",
              "releasedAt": "2026-05-28T00:00:00Z",
              "downloadUrl": "https://github.com/OwLLM/owllm/releases/download/.../foo.zip",
              "sha256": "...",            // MANDATORY — verified before activation
              "minShellVersion": "0.1.0", // refuses to install if shell older than this
              "signature": null           // optional Ed25519 sig (added when signing infra ships)
            }
          }
        }
      ]
    }
  ]
}
```

## `installed.json` shape

```jsonc
{
  "schemaVersion": 1,
  "updateChannel": "stable",              // user pref; applies to all modules unless overridden
  "modules": {
    "local-inference": {
      "variant": "local-inference-cuda",  // which variant the user chose / resolver picked
      "version": "b3850-cuda12.4",
      "channel": "stable",                // optional per-module channel override
      "installedAt": "2026-06-03T14:30:00Z",
      "path": "modules/local-inference-cuda-b3850",  // relative to APPDATA module root
      "sha256": "...",                    // recorded at install for tamper detection
      "previousVersion": null             // kept across one launch for rollback
    }
  }
}
```

## Variant resolution

When the user (or first-run wizard) picks a module, the resolver:

1. Filter `module.variants` to those matching `requires.platform` and the detected hardware
2. Score remaining variants by performance hint (`cuda > vulkan > cpu` for inference, etc.)
3. Pick the highest-scoring one whose `requires.{vramGb, ramGb, diskGb}` the machine satisfies
4. Honour explicit user override stored in `installed.json` even if a "better" variant is available

If no variant qualifies → surface "Your hardware doesn't support this module" with the failing predicate.

## Update flow

On app launch:
1. Fetch `registry.json` (10s timeout, cache fallback)
2. For each entry in `installed.json`, look up its module → variant → channel in the registry
3. If `registry.version > installed.version` and `shell >= minShellVersion` → mark "update available"
4. Background-download the new ZIP, verify `sha256`, stage at `modules/<variant-id>-<new-version>/`
5. On next launch (or user-confirmed restart), atomically swap the symlink/junction `modules/<variant-id>` → new version, move old version to `modules/.previous/` (kept for one cycle for rollback)
6. If activation crashes the shell → next launch detects the marker, reverts to `.previous`, surfaces an error

## Data-layer files (sibling concern)

Items that are just JSON/YAML (team templates, role prompts, model profiles, MCP server lists, sampling configs, tool protocols) do **not** go through this module system. They're pulled from `raw.githubusercontent.com/OwLLM/owllm/main/data/{teams,roles,model-profiles,…}/` with local cache fallback and hot-reloaded without restart. See [`../README.md`](../README.md) (TODO) for the data-layer spec.

## Schema evolution

- `schemaVersion: 1` — current
- Bump when a breaking change is introduced (renamed field, semantic change)
- App refuses to parse `schemaVersion > app.maxSupportedSchema`, prompts "please update OwLLM"
