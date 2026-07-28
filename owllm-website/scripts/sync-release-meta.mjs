import { writeFile, readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "data", "release.json");
const FALLBACK_PATH = join(__dirname, "..", "src", "data", "release.local.json");

const REPO = process.env.PUBLIC_GITHUB_REPO || "OwLLM/owllm";
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

async function fetchLatest() {
  const response = await fetch(API_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "owllm-website-sync",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API responded ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  return {
    version: data.tag_name,
    url: data.html_url,
    publishedAt: data.published_at,
    assets: (data.assets || []).map((asset) => ({
      name: asset.name,
      browserDownloadUrl: asset.browser_download_url,
      size: asset.size,
    })),
  };
}

async function loadFallback() {
  const raw = await readFile(FALLBACK_PATH, "utf8");
  return JSON.parse(raw);
}

async function main() {
  let meta;
  try {
    meta = await fetchLatest();
    console.log(`Synced release metadata: ${meta.version}`);
  } catch (error) {
    console.warn("Failed to fetch latest release; using local fallback.", error.message || error);
    meta = await loadFallback();
  }
  // src/data/ is gitignored, so it is absent on a fresh checkout — create it or
  // the write below fails with ENOENT and takes the whole site build with it.
  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(meta, null, 2) + "\n", "utf8");
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
