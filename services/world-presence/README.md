# OWLLM World Presence

Cloudflare Worker backing Gamify → World Map → Live World.

The service accepts anonymous heartbeats, derives a coarse region from
Cloudflare request metadata, and returns short-lived map nodes. It never reads
or stores account details, device names, projects, prompts, files, or source IP
headers. Exact edge coordinates are rounded and deterministically jittered
before storage.

## API

- `GET /v1/presence` — list active anonymous nodes.
- `POST /v1/presence` — create/refresh a node. The first response issues an
  opaque token; later heartbeats send it as `Authorization: Bearer …`.
- `DELETE /v1/presence` — immediately remove the caller's node.
- `GET /health` — service health.

Nodes expire after 15 minutes without a heartbeat. Tokens are SHA-256 hashed
before D1 storage and never appear in public snapshots.

## Develop and deploy

```powershell
npm.cmd install
npm.cmd test
npx.cmd wrangler dev
npx.cmd wrangler login
npm.cmd run deploy
```

Wrangler automatically provisions the D1 binding on first authenticated
deployment and writes its generated ID back to `wrangler.jsonc`. Put the
resulting `https://…workers.dev` URL in
`VITE_OWLLM_WORLD_PRESENCE_URL` for the desktop release build.
