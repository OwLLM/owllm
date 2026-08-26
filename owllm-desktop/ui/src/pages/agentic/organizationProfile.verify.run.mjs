#!/usr/bin/env node
// Keep the GitHub organization profile aligned with the product that ships.
// The release smoke matrix auto-discovers this harness before publishing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../../..");
const ASSETS = path.join(ROOT, "profile-assets");
const LINUX_GUIDE_URL =
  "https://github.com/OwLLM/owllm/blob/main/INSTALL_LINUX.md";
const PROFILE = process.argv.includes("--stdin")
  ? fs.readFileSync(0, "utf8")
  : fs.readFileSync(
      path.join(ROOT, "owllm-dotgithub-profile-README.md"),
      "utf8",
    );
const ROOT_README = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const LINUX_GUIDE_PATH = path.join(ROOT, "INSTALL_LINUX.md");
const LINUX_GUIDE = fs.existsSync(LINUX_GUIDE_PATH)
  ? fs.readFileSync(LINUX_GUIDE_PATH, "utf8")
  : "";
const PUBLISH_SCRIPT = fs.readFileSync(
  path.join(ROOT, "owllm-desktop", "scripts", "publish-release.sh"),
  "utf8",
);
const FINISH_SCRIPT = fs.readFileSync(
  path.join(ROOT, "owllm-desktop", "scripts", "finish-multihost.sh"),
  "utf8",
);
const RELEASE_WORKFLOW = fs.readFileSync(
  path.join(ROOT, ".github", "workflows", "release.yml"),
  "utf8",
);
const DOWNLOAD_EDGE = fs.readFileSync(
  path.join(ROOT, "download-map", "netlify", "edge-functions", "dl.ts"),
  "utf8",
);
const { resolveDownloadTarget } = await import(
  pathToFileURL(
    path.join(ROOT, "download-map", "netlify", "edge-functions", "resolve.mjs"),
  ).href
);

let failed = 0;
function check(name, ok) {
  if (!ok) {
    failed++;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`PASS ${name}`);
  }
}

for (const asset of [
  "OwLLM.Desktop.Setup.exe",
  "OwLLM.Desktop.Setup.dmg",
]) {
  check(
    `profile links the stable ${asset} release asset`,
    PROFILE.includes(
      `https://github.com/OwLLM/owllm/releases/latest/download/${asset}`,
    ),
  );
}

check(
  "the organization Linux card opens the guided installer, not GitHub's asset pile",
  PROFILE.includes(`<a href="${LINUX_GUIDE_URL}">\n    <img src="https://raw.githubusercontent.com/OwLLM/.github/main/profile/linux-card.svg`)
    && !PROFILE.includes('<a href="https://github.com/OwLLM/owllm/releases/latest">\n    <img src="https://raw.githubusercontent.com/OwLLM/.github/main/profile/linux-card.svg'),
);
check(
  "the repository Linux card opens the same guided installer",
  ROOT_README.includes(`](${LINUX_GUIDE_URL})`)
    && !ROOT_README.includes(
      "](https://github.com/OwLLM/owllm/releases/latest)\n\nllama.cpp payloads",
    ),
);
check("the public Linux installation guide exists", LINUX_GUIDE.length > 0);

for (const asset of [
  "OwLLM.Desktop.AppImage",
  "OwLLM.Desktop.deb",
  "OwLLM.Desktop.x86_64.rpm",
  "OwLLM.Desktop.aarch64.AppImage",
  "OwLLM.Desktop.arm64.deb",
  "OwLLM.Desktop.aarch64.rpm",
]) {
  check(
    `the Linux guide links the stable ${asset} release asset`,
    LINUX_GUIDE.includes(
      `https://github.com/OwLLM/owllm/releases/latest/download/${asset}`,
    ),
  );
  check(
    `host and CI releases publish the stable ${asset} asset`,
    PUBLISH_SCRIPT.includes(`dist/${asset}`)
      && FINISH_SCRIPT.includes(asset)
      && RELEASE_WORKFLOW.includes(`stage/${asset}`),
  );
}

check(
  "the Linux guide teaches architecture selection instead of exposing filenames",
  LINUX_GUIDE.includes("uname -m")
    && LINUX_GUIDE.includes("x86_64")
    && LINUX_GUIDE.includes("aarch64")
    && LINUX_GUIDE.includes("arm64"),
);
check(
  "the Linux guide gives install commands for deb, rpm and AppImage",
  LINUX_GUIDE.includes("sudo apt install")
    && LINUX_GUIDE.includes("sudo dnf install")
    && LINUX_GUIDE.includes("chmod +x"),
);

