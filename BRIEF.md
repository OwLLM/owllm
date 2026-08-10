# Public Project Marketplace

## Goal
Add a public OwLLM marketplace where anyone can browse free projects made with OwLLM, open a project's public GitHub repository, and optionally visit a hosted demo. Creators sign in with GitHub to submit and manage listings; every new listing and every material edit requires admin approval before it is public. The desktop app only opens the marketplace in OwLLM's existing persistent browser in v1.

## Current Behavior
OwLLM Desktop is a Tauri/React application whose global chrome and navigation live in `owllm-desktop/ui/src/AppShell.tsx`. User-facing HTTP(S) links already go through `openWebUrl()` in `owllm-desktop/ui/src/utils/openWebUrl.ts`, which invokes the Rust `browser_open_url` command registered in `owllm-desktop/src-tauri/src/lib.rs` and implemented by the persistent, shared-profile browser in `owllm-desktop/src-tauri/src/browser.rs`.

GitHub identity is already connected inside the desktop through `githubStatus()` and the device-flow helpers in `owllm-desktop/ui/src/pages/agentic/github.ts`. Coding projects already carry a normalized GitHub `repo_url` through `ensureCatalogProject()` in `owllm-desktop/ui/src/pages/agentic/CodePage.tsx`, and `.owllm/project.json` is parsed as `ProjectCard` in `owllm-desktop/ui/src/pages/agentic/cardLint.ts`. `PublishCards` currently publishes software releases to GitHub; it does not create or moderate public marketplace listings. The only public web package in this repository is the unrelated Netlify-based `download-map/`, so the marketplace website, catalog datastore, web authentication, creator dashboard, and moderation queue do not yet exist.

## Affected Code
| Area | File(s) | What changes |
|------|---------|--------------|
| Desktop entry point | `owllm-desktop/ui/src/AppShell.tsx` | Add a global Marketplace control that opens the public catalog without becoming an installable app mode or changing the active page. |
| Browser integration | `owllm-desktop/ui/src/utils/openWebUrl.ts`, `owllm-desktop/src-tauri/src/browser.rs`, `owllm-desktop/src-tauri/src/lib.rs` | Reuse the existing `openWebUrl()` → `browser_open_url` path and persistent browser profile; no new native browser command is expected. |
| GitHub/project seams | `owllm-desktop/ui/src/pages/agentic/github.ts`, `owllm-desktop/ui/src/pages/agentic/CodePage.tsx`, `owllm-desktop/ui/src/pages/agentic/cardLint.ts`, `owllm-desktop/ui/src/pages/agentic/PublishCards.tsx` | Reuse the existing concepts of GitHub identity, public repo URL, and Project Card metadata while keeping marketplace submission separate from release publishing; avoid exposing the desktop's stored GitHub token to the website. |
| Localization and desktop verification | `owllm-desktop/ui/src/localization/catalog.generated.ts`, `owllm-desktop/ui/src/localization/localization.verify.run.mjs`, `owllm-desktop/ui/src/utils/openWebUrl.verify.run.mjs` | Cover the new Marketplace label/tooltip and verify all web links still use the persistent-browser helper. |
| Public marketplace | New isolated `marketplace/` web package; deployment precedent in `download-map/netlify.toml` and `download-map/netlify/functions/stats.mts` | Add the public catalog, project detail pages, GitHub OAuth, creator dashboard, admin review queue, API, tests, and deployment configuration without coupling it to the private download dashboard. |

