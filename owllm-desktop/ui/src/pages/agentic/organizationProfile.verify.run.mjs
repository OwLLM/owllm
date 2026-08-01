#!/usr/bin/env node
// Keep the GitHub organization profile aligned with the product that ships.
// The release smoke matrix auto-discovers this harness before publishing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../../..");
const ASSETS = path.join(ROOT, "profile-assets");
const PROFILE = process.argv.includes("--stdin")
  ? fs.readFileSync(0, "utf8")
  : fs.readFileSync(
      path.join(ROOT, "owllm-dotgithub-profile-README.md"),
      "utf8",
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
  "OwLLM.Desktop.AppImage",
  "OwLLM.Desktop.deb",
  "OwLLM.Desktop.Setup.dmg",
]) {
  check(
    `profile links the stable ${asset} release asset`,
    PROFILE.includes(
      `https://github.com/OwLLM/owllm/releases/latest/download/${asset}`,
    ),
  );
}

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
