// Verifies the per-OS download resolver: newest release that actually carries
// the OS's asset wins, matched by file type (not exact filename), and a
// partial "Latest" never breaks the other platforms.
//
// Run: node --test  (from download-map/)

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { resolveDownloadTarget } from "../netlify/edge-functions/resolve.mjs";

// Fixture mirrors the real repo state that caused the 404s: v0.9.39 is a
// Windows+Mac(updater-bundle) release with NO dmg/AppImage; the versioned
// Linux AppImage only ever shipped in v0.9.37; an older v0.9.20 carried a real
// .dmg and a .deb.
const RELEASES = [
  {
    tag_name: "v0.9.39",
    draft: false,
    assets: [
      { name: "latest.json", browser_download_url: "u/latest.json" },
      { name: "OwLLM.Desktop.Setup.exe", browser_download_url: "u/39/Setup.exe" },
      { name: "OwLLM.Desktop_aarch64.app.tar.gz", browser_download_url: "u/39/app.tar.gz" },
    ],
  },
  {
    tag_name: "v0.9.38",
    draft: false,
    assets: [{ name: "OwLLM.Desktop.Setup.exe", browser_download_url: "u/38/Setup.exe" }],
  },
  {
    tag_name: "v0.9.37",
    draft: false,
    assets: [
      { name: "OwLLM.Desktop.Setup.exe", browser_download_url: "u/37/Setup.exe" },
      { name: "OwLLM.Desktop_0.9.37_aarch64.AppImage", browser_download_url: "u/37/App.AppImage" },
      { name: "OwLLM.Desktop_0.9.37_amd64.AppImage", browser_download_url: "u/37/amd64.AppImage" },
      { name: "OwLLM.Desktop_0.9.37_arm64.deb", browser_download_url: "u/37/arm64.deb" },
      { name: "OwLLM.Desktop_0.9.37_x86_64.rpm", browser_download_url: "u/37/x86_64.rpm" },
      { name: "OwLLM.Desktop_0.9.37_aarch64.rpm", browser_download_url: "u/37/aarch64.rpm" },
      { name: "OwLLM.Desktop_aarch64.app.tar.gz", browser_download_url: "u/37/app.tar.gz" },
    ],
  },
  {
    tag_name: "v0.9.20",
    draft: false,
    assets: [
      { name: "OwLLM.Desktop.Setup.dmg", browser_download_url: "u/20/Setup.dmg" },
      { name: "OwLLM.Desktop.deb", browser_download_url: "u/20/App.deb" },
    ],
  },
];

function fakeFetch(releases, { ok = true } = {}) {
  return async () => ({ ok, json: async () => releases });
}

test("windows resolves to the newest release carrying a .exe", async () => {
  const url = await resolveDownloadTarget("win", fakeFetch(RELEASES));
  assert.equal(url, "u/39/Setup.exe");
});

test("windows still resolves when Latest is a Mac-only publish", async () => {
  // Newest release has NO .exe — must fall through to the next release that does.
  const macOnlyLatest = [
    { tag_name: "v0.9.40", draft: false, assets: [{ name: "OwLLM.Desktop_aarch64.app.tar.gz", browser_download_url: "u/40/app.tar.gz" }] },
    ...RELEASES,
  ];
  const url = await resolveDownloadTarget("win", fakeFetch(macOnlyLatest));
  assert.equal(url, "u/39/Setup.exe");
});

test("mac prefers a real .dmg over a newer .app.tar.gz", async () => {
  const url = await resolveDownloadTarget("mac", fakeFetch(RELEASES));
  assert.equal(url, "u/20/Setup.dmg");
});

test("mac falls back to .app.tar.gz when no .dmg exists anywhere", async () => {
  const noDmg = RELEASES.filter((r) => r.tag_name !== "v0.9.20");
  const url = await resolveDownloadTarget("mac", fakeFetch(noDmg));
  assert.equal(url, "u/39/app.tar.gz");
});

test("linux matches the version-stamped AppImage filename", async () => {
  const url = await resolveDownloadTarget("linux", fakeFetch(RELEASES));
  assert.equal(url, "u/37/amd64.AppImage");
});

