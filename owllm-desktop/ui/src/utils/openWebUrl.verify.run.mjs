// Cross-platform web-link routing regression guard.
// Every user-facing http(s) link must open in OwLLM's persistent browser;
// external shell/window fallbacks lose the shared login profile and can route
// URLs to the wrong desktop handler on Linux.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");
const DESKTOP = path.resolve(SRC, "../..");

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`OK ${message}`);
}

const uiFiles = filesUnder(SRC).filter((file) => !file.endsWith("catalog.generated.ts"));
const offenders = (needle) => uiFiles
  .filter((file) => fs.readFileSync(file, "utf8").includes(needle))
  .map((file) => path.relative(SRC, file));

check(offenders('invoke("shell_open_url"').length === 0,
  "no UI caller bypasses the central OwLLM-browser helper");
check(offenders("window.open(").length === 0,
  "no UI caller falls back to the OS browser");

const helper = fs.readFileSync(path.join(HERE, "openWebUrl.ts"), "utf8");
check(helper.includes('invoke<string>("browser_open_url", { url })'),
  "the shared UI helper invokes the native OwLLM browser command");
const main = fs.readFileSync(path.join(SRC, "main.tsx"), "utf8");
check(helper.includes('target.closest("a[href]")') && main.includes("installOwllmWebLinkInterceptor()"),
  "plain current and future http(s) anchors are intercepted at the app root");

const paths = fs.readFileSync(path.join(DESKTOP, "src-tauri/src/paths.rs"), "utf8");
check(!paths.includes("xdg-open") && !paths.includes('Command::new("open")') && !paths.includes('args(["/c", "start"'),
  "the legacy command cannot escape through Windows, Linux, or macOS shell openers");
check(paths.includes("crate::browser::open_web_url(&app, &url)"),
  "older UI bundles are redirected to the same embedded-browser route");

const lib = fs.readFileSync(path.join(DESKTOP, "src-tauri/src/lib.rs"), "utf8");
check(lib.includes("browser::browser_open_url"),
  "the embedded-browser command is registered with Tauri");

console.log(`OK open-web-url audit: ${passed} checks passed across ${uiFiles.length} UI source files`);