## Plan
1. Establish the marketplace package and data contract — create an isolated `marketplace/` web package and document its environment contract, using the existing `download-map/netlify.toml` only as a deployment pattern; define profiles, listings, categories, and moderation events in a managed relational datastore, with listing states `draft`, `pending`, `approved`, `rejected`, and `unpublished` — verify a clean local setup can apply the schema and load fixed seed listings without touching `download-map`.
2. Prove web identity and authorization first — implement a dedicated marketplace GitHub OAuth flow with secure server-side sessions, creator ownership keyed to the immutable GitHub user ID, and an environment-configured admin allowlist; do not transfer or read the token stored by `github.ts` in the desktop — verify sign-in/sign-out, expired-session handling, CSRF/state rejection, creator/admin route guards, and account renames with automated auth tests.
3. Implement the submission boundary — add authenticated create/update APIs for title, short and full description, category, SPDX license, public GitHub repository URL, optional HTTPS demo URL, and a bounded set of HTTPS screenshot URLs; validate URL schemes, confirm the repository is public and controlled by the signed-in creator, reject duplicates, and record moderation history — verify invalid/private/unowned repositories and unsafe URLs fail while a valid listing enters `pending` and remains absent from public queries.
4. Implement approval-safe lifecycle rules — add the admin review queue with approve/reject plus a reason, make material edits to an approved listing return it to `pending`, and let its creator unpublish immediately; preserve an audit trail instead of hard-deleting records — verify a creator cannot approve a listing, cannot edit another creator's listing, cannot bypass review through edits, and can remove their own listing from public results.
5. Build the anonymous marketplace experience — add responsive browse/search/category filtering, project cards, and shareable project detail pages showing screenshots, creator, license, description, repository, and optional demo; label both outbound actions clearly and never execute or install repository content — verify approved listings are indexable and usable without an account, while pending/rejected/unpublished listings return no public content.
6. Build creator self-service — add “Submit project” and “My projects” pages where a signed-in creator can create a draft, submit it, see approval status/rejection reason, edit and resubmit, or unpublish; make the review consequence of editing approved content explicit before save — verify the full creator journey from first sign-in through approval, edit/re-review, and unpublish on desktop and mobile widths.
7. Connect OwLLM Desktop to the website — add a clearly labelled global Marketplace button in `owllm-desktop/ui/src/AppShell.tsx` and route it through `openWebUrl()` from `owllm-desktop/ui/src/utils/openWebUrl.ts`; keep `core/modules.ts`, `PublishCards`, and the active app page unchanged — verify clicking it opens/focuses the marketplace in the OwLLM browser, preserves marketplace login across visits, and does not navigate or reset the current OwLLM workspace.
8. Finish verification and release controls — add marketplace unit/API/end-to-end coverage for anonymous browse, OAuth, ownership, moderation, and creator management; update `catalog.generated.ts` for the desktop copy and run `localization.verify.run.mjs`, `openWebUrl.verify.run.mjs`, the marketplace test suite, and the existing desktop build — verify a staging deployment passes the complete submit → approve → browse → GitHub/demo-link smoke test before the production URL is baked into the desktop.

## Scope
In:
- Public web catalog for projects such as websites, apps, and presentation makers.
- Anonymous browsing, search, category filters, project detail pages, GitHub source links, and optional hosted-demo links.
- GitHub sign-in for creators and admins, with a marketplace-specific web session.
- Required title, description, category, screenshots, SPDX license, and public repository metadata.
- Free listings only, admin approval, rejection reasons, edit/resubmit, and creator unpublish.
- One desktop control that opens the marketplace in OwLLM's existing browser.

Out (explicitly not now):
- Credits, payments, refunds, subscriptions, creator payouts, or paid listings.
- Automatic clone, download, installation, updates, dependency execution, or security certification inside OwLLM.
- Teams/skills marketplaces or bundling projects with agent/team definitions.
- Click/download analytics, ratings, reviews, comments, favorites, recommendations, or social feeds.
- Repository mirroring, hosted demos, and marketplace-hosted screenshot uploads; v1 stores validated external HTTPS screenshot URLs.
- External JSON settings, including making the marketplace URL user-editable.
- Automatic marketplace submission as part of `PublishCards`; GitHub release publishing remains independent.

## Risks & Open Questions
- A public repository or demo can become malicious after approval. V1 must present links as external, never run code, retain moderation history, and allow admins to unpublish quickly; approval is curation, not a security guarantee.
- GitHub OAuth for the website needs separate callback configuration and server secrets. Reusing the desktop's token would create an unnecessary credential boundary violation and is explicitly prohibited.
- External screenshot URLs can break or track visitors. V1 should restrict them to HTTPS, proxy/referrer-harden rendering where practical, and leave first-party uploads for a later storage decision.
- The proposed public-site stack introduces managed database/auth infrastructure beyond the repository's current Netlify download dashboard; schema migrations, backups, rate limits, abuse controls, and operating ownership must be set before production.
- What exact production domain should the GitHub OAuth callback and desktop Marketplace button use?
- Which GitHub usernames are the initial marketplace admins?
