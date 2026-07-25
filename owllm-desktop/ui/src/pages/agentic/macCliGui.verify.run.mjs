import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(here, "..", "..");
const desktopRoot = path.resolve(uiRoot, "..", "..");
const accountsPage = fs.readFileSync(
  path.join(uiRoot, "pages", "advanced", "AccountsPage.tsx"),
  "utf8",
);
const accountsRs = fs.readFileSync(
  path.join(desktopRoot, "src-tauri", "src", "accounts.rs"),
  "utf8",
);
const ptyRs = fs.readFileSync(
  path.join(desktopRoot, "src-tauri", "src", "pty.rs"),
  "utf8",
);
const pathsRs = fs.readFileSync(
  path.join(desktopRoot, "src-tauri", "src", "paths.rs"),
  "utf8",
);

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

check(
  "Accounts status returns the native backend host OS",
  accountsRs.includes("host_os: std::env::consts::OS.to_string()"),
);
check(
  "route rows receive the resolved host label",
  /function RouteRow\(\{\s*provider, route, state, hostLabel,/.test(accountsPage)
    && accountsPage.includes("hostLabel: string;"),
);
check(
  "probe result renders the native host label rather than hard-coded Windows",
  accountsPage.includes("<b>{hostLabel}:</b> {state.testText}")
    && !accountsPage.includes("<b>Windows:</b> {state.testText}"),
);
check(
  "provider cards pass the host label into every route",
  accountsPage.includes("hostLabel={hostLabel}"),
);
check(
  "CLI install buttons expose their backend for mounted click coverage",
  accountsPage.includes("data-cli-backend={route.backend}"),
);
check(
  "CLI Test buttons expose their backend for mounted click coverage",
  accountsPage.includes("data-cli-test-backend={route.backend}"),
);
check(
  "CLI child PATH is shared by installer probes and real runs",
  accountsRs.includes("pub(crate) fn cli_child_path()")
    && /fn sanitize_appimage_env\(cmd: &mut Command\) \{\s*if let Some\(path\) = cli_child_path\(\)/s.test(accountsRs),
);
check(
  "npm prefix and upgrade commands receive the native CLI PATH",
  accountsRs.includes("npm itself is commonly a `#!/usr/bin/env node` script")
    && accountsRs.includes("sanitize_appimage_env(&mut cmd);\n        let out = cmd.output()"),
);
check(
  "embedded login PTY reuses the Accounts CLI PATH",
  ptyRs.includes("crate::accounts::cli_child_path()"),
);
check(
  "macOS Homebrew location remains part of CLI discovery",
  accountsRs.includes('"/opt/homebrew/bin"'),
);
check(
  "Mac native regression checks Homebrew Node in GUI child PATH",
  accountsRs.includes("fn gui_cli_path_includes_homebrew_interpreters()")
    && accountsRs.includes("fn finder_environment_can_launch_homebrew_node_cli()"),
);
check(
  "bundled POSIX npm and npx extraction damage is self-repaired",
  pathsRs.includes("fn repair_posix_node_shims")
    && pathsRs.includes('("npm", "../lib/node_modules/npm/bin/npm-cli.js")')
    && pathsRs.includes('("npx", "../lib/node_modules/npm/bin/npx-cli.js")')
    && /module_node_dir\(\)[\s\S]*repair_posix_node_shims\(&dir\)/.test(pathsRs),
);

console.log(`mac CLI GUI verification: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
