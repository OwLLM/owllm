// Token-gated stats endpoint. Returns the aggregate per-country download counts
// as JSON so the map dashboard can render them. Gated by the STATS_TOKEN env var
// (set it in the Netlify UI) so your download numbers stay private.
//
// GET /stats?token=<STATS_TOKEN>  →  { "US": 12, "DE": 5, "__total": 17, ... }

import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

export default async (req: Request, _context: Context): Promise<Response> => {
  const token = new URL(req.url).searchParams.get("token") || "";
  const expected = Netlify.env.get("STATS_TOKEN") || "";

  // Constant-ish comparison; tokens are short and this isn't a high-value secret,
  // but avoid leaking length-based timing where trivial.
  if (!expected || token.length !== expected.length || token !== expected) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  const store = getStore("downloads");
  const counts = ((await store.get("counts", { type: "json" })) as Record<string, number>) ?? {};
  return new Response(JSON.stringify(counts), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
};

export const config: Config = { path: "/stats" };
