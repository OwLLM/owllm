#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const prompt = fs.readFileSync(path.join(HERE, "UpdatePrompt.tsx"), "utf8");
const rust = fs.readFileSync(path.resolve(HERE, "../../src-tauri/src/linux_updater.rs"), "utf8");
const wiring = fs.readFileSync(path.resolve(HERE, "../../src-tauri/src/lib.rs"), "utf8");
const release = fs.readFileSync(path.resolve(HERE, "../../scripts/publish-release.sh"), "utf8");

let failed = 0;
const check = (name, ok) => {
  if (!ok) {
    failed++;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`PASS ${name}`);
  }
};

check(
  "Linux AppImage updates use the deferred native handoff",
  prompt.includes('installMode === "linux-appimage"')
    && prompt.includes('invoke("linux_appimage_update_install"')
    && !/installMode === "linux-appimage"[\s\S]{0,900}relaunch\(\)/.test(prompt),
);
check(
  "The downloaded AppImage is signature-verified before staging",
  /update\s*\.download\(/.test(rust)
    && rust.search(/update\s*\.download\(/) < rust.indexOf("write_all(&bytes)"),
);
check(
  "AppImage activation is an atomic rename with rollback",
  rust.includes("fn atomic_swap(")
    && rust.includes("std::fs::rename(target, backup)")
    && rust.includes("std::fs::rename(stage, target)")
    && rust.includes("previous version restored"),
);
check(
  "The rollback copy is confirmed only after the main WebView loads",
  wiring.includes("PageLoadEvent::Finished")
    && wiring.indexOf("PageLoadEvent::Finished") < wiring.indexOf("confirm_successful_boot();"),
);
check(
  "Linux release assets and updater URLs are architecture-specific",
  release.includes('INSTALLER="dist/OwLLM.Desktop_${VERSION}_${ARCH}.AppImage"')
    && release.includes('OwLLM.Desktop_${VERSION}_${ARCH}.AppImage"'),
);
check(
  "Broken platform updater metadata is visible to users",
  prompt.includes("actionableCheckError")
    && prompt.includes("Automatic update needs attention"),
);

if (failed) process.exit(1);
