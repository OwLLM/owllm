# Agent team schema

This document describes the JSON shape of files under `data/teams/`. The OwLLM Desktop application fetches these on launch and hot-reloads them — a team you contribute today lands on every installed app within minutes.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the contribution flow.

## Minimum example

```json
{
  "id": "regex_writer",
  "displayName": "Regex Writer",
  "description": "Two-agent team that writes a regex and verifies it against test cases before returning.",
  "category": "code",
  "agents": [
    {
      "role": "orchestrator",
      "name": "lead",
      "systemPrompt": "Receive the user's intent. Dispatch to writer with concrete test cases. Pass the writer's regex to verifier. If verifier rejects, dispatch back to writer with the failure. Reply with the final regex once verified."
    },
    {
      "role": "coder",
      "name": "writer",
      "systemPrompt": "Write the smallest correct regex for the requested pattern. Prefer readability over cleverness. Return ONLY the pattern, no prose."
    },
    {
      "role": "critic",
      "name": "verifier",
      "systemPrompt": "Run the candidate regex against the test cases. If all pass, reply 'APPROVE'. If any fail, reply 'REVISE' followed by the failing case and the actual match."
    }
  ],
  "graph": [
    { "from": "lead", "to": "writer" },
    { "from": "writer", "to": "verifier" },
    { "from": "verifier", "to": "lead" }
  ],
  "recommendedMcp": []
}
```

## Field reference

| Field | Type | Required | Notes |
|---|---|:---:|---|
| `id` | string (kebab-case) | ✓ | Globally unique. Matches the filename without `.json`. |
| `displayName` | string | ✓ | Shown in the team picker. Title Case. ≤ 32 chars. |
| `description` | string | ✓ | One sentence. What the team is FOR. Shown in the picker. ≤ 200 chars. |
| `category` | enum | ✓ | One of: `code`, `research`, `data`, `design`, `writing`, `ops`, `personal`, `social`, `safety` |
| `agents` | array | ✓ | At least 2 agents (orchestrator + 1 specialist). |
| `agents[].role` | enum | ✓ | One of the role IDs under `data/roles/`. Defines the agent's archetype + tool capabilities. |
| `agents[].name` | string | ✓ | Short identifier used in `graph`. Lowercase, no spaces. |
| `agents[].systemPrompt` | string | ✓ | The agent's instructions. Lean — under 400 words is a good ceiling. |
| `agents[].model` | string | optional | Pin a model family, e.g. `qwen2.5-coder` or `claude-4-sonnet`. Leave empty to use user's default. |
| `graph` | array | ✓ | Edges between agent names. Defines dispatch routing. Cycles allowed (revise loops). |
| `graph[].from` | string | ✓ | Source agent `name`. |
| `graph[].to` | string | ✓ | Target agent `name`. |
| `graph[].on` | string | optional | Trigger condition: `success`, `revise`, `reject`. Default `success`. |
| `recommendedMcp` | array | optional | MCP server IDs that this team works best with. The wizard suggests installing them. |

## Categories (for the picker grouping)

- **`code`** — software work (write, review, refactor, test, debug)
- **`research`** — read, synthesise, cite, fact-check
- **`data`** — SQL, notebooks, dashboards, ETL
- **`design`** — product, UX, visual, brand
- **`writing`** — articles, marketing, docs, scripts
- **`ops`** — devops, infra, monitoring, releases
- **`personal`** — secretary, calendar, brief, health, finance
- **`social`** — outreach, customer support, community management
- **`safety`** — red-teaming, adversarial dataset generation, abliteration corpora

## Quality bar

Before submitting a PR with a new team:

- [ ] You've actually used it to do real work, not just a thought experiment
- [ ] System prompts are lean (< 400 words each)
- [ ] Graph has no orphan agents (every agent reachable from the orchestrator)
- [ ] No agent system prompt disparages competitors or other tools
- [ ] If safety-sensitive, the description says so explicitly
- [ ] Tested locally by dropping the file in `%APPDATA%/com.localllm.owllm-desktop/data-cache/teams/`

## Validation

A GitHub Actions workflow runs schema validation + lint checks on every PR. Common failures:

- **`id` does not match filename** — `code_artisan.json` MUST have `"id": "code_artisan"`
- **Orphan agent in `graph`** — agent name referenced in graph but not in `agents`
- **Schema-incompatible field** — see this file for the canonical shape

If your PR fails validation, the workflow comment will tell you what's wrong.
