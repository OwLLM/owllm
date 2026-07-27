# OwLLM — Agentic Architecture

How OwLLM Desktop turns a goal into work done by a team of local/cloud models
with real tools. Diagrams are [Mermaid](https://mermaid.js.org/) — they render
on GitHub and in the VS Code *Markdown Preview Mermaid* extension.

- **Rust** owns the runtime (model lifecycle, hardware, tools, bridges).
- **React** owns the UI and the agentic dispatch logic, talking to Rust via `invoke()`.
- **Tool-calling is native GGUF only** — the OpenAI `tools` array is rendered by
  the model's own chat template (`llama-server --jinja`) and read back as
  structured `delta.tool_calls`. No XML, no prompt-injected tool catalog.

---

## 1. System overview

```mermaid
flowchart TB
    user([👤 User]):::user

    subgraph UI["🖥️  React UI  (owllm-desktop/ui/src)"]
        chat["Chat page"]:::ui
        code["Code page<br/>(plan / act agent)"]:::ui
        agents["Agentic Team page<br/>(orchestrator + specialists)"]:::ui
        dispatch["dispatch.ts<br/><b>streamLocalChat · runDispatchLoop · providerFor</b>"]:::core
    end

    subgraph RUST["⚙️  Rust runtime  (src-tauri/src)"]
        server["server.rs<br/>llama-server lifecycle + GPU select"]:::rust
        tools["agent_tools.rs · git.rs<br/>file / shell / search"]:::rust
        mcp["mcp.rs<br/>MCP servers"]:::rust
        wsl["wsl.rs<br/>tool isolation (Ubuntu)"]:::rust
        acct["accounts.rs<br/>API keys + CLI subs"]:::rust
    end

    subgraph MODELS["🧠  Model backends"]
        local["llama-server --jinja<br/>(local GGUF)"]:::model
        cloud["Cloud APIs<br/>Claude · GPT · Gemini"]:::model
        subs["Subscription CLIs<br/>claude · codex · kimi · gemini"]:::model
    end

    user --> chat & code & agents
    chat & code & agents --> dispatch
    dispatch -->|"providerFor()"| local & cloud & subs
    dispatch -->|invoke| server & tools & mcp & acct
    server --> local
    acct --> subs
    tools -. "isolated run" .-> wsl

    classDef user fill:#1f6feb,stroke:#0b3d91,color:#fff
    classDef ui fill:#132a3a,stroke:#2b6cb0,color:#cfe8ff
    classDef core fill:#0e3a2f,stroke:#22c08a,color:#bdf5e2
    classDef rust fill:#3a2a16,stroke:#d9852a,color:#ffe3bd
    classDef model fill:#2c1f3a,stroke:#9a6bd6,color:#e7d6ff
```

---

## 2. The agentic dispatch loop

`runDispatchLoop()` runs three phases: the **orchestrator** plans and fans work
out to **specialists** (in parallel), then an **integrator** pass synthesizes
one answer. Every model call is the same `streamLocalChat` / `streamChatCompletion`.

```mermaid
flowchart LR
    goal([🎯 Goal]):::user --> orch

    subgraph P1["① planning"]
        orch["🦉 Orchestrator<br/>plans + emits<br/>@agent: instruction"]:::orch
    end

    subgraph P2["② dispatching  (parallel)"]
        s1["🔧 Specialist A"]:::spec
        s2["🔍 Specialist B"]:::spec
        s3["✍️ Specialist C"]:::spec
    end

    subgraph P3["③ integrating"]
        intg["🧩 Integrator<br/>merges results"]:::orch
    end

    orch --> s1 & s2 & s3
    s1 & s2 & s3 --> intg
    intg --> reply([✅ Final reply]):::done

    s1 -.->|tools| T[("🛠️ tools<br/>files · shell · web · MCP")]:::tool
    s2 -.->|tools| T
    s3 -.->|tools| T

    classDef user fill:#1f6feb,stroke:#0b3d91,color:#fff
    classDef orch fill:#3a3416,stroke:#d9b24a,color:#ffe9a8
    classDef spec fill:#132a3a,stroke:#2b6cb0,color:#cfe8ff
    classDef tool fill:#241a2e,stroke:#9a6bd6,color:#e7d6ff
    classDef done fill:#0e3a2f,stroke:#22c08a,color:#bdf5e2
```

---

## 3. Native GGUF tool-calling (one turn)

No XML. The OpenAI `tools` array goes to `llama-server --jinja`, which renders it
through the GGUF's own chat template; the reply comes back as structured
`delta.tool_calls`, the executor runs them, results are fed back, repeat until
the model stops calling tools.

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant D as dispatch.ts<br/>(streamLocalChat)
    participant S as llama-server --jinja
    participant M as GGUF model
    participant X as Tool executor<br/>(localTools / Rust)

    U->>D: prompt + tool specs
    D->>S: POST /v1/chat/completions<br/>{ messages, tools }
    S->>M: render via model's chat template
    M-->>S: delta.tool_calls [ {name,args} ]
    S-->>D: structured tool_calls
    loop until no more tool calls
        D->>X: run tool (read_file / edit_file / shell / web_fetch / MCP…)
        X-->>D: result
        D->>S: append result, continue
        S->>M: next step
        M-->>S: text  ‖  more tool_calls
        S-->>D: delta
    end
    D-->>U: streamed answer
```

---

## 4. Messaging bridges — drive the team from anywhere

Seven bridges fan into **one** shared `useBridgeDispatch()` core, so they all
share the same commands, project routing, attachments and desktop mirror.
**Outbound** bridges work on any machine; **inbound webhook** bridges need a
public URL (a tunnel).

```mermaid
flowchart TB
    subgraph OUT["📤 Outbound (no public URL)"]
        tg["✈️ Telegram<br/>long-poll"]:::out
        dc["🎮 Discord<br/>gateway WS"]:::out
        sl["#️⃣ Slack<br/>Socket Mode"]:::out
        em["✉️ Email<br/>IMAP + SMTP"]:::out
    end

    subgraph IN["📥 Inbound webhook (needs tunnel)"]
        wa["💬 WhatsApp"]:::win
        ln["🟢 LINE"]:::win
        kk["💛 KakaoTalk"]:::win
    end

    wh["webhook.rs<br/>one tiny_http listener<br/>/whatsapp · /line · /kakao"]:::rust
    wa & ln & kk --> wh

    core["🔁 useBridgeDispatch()<br/><i>bridgeCore.ts</i>"]:::core
    tg & dc & sl & em --> core
    wh --> core

    core --> loop["runDispatchLoop()<br/>orchestrator → specialists → integrate"]:::orch
    loop --> reply([reply back to the same chat]):::done

    classDef out fill:#132a3a,stroke:#2b6cb0,color:#cfe8ff
    classDef win fill:#2c1f3a,stroke:#9a6bd6,color:#e7d6ff
    classDef rust fill:#3a2a16,stroke:#d9852a,color:#ffe3bd
    classDef core fill:#0e3a2f,stroke:#22c08a,color:#bdf5e2
    classDef orch fill:#3a3416,stroke:#d9b24a,color:#ffe9a8
    classDef done fill:#0e3a2f,stroke:#22c08a,color:#bdf5e2
```

---

## 5. Code page — plan / act coding agent

The Code page runs a single model directly against a project folder. **Plan**
breaks a goal into ordered steps shown on a Kanban board; **Send** does a
one-shot. Tools run in the workspace — inside **WSL (Ubuntu)** when isolation is
on, otherwise on Windows behind a write-jail + dangerous-command guard.

```mermaid
flowchart TB
    g([🎯 Goal in a project folder]):::user

    g -->|"📋 Plan"| plan["Plan: ordered steps"]:::orch
    g -->|"Send"| oneshot["One-shot turn"]:::spec

    subgraph K["Kanban board"]
        todo["📋 To do"]:::col
        doing["⚙️ Doing"]:::col
        done["✓ Done"]:::col
    end
    plan --> todo --> doing --> done

    doing -->|runTurn| model["selected model<br/>(local or cloud)"]:::model
    oneshot -->|runTurn| model
    model -->|tool calls| ws[("🗂️ Workspace<br/>read · edit · create · shell")]:::tool

    ws -. "isolation ON" .-> wsl["🛡️ WSL / Ubuntu<br/>off the Windows drive"]:::rust
    ws -. "isolation OFF" .-> win["⚠️ Windows<br/>write-jail + guard"]:::rust

    classDef user fill:#1f6feb,stroke:#0b3d91,color:#fff
    classDef orch fill:#3a3416,stroke:#d9b24a,color:#ffe9a8
    classDef spec fill:#132a3a,stroke:#2b6cb0,color:#cfe8ff
    classDef col fill:#102233,stroke:#2b6cb0,color:#cfe8ff
    classDef model fill:#2c1f3a,stroke:#9a6bd6,color:#e7d6ff
    classDef tool fill:#241a2e,stroke:#9a6bd6,color:#e7d6ff
    classDef rust fill:#3a2a16,stroke:#d9852a,color:#ffe3bd
```

---

## 6. Provider routing — one dispatch, three backends

`providerFor(modelId)` decides how each turn runs. The UI (model picker) is the
same everywhere; only execution differs.

```mermaid
flowchart LR
    pick["🎚️ ModelPicker<br/>(shared, full list)"]:::ui --> pf{"providerFor()"}:::core

    pf -->|local / tuned| L["ensure llama-server<br/>→ streamLocalChat"]:::model
    pf -->|anthropic / openai / google| C["streamChatCompletion<br/>(cloud API + key)"]:::model
    pf -->|subscription| S["CLI: claude / codex /<br/>kimi / gemini --print"]:::model

    L & C & S --> out([streamed reply + tool calls]):::done

    classDef ui fill:#132a3a,stroke:#2b6cb0,color:#cfe8ff
    classDef core fill:#0e3a2f,stroke:#22c08a,color:#bdf5e2
    classDef model fill:#2c1f3a,stroke:#9a6bd6,color:#e7d6ff
    classDef done fill:#0e3a2f,stroke:#22c08a,color:#bdf5e2
```

---

### Source map

| Concern | File |
|---|---|
| Shared dispatch (local + cloud + loop) | `ui/src/pages/agentic/dispatch.ts` |
| Tool specs + MCP tools | `ui/src/pages/agentic/localTools.ts` |
| Bridge core (one dispatch for all) | `ui/src/bridges/bridgeCore.ts` |
| Per-bridge runners | `ui/src/bridges/*BridgeRunner.tsx` |
| Inbound webhook server | `src-tauri/src/webhook.rs` |
| llama-server lifecycle + GPU | `src-tauri/src/server.rs` |
| Tools (Rust) | `src-tauri/src/agent_tools.rs`, `git.rs` |
| WSL isolation | `src-tauri/src/wsl.rs` |