test("linux never hands an ARM64 visitor the x86-64 package or vice versa", async () => {
  assert.equal(
    await resolveDownloadTarget("linux-arm64", fakeFetch(RELEASES)),
    "u/37/App.AppImage",
  );
  assert.equal(
    await resolveDownloadTarget("deb-arm64", fakeFetch(RELEASES)),
    "u/37/arm64.deb",
  );
  assert.equal(
    await resolveDownloadTarget("rpm", fakeFetch(RELEASES)),
    "u/37/x86_64.rpm",
  );
  assert.equal(
    await resolveDownloadTarget("rpm-arm64", fakeFetch(RELEASES)),
    "u/37/aarch64.rpm",
  );
});

test("stable guided-download aliases resolve for every Linux package", async () => {
  const stable = [{
    tag_name: "v1.0.30",
    draft: false,
    assets: [
      { name: "OwLLM.Desktop.AppImage", browser_download_url: "u/stable/x86.AppImage" },
      { name: "OwLLM.Desktop.deb", browser_download_url: "u/stable/x86.deb" },
      { name: "OwLLM.Desktop.x86_64.rpm", browser_download_url: "u/stable/x86.rpm" },
      { name: "OwLLM.Desktop.aarch64.AppImage", browser_download_url: "u/stable/arm.AppImage" },
      { name: "OwLLM.Desktop.arm64.deb", browser_download_url: "u/stable/arm.deb" },
      { name: "OwLLM.Desktop.aarch64.rpm", browser_download_url: "u/stable/arm.rpm" },
    ],
  }];
  assert.equal(await resolveDownloadTarget("linux", fakeFetch(stable)), "u/stable/x86.AppImage");
  assert.equal(await resolveDownloadTarget("deb", fakeFetch(stable)), "u/stable/x86.deb");
  assert.equal(await resolveDownloadTarget("rpm", fakeFetch(stable)), "u/stable/x86.rpm");
  assert.equal(await resolveDownloadTarget("linux-arm64", fakeFetch(stable)), "u/stable/arm.AppImage");
  assert.equal(await resolveDownloadTarget("deb-arm64", fakeFetch(stable)), "u/stable/arm.deb");
  assert.equal(await resolveDownloadTarget("rpm-arm64", fakeFetch(stable)), "u/stable/arm.rpm");
});

test("an API fallback never sends a download button to the raw release page", () => {
  const edgeFunction = fs.readFileSync(
    new URL("../netlify/edge-functions/dl.ts", import.meta.url),
    "utf8",
  );
  const fallbackBlock = edgeFunction.match(/const FALLBACK[\s\S]*?\n};/)?.[0] ?? "";
  assert.ok(fallbackBlock);
  assert.doesNotMatch(
    fallbackBlock,
    /https:\/\/github\.com\/OwLLM\/owllm\/releases\/latest["']/,
  );
  for (const asset of [
    "OwLLM.Desktop.AppImage",
    "OwLLM.Desktop.deb",
    "OwLLM.Desktop.x86_64.rpm",
    "OwLLM.Desktop.aarch64.AppImage",
    "OwLLM.Desktop.arm64.deb",
    "OwLLM.Desktop.aarch64.rpm",
  ]) {
    assert.match(fallbackBlock, new RegExp(asset.replaceAll(".", "\\.")));
  }
});

test("deb resolves to the newest release carrying a .deb", async () => {
  const url = await resolveDownloadTarget("deb", fakeFetch(RELEASES));
  assert.equal(url, "u/20/App.deb");
});

test("returns null when no release carries the OS (caller uses fallback)", async () => {
  const winOnly = [{ tag_name: "v1", draft: false, assets: [{ name: "OwLLM.Desktop.Setup.exe", browser_download_url: "u/exe" }] }];
  assert.equal(await resolveDownloadTarget("linux", fakeFetch(winOnly)), null);
  assert.equal(await resolveDownloadTarget("deb", fakeFetch(winOnly)), null);
});

test("draft releases are ignored", async () => {
  const withDraft = [
    { tag_name: "v9", draft: true, assets: [{ name: "OwLLM.Desktop.Setup.exe", browser_download_url: "u/draft.exe" }] },
    ...RELEASES,
  ];
  const url = await resolveDownloadTarget("win", fakeFetch(withDraft));
  assert.equal(url, "u/39/Setup.exe");
});

test("API failure yields null (never throws)", async () => {
  assert.equal(await resolveDownloadTarget("win", fakeFetch(RELEASES, { ok: false })), null);
  assert.equal(await resolveDownloadTarget("win", async () => { throw new Error("network"); }), null);
});

test("unknown platform yields null", async () => {
  assert.equal(await resolveDownloadTarget("beos", fakeFetch(RELEASES)), null);
});
