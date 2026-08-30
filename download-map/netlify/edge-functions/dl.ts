// Redirect-and-count Edge Function.
//
// Records the visitor's COUNTRY (provided by Netlify at the edge from the IP —
// we never see or store the IP ourselves), bumps an aggregate per-country
// counter in Netlify Blobs, then 302-redirects to the real GitHub installer.
//
// Privacy by design: we store ONLY counts keyed by ISO country code. No IP, no
// cookie, no per-user id, no timestamps-per-user — nothing that identifies a
// person. That is why this needs no consent banner (it processes no personal
// data). An analytics failure never blocks the download.
//
// The redirect target is resolved LIVE per OS (see resolve.mjs): we scan the
// repo's releases newest-first and pick the newest asset matching the platform
// by file type. This means the link never 404s just because a per-OS publish
// became "Latest" without that OS's asset, or because the filename was
// version-stamped. This IS the link to put on the site / README / socials.

import type { Context } from "@netlify/edge-functions";
import { getStore } from "@netlify/blobs";
import { resolveDownloadTarget } from "./resolve.mjs";

// Best-effort static fallbacks, used only if the live release scan fails
// (GitHub API down/rate-limited). Every fallback is a stable, direct installer
// URL. A download button must never dump a user into GitHub's raw asset list.
const FALLBACK: Record<string, string> = {
  win: "https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.Setup.exe",
  mac: "https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.Setup.dmg",
  linux: "https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.AppImage",
  deb: "https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.deb",
  rpm: "https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.x86_64.rpm",
  "linux-arm64": "https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.aarch64.AppImage",
  "deb-arm64": "https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.arm64.deb",
  "rpm-arm64": "https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.aarch64.rpm",
};
const DEFAULT_PLATFORM = "win";

// Cache resolved URLs briefly so we don't hit the GitHub API on every click
// (and to stay well under any edge rate limit). A few minutes of staleness is
// fine — a new release's asset just becomes reachable a few minutes later.
const CACHE_TTL_MS = 10 * 60 * 1000;

// /dl with no explicit platform → best guess from the requesting browser.
function platformFromUA(ua: string): string {
  if (/macintosh|mac os x/i.test(ua)) return "mac";
  if (/linux/i.test(ua) && !/android/i.test(ua)) return "linux";
  return DEFAULT_PLATFORM;
}

// Link-unfurlers / crawlers hit the redirect when the URL is shared (Slack,
// Discord, WhatsApp, Telegram, Twitter, search bots). Don't count those — they
// aren't real downloads and would inflate the map.
const BOT_RE =
  /bot|crawler|spider|crawl|preview|facebookexternalhit|slackbot|discordbot|telegrambot|twitterbot|whatsapp|bingbot|googlebot|yandex|baiduspider|duckduckbot|embedly|curl|wget|python-requests|headless/i;

async function targetFor(platform: string): Promise<string> {
  const fallback = FALLBACK[platform] ?? FALLBACK[DEFAULT_PLATFORM];
  // Try the cache first, then a live scan, then the static fallback.
  try {
    const cache = getStore("downloads");
    const key = `dl_cache:${platform}`;
    const hit = (await cache.get(key, { type: "json" })) as
      | { url: string; at: number }
      | null;
    if (hit && hit.url && Date.now() - hit.at < CACHE_TTL_MS) return hit.url;

    const resolved = await resolveDownloadTarget(platform, fetch);
    if (resolved) {
      try {
        await cache.setJSON(key, { url: resolved, at: Date.now() });
      } catch {
        // Cache write is best-effort; still return the resolved URL.
      }
      return resolved;
    }
  } catch {
    // Blobs/API hiccup — fall through to the static fallback below.
  }
  return fallback;
}

export default async (request: Request, context: Context): Promise<Response> => {
  const url = new URL(request.url);
  // /dl            → default platform
  // /dl/win        → explicit platform
  // /dl?p=win      → query form
  const segs = url.pathname.split("/").filter(Boolean); // e.g. ["dl","win"]
  const ua = request.headers.get("user-agent") || "";
  const platform = (
    segs[1] || url.searchParams.get("p") || platformFromUA(ua)
  ).toLowerCase();

  const target = await targetFor(platform);

  const isRealDownload = request.method === "GET" && !BOT_RE.test(ua);

  if (isRealDownload) {
    // ISO-3166 alpha-2, uppercase (e.g. "US", "DE"). "ZZ" when unknown.
    const country = (context.geo?.country?.code || "ZZ").toUpperCase();
    try {
      const store = getStore("downloads");
      const counts =
        ((await store.get("counts", { type: "json" })) as Record<string, number> | null) ?? {};
      counts[country] = (counts[country] ?? 0) + 1;
      counts.__total = (counts.__total ?? 0) + 1;
      counts[`__platform_${platform}`] = (counts[`__platform_${platform}`] ?? 0) + 1;
      await store.setJSON("counts", counts);
    } catch {
      // Swallow — the download must succeed even if the counter hiccups.
    }
  }

  return Response.redirect(target, 302);
};
