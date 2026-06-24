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

// The artifacts you ship. Add mac/linux here when those builds exist.
const TARGETS: Record<string, string> = {
  win: "https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.Setup.exe",
};
const DEFAULT_PLATFORM = "win";

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
  const platform = (segs[1] || url.searchParams.get("p") || DEFAULT_PLATFORM).toLowerCase();
  const target = TARGETS[platform] ?? TARGETS[DEFAULT_PLATFORM];

  const ua = request.headers.get("user-agent") || "";
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
