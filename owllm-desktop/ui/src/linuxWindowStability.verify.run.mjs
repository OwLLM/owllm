#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const app = fs.readFileSync(path.join(HERE, "AppShell.tsx"), "utf8");
const rust = fs.readFileSync(path.resolve(HERE, "../../src-tauri/src/lib.rs"), "utf8");

let failed = 0;
const check = (name, ok) => {
  if (!ok) { failed++; console.error(`FAIL ${name}`); }
  else console.log(`PASS ${name}`);
};

check(
  "Linux opaque main window renders content directly without HybridFrame backing bands",
  app.includes('const IS_LINUX = typeof navigator')
    && /IS_LINUX[\s\S]*data-ui="LinuxMainContent"[\s\S]*<HybridFrame/.test(app),
);
check(
  "Linux omits the decorative window-edge overlay",
  app.includes("{!IS_LINUX && <WindowAccentEdge />}")
);
check(
  "NVIDIA Linux disables WebKitGTK DMA-BUF before Tauri starts",
  rust.includes("fn configure_linux_webkit_renderer()")
    && rust.includes('var_os("WEBKIT_DISABLE_DMABUF_RENDERER")')
    && rust.indexOf("configure_linux_webkit_renderer();") < rust.indexOf("tauri::Builder::default()"),
);
check(
  "An explicit WebKit renderer environment choice is preserved",
  /var_os\("WEBKIT_DISABLE_DMABUF_RENDERER"\)\.is_some\(\)[\s\S]*return;/.test(rust),
);

if (failed) process.exit(1);
