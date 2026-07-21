# owllm-marketplace

Dedicated web backend for the OWLLM marketplace.

## Scope

This service proves web identity and authorization using a **separate GitHub OAuth App** and **server-side sessions**. It does **not** read, store, or transmit the desktop `GITHUB_TOKEN` managed by `owllm-desktop/ui/src/pages/agentic/github.ts`.

## Key properties

- **Immutable ownership:** users are keyed by the immutable GitHub `id`. `github_login` is updated on renames.
- **Server-side sessions:** stored in SQLite with TTL; cookies are `HttpOnly` and signed.
- **CSRF protection:** OAuth state is generated per sign-in attempt and validated server-side in the callback.
- **Admin allowlist:** controlled by the `ADMIN_GITHUB_IDS` environment variable (immutable GitHub IDs).
- **Creator guard:** users must explicitly become creators (`POST /creators/become`) before accessing creator endpoints.

## Setup

```bash
cd owllm-marketplace
npm install
cp .env.example .env
# Edit .env with your GitHub OAuth App credentials and a real SESSION_SECRET.
```

## Run

```bash
npm run dev   # watch mode
npm start     # production-ish
```

## Test

```bash
npm run typecheck
npm test
```

## Auth flow

1. `GET /auth/github` redirects the browser to GitHub with a random `state` stored server-side.
2. GitHub redirects to `GET /auth/github/callback?code=...&state=...`.
3. The server validates `state`, exchanges the code, fetches the GitHub user, and creates or updates the local user by `github_id`.
4. A new server-side session is created and the user is redirected to `/auth/me`.
5. `POST /auth/signout` destroys the session and clears the cookie.

## Endpoints

| Method | Path | Guard | Description |
|--------|------|-------|-------------|
| GET | `/health` | - | Health check |
| GET | `/auth/github` | - | Start OAuth flow |
| GET | `/auth/github/callback` | - | OAuth callback |
| GET | `/auth/me` | auth | Current user |
| POST | `/auth/signout` | auth | Sign out |
| POST | `/creators/become` | auth | Become a creator |
| GET | `/creators/profile` | creator | Creator profile |
| GET | `/admin/users` | admin | List users |
