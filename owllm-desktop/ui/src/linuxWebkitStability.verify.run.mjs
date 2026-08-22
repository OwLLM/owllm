// Focused regression checks for Linux WebKit stability. The real policy module
// is transpiled and exercised with representative user agents; source checks
// keep activity motion, the safe native renderer choice, and crash recovery
// wired together.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "../..");
const require = createRequire(path.join(DESKTOP, "package.json"));
const ts = require("typescript");
const read = (relative) => fs.readFileSync(path.join(HERE, relative), "utf8").replace(/\r\n/g, "\n");
const policySource = read("runtime/renderingPolicy.ts");
const policyJs = ts.transpileModule(policySource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function loadPolicy(userAgent, reducedMotion = false) {
  const module = { exports: {} };
  const context = {
    module,
    exports: module.exports,
    navigator: { userAgent },
    window: { matchMedia: () => ({ matches: reducedMotion }) },
  };
  vm.runInNewContext(policyJs, context);
  return module.exports;
}

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
}

const linuxWebKit = loadPolicy(
  "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15",
);
check(linuxWebKit.isLinuxWebKit(), "WebKitGTK on Linux is detected");
check(linuxWebKit.continuousUiAnimation("spin") === "spin",
  "Linux WebKit preserves animated activity indicators");
check(linuxWebKit.continuousUiMotionEnabled() === true,
  "Linux WebKit preserves active graph motion");

const linuxChromium = loadPolicy(
  "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
);
check(!linuxChromium.isLinuxWebKit() && linuxChromium.continuousUiAnimation("spin") === "spin",
  "Linux Chromium development remains animated");

const macWebKit = loadPolicy(
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
);
check(!macWebKit.isLinuxWebKit() && macWebKit.continuousUiAnimation("spin") === "spin",
  "accelerated macOS WebKit remains animated");
check(loadPolicy("test", true).continuousUiAnimation("spin") === undefined,
  "the same policy honors the operating system's reduced-motion preference");

const hook = read("hooks/useAnimatedPhase.ts");
check(hook.includes("!active || !continuousUiMotionEnabled()"),
  "the shared 30-fps React pulse hook is gated by the rendering policy");

const shell = read("AppShell.tsx");
const agents = read("pages/agentic/AgentsPage.tsx");
const code = read("pages/agentic/CodePage.tsx");
check(shell.includes('continuousUiAnimation("owllm-aura-spin 4s linear infinite")'),
  "both persistent header auras use the rendering policy");
// The tile + graph-card aura moved behind psychedelicActiveStyle() when the 🍄
// preference landed (psychedelicMode.ts) — same invariant, one origin: that
// helper is the single place either card gets its animation, and it still goes
// through the rendering policy.
const psychedelic = read("pages/agentic/psychedelicMode.ts");
check(psychedelic.includes('const PSYCHEDELIC_SPIN = "owllm-aura-spin 4s linear infinite"')
  && psychedelic.includes("const animation = continuousUiAnimation(PSYCHEDELIC_SPIN)"),
  "the shared agentic card aura uses the rendering policy");
check((agents.match(/animation: isActive \? active(Aura|NodeAura)\.animation : undefined/g) || []).length === 2
  && !agents.includes("continuousUiAnimation("),
  "agent tiles and graph cards take their animation from that one helper");
check(code.includes('continuousUiAnimation("owllm-aura-spin 4s linear infinite")'),
  "coding panes use the rendering policy");
check(code.includes('continuousUiAnimation("owllm-tab-working 1.4s ease-in-out infinite")'),
  "coding-tab glow uses the same reduced-motion policy");

const rust = fs.readFileSync(path.join(DESKTOP, "src-tauri/src/lib.rs"), "utf8").replace(/\r\n/g, "\n");
check(rust.includes('set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1")')
    && !rust.includes('set_var("WEBKIT_DISABLE_COMPOSITING_MODE"'),
  "NVIDIA Linux disables unsafe DMA-BUF without forcing CPU compositing");
check(rust.includes("connect_web_process_terminated")
    && rust.includes("WebProcessTerminationReason::Crashed")
    && rust.includes("WebProcessTerminationReason::ExceededMemoryLimit")
    && rust.includes("webview.reload()"),
  "native Linux WebKit crashes and memory-limit terminations are logged and recovered");
check(rust.includes('root.join("linux-webkit.log")'),
  "native WebKit termination reasons are written to the durable user-data directory");
check(rust.includes("set_enable_media_stream(true)")
    && rust.includes("enable_linux_webview_media_capture(app)")
    && rust.includes("connect_permission_request")
    && rust.includes("UserMediaPermissionRequest"),
  "Linux main WebView enables media-stream and grants camera/microphone capture requests");

console.log(`OK Linux WebKit stability: ${passed}/${passed} checks passed`);
