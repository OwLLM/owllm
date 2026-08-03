// Regression check for the live server/VRAM control on the right of the main
// header. It was silently dropped by 3ff832b9 (a mac-overlay commit) even
// though the user had asked only for the API-key line to go, and the guard
// protecting it was inverted in the same commit. It must stay visible, stay
// clickable into the Server modal, and stay sized for the 88px header.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const shell = fs.readFileSync(path.join(HERE, "AppShell.tsx"), "utf8").replace(/\r\n/g, "\n");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`✓ ${message}`);
}

for (const present of [
  'data-ui="SysInfoBlock"',
  'data-ui="HeaderServersLabel"',
  'data-ui="HeaderVramLabel"',
  '<GenSpeedBadge variant="header" />',
]) {
  check(shell.includes(present), `main header renders ${present}`);
}

const sysStart = shell.indexOf('data-ui="SysInfoBlock"');
const sysEnd = shell.indexOf("\n    </div>\n  );", sysStart);
check(sysStart !== -1 && sysEnd !== -1, "the header status block is a complete element");
const sysInfo = shell.slice(sysStart, sysEnd);

check(sysInfo.includes("onClick={onOpenServer}"),
  "clicking the status block opens Server Control");
check(shell.includes("<SysInfoBlock onOpenServer={onOpenServer} />")
  && shell.includes("onOpenServer={() => setServerModalOpen(true)}"),
  "the block is mounted in the header and wired to the Server modal");
check(shell.includes('gridTemplateColumns: "auto 1fr auto auto"'),
  "the header grid keeps a dedicated column for the status block");

// Sized for the 88px header (the pre-removal block was 420px wide / 60px tall
// in a 100px header). Guarding the numbers keeps a later "compaction" pass
// from quietly deleting it again.
check(sysInfo.includes('width: "min(340px, 26vw)"') && sysInfo.includes("height: 44"),
  "the block is fitted to the 88px header rather than the old 420x60 footprint");

check(shell.includes('invoke<ServerStatusLite>("server_status")')
  && shell.includes('invoke<VramStatusLite>("vram_status")')
  && shell.includes("window.setInterval(tick, 2000)"),
  "server and VRAM values are polled live from the same commands ServerPage uses");
check(shell.includes("let dead = false") && shell.includes("window.clearInterval(id)"),
  "the poller is torn down on unmount");

// The API-key line the user actually asked to remove (9fa94d67) stays gone.
check(!shell.includes('data-ui="HeaderApiKeyLabel"') && !shell.includes("API key: owllm-local"),
  "the hardcoded API-key line remains absent");

check(shell.includes('const RIGHT_ALIGNED_KEYS = new Set(["info", "server"'),
  "Server remains available in normal navigation");
check(shell.includes('if (key === "server") { setServerModalOpen(true); return; }'),
  "normal Server navigation still opens the Server modal");
check(shell.includes("{serverModalOpen && (") && shell.includes('dataUi="ServerModal"'),
  "the Server modal itself remains mounted and functional");

check(shell.includes("function useLocalServerKeySync()")
  && shell.includes('invoke<{ enabled: boolean; apiKey: string }>("inference_expose_get")')
  && shell.includes("useLocalServerKeySync();"),
  "startup local-inference key sync stays independent of rendering the header block");

console.log(`OK header server control: ${passed}/${passed} checks passed`);
