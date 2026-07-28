#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const app = fs.readFileSync(path.join(HERE, "AppShell.tsx"), "utf8");
const rust = fs.readFileSync(path.resolve(HERE, "../../src-tauri/src/lib.rs"), "utf8");
const autostart = fs.readFileSync(path.resolve(HERE, "../../src-tauri/src/autostart.rs"), "utf8");
const paths = fs.readFileSync(path.resolve(HERE, "../../src-tauri/src/paths.rs"), "utf8");
const remoteExecutor = fs.readFileSync(path.resolve(HERE, "../../src-tauri/src/remote_devices/executor.rs"), "utf8");

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
  /var_os\("WEBKIT_DISABLE_DMABUF_RENDERER"\)\.is_none\(\)[\s\S]*set_var\("WEBKIT_DISABLE_DMABUF_RENDERER"/.test(rust),
);
check(
  "NVIDIA Linux keeps WebKit compositing enabled instead of saturating a CPU core",
  !rust.includes('set_var("WEBKIT_DISABLE_COMPOSITING_MODE"'),
);
check(
  "Linux AppImage autostart uses the persistent image path instead of its temporary mount",
  autostart.includes('var_os("APPIMAGE")')
    && autostart.includes(".filter(|path| path.is_absolute() && path.is_file())")
    && autostart.includes("let exe = linux_exe_path()"),
);
check(
  "Autostart registration is refreshed on launch so stale entries self-heal",
  /pub fn ensure_default_enabled\(\)[\s\S]*set\(true\)/.test(autostart)
    && !/pub fn ensure_default_enabled\(\)[\s\S]*if is_enabled\(\)[\s\S]*return/.test(autostart),
);
check(
  "Remote Linux commands cannot inherit temporary AppImage runtimes",
  paths.includes('pub(crate) const APPIMAGE_RUNTIME_ENV_KEYS')
    && paths.includes('"PYTHONHOME"')
    && paths.includes('"PYTHONPATH"')
    && remoteExecutor.includes("for key in crate::paths::APPIMAGE_RUNTIME_ENV_KEYS")
    && remoteExecutor.includes("cmd.env_remove(key)"),
);

if (failed) process.exit(1);
