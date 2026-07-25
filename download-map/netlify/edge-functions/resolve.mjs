// Pure, dependency-free download-target resolver — shared by the `/dl` edge
// function and its node test.
//
// The problem this solves: a static `releases/latest/download/<name>` link
// 404s whenever the release GitHub marks "Latest" doesn't happen to carry that
// OS's asset — e.g. a Mac-only publish becomes Latest and the Windows `.exe`
// link breaks, or Linux ships a version-stamped `..._0.9.37_aarch64.AppImage`
// that never matches the stable name. So instead of trusting one release +
// one exact filename, we scan releases newest-first and pick the newest asset
// that matches the requested OS BY FILE TYPE. As long as any release ever
// shipped that OS, the link resolves.

// Per-platform matchers, in preference order (tier 0 wins over tier 1, etc.).
// Mac prefers a real `.dmg` installer but falls back to the `.app.tar.gz`
// updater bundle when that's the only Mac artifact a release produced.
export const PLATFORM_MATCHERS = {
  win: [/\.exe$/i],
  mac: [/\.dmg$/i, /\.app\.tar\.gz$/i],
  linux: [/\.appimage$/i],
  deb: [/\.deb$/i],
};

export const RELEASES_API =
  "https://api.github.com/repos/OwLLM/owllm/releases?per_page=30";

// Resolve the download URL for `platform` by scanning the repo's releases
// newest-first. Returns the asset's browser_download_url, or null if no
// published (non-draft) release carries a matching asset — the caller then
// falls back so a download request never hard-fails.
export async function resolveDownloadTarget(platform, fetchImpl) {
  const tiers = PLATFORM_MATCHERS[platform];
  if (!tiers) return null;

  let res;
  try {
    res = await fetchImpl(RELEASES_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "owllm-download-redirect",
      },
    });
  } catch {
    return null;
  }
  if (!res || !res.ok) return null;

  let releases;
  try {
    releases = await res.json();
  } catch {
    return null;
  }
  if (!Array.isArray(releases)) return null;

  // GitHub returns releases newest-first. Record the newest asset URL for each
  // preference tier, then return the best tier that matched anything.
  const best = new Array(tiers.length).fill(null);
  for (const rel of releases) {
    if (!rel || rel.draft) continue;
    for (const asset of rel.assets || []) {
      const name = asset && asset.name;
      const dl = asset && asset.browser_download_url;
      if (!name || !dl) continue;
      for (let t = 0; t < tiers.length; t++) {
        if (best[t]) continue;
        if (tiers[t].test(name)) best[t] = dl;
      }
    }
  }
  for (const url of best) if (url) return url;
  return null;
}
