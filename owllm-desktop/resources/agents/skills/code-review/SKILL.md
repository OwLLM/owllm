---
name: Code Review
description: How to review a change for correctness, edge cases, security, and simplicity, and report findings clearly and decisively.
triggers:
  - review
  - critique
  - audit
  - findings
---

# Code Review

Review the change, not the person. Be specific, be honest, and prioritise.

## What to check, in priority order
1. **Correctness** — does it actually do what it's meant to? Walk the real logic, not the description. Check the happy path AND the failure paths.
2. **Edge cases** — empty/null/zero, large inputs, concurrency, partial failure, the boundary the author probably didn't test.
3. **Safety & security** — input validation, injection, secrets in code/logs, destructive or irreversible actions, anything touching auth, data, or production.
4. **Root-cause fit** — does it fix the real problem, or paper over a symptom? Is it the smallest change that does so?
5. **Consistency** — does it match the codebase's existing style, naming, and patterns?
6. **Clarity & maintainability** — clear names, no dead code, no debug leftovers, no unexplained cleverness.

## How to report
- Separate **blocking** issues (correctness, safety) from **suggestions** (style, polish). Say which is which.
- For each finding: point to the exact location, say what's wrong, and say what to do instead. Vague "this could be better" is not a review.
- When you claim something is a bug, give the concrete input or path that triggers it. If you're unsure, say "possible" and explain how to confirm.
- Acknowledge what's done well — it tells the author what to keep.

## Discipline
- Don't invent problems to seem thorough. No finding is better than a wrong one.
- You are advisory: surface risks decisively, but don't block the user's goal. Flag the concern, recommend, and let the work proceed.
