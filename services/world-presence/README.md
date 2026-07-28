# OWLLM World Presence

Cloudflare Worker backing Gamify → World Map → Live World.

The service uses one hibernating WebSocket Durable Object. Every OWLLM
installation holds one `presence` socket; an open World Map holds one `viewer`
socket. The socket itself is the online signal. Each stable anonymous
installation is retained in Durable Object SQLite so the map can show recorded
and online totals by country, including city and a coarse OS-family breakdown.

Cloudflare request metadata is reduced to a city and coarse, jittered map point before the
socket reaches the Durable Object. The service never reads or stores account
details, device names, projects, prompts, files, source IP headers, or precise
coordinates. Closing the socket marks the retained anonymous node offline.

## WebSocket API

- `GET /v1/presence/connect?role=presence&id=<opaque-id>&os=<family>` with
  `Upgrade: websocket` — record one anonymous installation and mark it online
  until the socket closes.
- `GET /v1/presence/connect?role=viewer` with `Upgrade: websocket` — receive an
  initial `{ type: "snapshot", nodes, updatedAt }` message, then small
  `{ type: "upsert", node }` / `{ type: "remove", id }` membership changes.
- A viewer may send the text message `snapshot` to request a fresh snapshot.
- `GET /health` — service health and transport information.

The first deployment uses one global object. The implementation caps it at
5,000 presence sockets and 1,000 viewer sockets so it fails closed before the
platform's theoretical per-object limit. Shard by continent before raising
those caps or when overload metrics justify it.

## Develop and deploy

```powershell
npm.cmd install
npm.cmd test
npm.cmd run check
npx.cmd wrangler dev
npx.cmd wrangler login
npm.cmd run deploy
```

The production service is deployed at
`https://owllm-world-presence.mc-9fa.workers.dev`. The desktop uses this URL by
default; `VITE_OWLLM_WORLD_PRESENCE_URL` can override it for staging or
self-hosted deployments. A future `world.owllm.com` custom domain can replace
the default without changing the WebSocket contract.
The desktop contract is ordinary WebSocket JSON and is not tied to Cloudflare;
another backend can replace the Worker without changing the app.
