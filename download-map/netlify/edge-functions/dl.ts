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

import type { Context } from "@netlify/edge-functions";
import { getStore } from "@netlify/blobs";

// The artifacts you ship — stable asset names uploaded by publish-release.sh.
// mac/linux 404 until their first release is published from that OS; the
// endpoints are wired now so links/docs don't need another change then.
const TARGETS: Record<string, string> = {
  win: "https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.Setup.exe",
  mac: "https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.Setup.dmg",
  linux: "https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.AppImage",
};
const DEFAULT_PLATFORM = "win";

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
  const target = TARGETS[platform] ?? TARGETS[DEFAULT_PLATFORM];

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
