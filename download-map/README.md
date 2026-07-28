# OwLLM Download Map

A tiny Netlify site that shows **where OwLLM Desktop is downloaded from**, on a
world map — without collecting any personal data.

## How it works

```
  share this link  ─►  /dl/win  (Edge Function)  ─►  302 redirect  ─►  GitHub installer
                          │
                          └─ reads the visitor's COUNTRY at the edge,
                             bumps an aggregate per-country counter (Netlify Blobs)
```

- **`/dl/win`** — the link you put on your site / README / socials. It records the
  country and forwards to the latest GitHub installer. (Add `/dl/mac`, `/dl/linux`
  in `netlify/edge-functions/dl.ts` when those builds exist.)
- **`/stats?token=…`** — returns the aggregate counts as JSON (token-gated).
- **`/`** — a private dashboard: a world map shaded by downloads + a country table.

## Privacy — why no consent banner is needed

It stores **only** an aggregate counter keyed by ISO country code
(`{ "US": 12, "DE": 5, … }`). It does **not** store:

- IP addresses (Netlify resolves country at the edge; the IP never reaches our code or storage),
- cookies,
- per-user identifiers, sessions, or per-request timestamps.

Aggregate country counts with no identifiers are **not personal data**, so this
processes none — which is the basis for needing no consent. (Good practice: still
mention "we keep an anonymous per-country count of downloads" in your privacy
page. This is guidance, not legal advice — confirm against your own obligations.)

## Limitations (honest)

- **Only counts downloads through your `/dl/...` link.** Files grabbed straight from
  the GitHub Releases page can't be counted — GitHub doesn't expose that, and no one
  can intercept it. Use the redirect link everywhere you promote the app.
- **Bots/unfurlers are filtered** by User-Agent (Slack/Discord/WhatsApp/Telegram/
  Twitter/search bots), so sharing the link doesn't inflate counts. Filtering isn't
  perfect; a determined crawler could still slip through.
- **The counter is a read-modify-write** on one blob. At an indie app's download rate
  this is fine; under a simultaneous burst a few hits could be lost. (Upgrade path:
  per-country keys + a durable store if you ever need exact high-volume counts.)
- The app's **auto-updater still pulls from GitHub directly** — updates are not new
  downloads, so they're correctly NOT counted here.

## Deploy (one-time, ~5 min)

You need a free Netlify account. From this folder:

```bash
npm install
npm install -g netlify-cli      # if you don't have it
netlify login
netlify init                    # create a new site (or link an existing one)
# Set the dashboard password (any random string):
netlify env:set STATS_TOKEN "pick-a-long-random-string"
netlify deploy --build --prod
```

Netlify Blobs is enabled automatically — no extra setup.

Alternatively, connect this repo folder to Netlify in the UI (Site → Build settings →
Base directory = `download-map`) and set `STATS_TOKEN` under Site → Environment variables.

### After deploy

- **Download link to share:** `https://<your-site>.netlify.app/dl/win`
- **Your map:** `https://<your-site>.netlify.app/` → enter `STATS_TOKEN`
  (or open `https://<your-site>.netlify.app/#token=<STATS_TOKEN>` to skip the prompt).

### Test it

1. Open the `/dl/win` link in a browser — it should download the installer.
2. Open `/` and enter your token — your country should show a count of 1.
