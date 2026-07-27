# P0-4 · Auto model routing — notes

Completed 2026-06-13. Probe: 18 node assertions against the real
dispatch.ts (esbuild bundle) — trivial vs hard prompts resolve to
DIFFERENT models, every flavour honored, cloud picks always flagged.

## Shape

- Pure `pickAutoModel(flavour, tier, candidates)` decides;
  `resolveAutoModel(flavour, prompt)` gathers availability via the SAME
  discovery as the picker (buildEntries + accounts_status +
  server_status). `estimatePromptTier` is deliberately coarse: word
  count + hard-signal keywords + code-ish markers.
- Flavours: cheapest (running local wins, else cheapest cloud);
  cheapest-local (NEVER cloud — throws an actionable error when no local
  server runs); premium (best cloud, local fallback); balanced (tier:
  simple→local/cheapest, standard→local else mid-tier sonnet-class,
  hard→premium).
- Both streamChatCompletion copies (dispatch.ts AND AgentsPage §0.4)
  resolve `provider === "auto"` and recurse with the concrete id.
  GUARDRAIL: the resolution ALWAYS surfaces via onSystemWarning —
  "⚡ Auto → <label> (cloud — uses your account/credits) · <reason>" —
  a paid pick is never silent.
- Subscriptions outrank API keys on ties ("cheapest" is from the user's
  wallet's view — the sub is already paid).

## Bugs the probe caught before shipping

- "design" in hardSignals escalated ordinary prose ("the design team")
  to the hard tier — replaced with "redesign|architect".
- premiumScore tested /gpt-5/ before /mini/, so gpt-5-mini ranked 80 and
  won the mid-tier pick. Small-model markers must be tested FIRST.

## Remaining risks

- Tier estimation sees only the prompt, not the conversation; a short
  follow-up to a hard task reads as simple. Acceptable: each turn's cost
  is surfaced, and the user can pin a model any time.
- Local resolution uses the model CURRENTLY LOADED in the server; auto
  never starts a server (no surprise multi-GB VRAM loads).
- End-to-end UI probe (pick "Auto" on Code/Agents pages and watch the
  warning line) still pending a packaged-build pass — the policy layer
  is what's probed; the branch wiring is compile-verified in both copies.
