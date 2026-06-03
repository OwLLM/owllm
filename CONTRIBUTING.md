# Contributing to OwLLM

The OwLLM Desktop **application source is closed**, but the things that make OwLLM useful day-to-day — agent teams, role definitions, model profiles, MCP server recommendations, and documentation — live in this public repository and **welcome community contributions**.

## What you can contribute

| Type | Where | Effort |
|---|---|---|
| **New agent team** (e.g. `legal_drafter`, `music_composer`, `unity_modder`) | `data/teams/<name>.json` | 30 min – 2 hr |
| **New role definition** (e.g. `security_reviewer`, `latex_editor`) | `data/roles/<name>.yaml` | 15 min – 1 hr |
| **New model sampling profile** (e.g. for a freshly-released model) | `data/model-profiles/<model>.json` | 10 min |
| **MCP server recommendation** for an existing team | `data/mcp-recommendations/<team>.json` | 10 min |
| **Translations** for the UI | `data/i18n/<locale>.json` (when scaffolded) | varies |
| **Documentation** | any `.md` file | 10 min – ∞ |
| **Bug reports** | [Issues](https://github.com/OwLLM/owllm/issues) using the template | 5 min |
| **Feature requests** | [Discussions → Ideas](https://github.com/OwLLM/owllm/discussions/categories/ideas) | 5 min |

## Why contributions to the data layer matter

The OwLLM Desktop application pulls the contents of `data/` from this repository on every launch and hot-reloads them — **no app rebuild required**. A team template you contribute today is on every installed app tomorrow.

This is by design. The hard substrate (multi-agent dispatch, fleet, MCP runtime, native shell) is closed and shipped as binaries. The *content layer* — what the agents actually do — is open and community-owned.

## How to contribute an agent team

1. Fork this repository
2. Copy an existing team file as a starting point, e.g.:
   ```bash
   cp data/teams/code_artisan.json data/teams/my_new_team.json
   ```
3. Edit the JSON. The schema is documented in [data/teams/SCHEMA.md](data/teams/SCHEMA.md). The minimum is:
   - `id` — kebab-case, globally unique
   - `displayName`, `description`
   - `category` — what the team is FOR
   - `agents` — array of `{ role, name, systemPrompt }`
   - `graph` — edges between agents (orchestrator → specialist → critic)
   - `recommendedMcp` — optional list of MCP servers the team works best with
4. Test it locally: drop the file in `%APPDATA%/com.localllm.owllm-desktop/data-cache/teams/` and restart the app
5. Open a pull request. Describe what problem the team solves and a short example interaction.

## How to contribute a role

Roles are reusable building blocks for teams. A good new role:
- Has a clear, narrow specialty (e.g. `regex_writer`, not `general_helper`)
- Defines its tool requirements (MCP servers it needs)
- Includes a system prompt that's been tested in practice

See `data/roles/orchestrator.yaml` for the canonical structure.

## Standards

- **Quality bar:** any team you contribute should be one you've actually used to do work, not a thought experiment.
- **Naming:** lowercase, underscore-separated for IDs (`code_artisan`, not `CodeArtisan` or `code-artisan`).
- **Prompt length:** lean. If your system prompt is over 400 words, it's probably trying to do too much.
- **No competitive disparagement** in prompts. Don't tell an agent "you are better than [competitor product]."
- **Safety:** if a team's intended use is sensitive (red-teaming, security research, abliteration corpus prep), say so explicitly in the description so users self-select.

## Code of conduct

Be kind, be direct, be open to feedback. Full [Code of Conduct](CODE_OF_CONDUCT.md).

## Recognition

Contributors are listed in the auto-generated `CONTRIBUTORS.md` and appear in the in-app "About" page under the team / role they contributed.

## Need help?

Open a [Discussion](https://github.com/OwLLM/owllm/discussions) before you start a major contribution — saves rework and gets you feedback while the design is still cheap to change.