const resolverAssets = [{
  tag_name: "v-test",
  draft: false,
  assets: [
    { name: "OwLLM.Desktop_9.9.9_amd64.AppImage", browser_download_url: "x86-appimage" },
    { name: "OwLLM.Desktop_9.9.9_aarch64.AppImage", browser_download_url: "arm-appimage" },
    { name: "OwLLM.Desktop_9.9.9_amd64.deb", browser_download_url: "x86-deb" },
    { name: "OwLLM.Desktop_9.9.9_arm64.deb", browser_download_url: "arm-deb" },
    { name: "OwLLM.Desktop_9.9.9_x86_64.rpm", browser_download_url: "x86-rpm" },
    { name: "OwLLM.Desktop_9.9.9_aarch64.rpm", browser_download_url: "arm-rpm" },
  ],
}];
const resolverFetch = async () => ({ ok: true, json: async () => resolverAssets });
for (const [platform, expected] of [
  ["linux", "x86-appimage"],
  ["linux-arm64", "arm-appimage"],
  ["deb", "x86-deb"],
  ["deb-arm64", "arm-deb"],
  ["rpm", "x86-rpm"],
  ["rpm-arm64", "arm-rpm"],
]) {
  check(
    `the download resolver selects ${platform} without crossing architectures`,
    await resolveDownloadTarget(platform, resolverFetch) === expected,
  );
}

const fallbackBlock = DOWNLOAD_EDGE.match(/const FALLBACK[\s\S]*?\n};/)?.[0] ?? "";
check(
  "a resolver failure still downloads an installer instead of opening the raw release page",
  fallbackBlock.length > 0
    && !/https:\/\/github\.com\/OwLLM\/owllm\/releases\/latest["']/.test(fallbackBlock),
);

for (const capability of [
  "Local GGUF",
  "Agent teams",
  "Native agent browser",
  "Fleet Control",
  "Fine-tuning",
  "Verification Gate",
  "Messaging bridges",
]) {
  check(`profile explains ${capability}`, PROFILE.includes(capability));
}

for (const card of [
  "windows-card.svg",
  "linux-card.svg",
  "macos-card.svg",
]) {
  const localPath = path.join(ASSETS, card);
  const body = fs.existsSync(localPath)
    ? fs.readFileSync(localPath, "utf8")
    : "";
  check(`profile keeps the visual ${card}`, PROFILE.includes(`/profile/${card}`));
  check(
    `${card} is a current shipping download card`,
    body.startsWith("<svg")
      && body.includes("SHIPPING")
      && !body.includes(">NEXT<")
      && !/Watch for Release/i.test(body),
  );
}

function pngDimensions(file) {
  if (!fs.existsSync(file)) return null;
  const data = fs.readFileSync(file);
  const pngMagic = "89504e470d0a1a0a";
  if (data.length < 24 || data.subarray(0, 8).toString("hex") !== pngMagic) {
    return null;
  }
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  };
}

for (const screenshot of [
  "owllm-coding.png",
  "owllm-team-studio.png",
  "owllm-model-workshop.png",
]) {
  const dimensions = pngDimensions(path.join(ASSETS, "screenshots", screenshot));
  check(
    `profile embeds the real ${screenshot} screenshot`,
    PROFILE.includes(`/profile/screenshots/${screenshot}`),
  );
  check(
    `${screenshot} is a useful PNG capture`,
    dimensions?.width >= 1000 && dimensions?.height >= 700,
  );
}

check(
  "profile explains the split model-agent-machine architecture",
  PROFILE.includes("Split the brains from the GPU")
    && PROFILE.includes("place each part where it belongs"),
);
check(
  "profile keeps the hero compact enough for downloads to enter the first screen",
  PROFILE.includes('OWLLM_Hero.png" alt="OWLLM" width="360"'),
);
check(
  "profile explains the verified coding workflow",
  PROFILE.includes("Coder → Critic → Publisher")
    && PROFILE.includes("A model saying “tests pass” is not a pass"),
);
check(
  "profile contains a current and sourced VS Code/OpenClaw comparison",
  PROFILE.includes("OWLLM vs VS Code vs OpenClaw")
    && PROFILE.includes("https://code.visualstudio.com/docs/agents/overview")
    && PROFILE.includes("https://docs.openclaw.ai/concepts/features"),
);
check(
  "comparison acknowledges competitors' current strengths",
  PROFILE.includes("VS Code now supports parallel agents, worktrees, BYOK")
    && PROFILE.includes("OpenClaw supports local providers, browser automation"),
);
check(
  "profile states honest product boundaries",
  PROFILE.includes("does **not** replace VS Code")
    && PROFILE.includes("does **not** claim OpenClaw"),
);
check(
  "profile distinguishes beta and experimental surfaces",
  PROFILE.includes("Lima isolation on macOS")
    && PROFILE.includes("bubblewrap isolation on Linux")
    && PROFILE.includes("## What is shipping, beta, and experimental"),
);
check(
  "profile avoids hardcoded release versions and package sizes",
  !/\bv\d+\.\d+\.\d+\b/.test(PROFILE)
    && !/\b\d+(?:\.\d+)?\s*(?:MB|MiB|GB|GiB)\b/.test(PROFILE),
);
check(
  "profile states the proprietary license and owner",
  PROFILE.includes("proprietary software")
    && PROFILE.includes("Far island Corporation Ltd."),
);
check(
  "profile no longer advertises macOS as future work",
  !/Watch for macOS release|macOS desktop.{0,40}(?:coming|next)|>NEXT</i.test(
    PROFILE,
  ),
);
check(
  "profile no longer describes proprietary OWLLM as an open platform",
  !/open platform|community-owned/i.test(PROFILE),
);
check(
  "profile does not link unpublished local documentation",
  !/\/blob\/main\/(?:docs|owllm-desktop\/docs)\//i.test(PROFILE),
);

if (failed) {
  console.error(`organizationProfile: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("organizationProfile: all checks passed");
