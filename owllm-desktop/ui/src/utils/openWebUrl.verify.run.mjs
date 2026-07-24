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

const appShell = fs.readFileSync(path.join(SRC, "AppShell.tsx"), "utf8");
check(appShell.includes('import { openWebUrl } from "./utils/openWebUrl";')
  && appShell.includes('const MARKETPLACE_URL = "https://marketplace.owllm.com/";'),
  "the global shell routes the canonical marketplace URL through openWebUrl");
check(appShell.includes('data-ui="MarketplaceButton"')
  && appShell.includes('<span>Marketplace</span>')
  && appShell.includes('onClick={onOpenMarketplace}'),
  "the app header exposes a clearly labelled global Marketplace button");
const marketplaceHandler = appShell.match(/onOpenMarketplace=\{\(\) => \{([\s\S]*?)\n\s*\}\}/)?.[1] ?? "";
check(marketplaceHandler.includes("openWebUrl(MARKETPLACE_URL)")
  && !marketplaceHandler.includes("setActiveKey")
  && !marketplaceHandler.includes("setMode"),
  "the Marketplace click opens the browser without changing the active workspace");

const paths = fs.readFileSync(path.join(DESKTOP, "src-tauri/src/paths.rs"), "utf8");
check(!paths.includes("xdg-open") && !paths.includes('Command::new("open")') && !paths.includes('args(["/c", "start"'),
  "the legacy command cannot escape through Windows, Linux, or macOS shell openers");
check(paths.includes("crate::browser::open_web_url(&app, &url)"),
  "older UI bundles are redirected to the same embedded-browser route");

const lib = fs.readFileSync(path.join(DESKTOP, "src-tauri/src/lib.rs"), "utf8");
check(lib.includes("browser::browser_open_url"),
  "the embedded-browser command is registered with Tauri");

const browser = fs.readFileSync(path.join(DESKTOP, "src-tauri/src/browser.rs"), "utf8");
check(browser.includes('r.join("browser_profile")') && browser.includes("content.data_directory(dir)"),
  "the OwLLM browser uses a stable profile so marketplace login survives visits");
const openWebUrlNative = browser.slice(
  browser.indexOf("pub(crate) fn open_web_url"),
  browser.indexOf("fn parse_navigation_url"),
);
check(openWebUrlNative.includes("new_tab(app, parsed.as_str(), true)")
  && openWebUrlNative.includes("win.show()")
  && openWebUrlNative.includes("win.unminimize()")
  && openWebUrlNative.includes("win.set_focus()"),
  "opening Marketplace activates its tab and focuses the OwLLM browser window");

console.log(`OK open-web-url audit: ${passed} checks passed across ${uiFiles.length} UI source files`);
