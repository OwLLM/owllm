// Regression check for the oversized clickable server/VRAM block that occupied
// up to 420px on the right of the main header. The Server modal must remain
// reachable from normal navigation, and startup must still mirror the local
// inference key even though the header status polling is gone.
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

for (const removed of [
  'data-ui="SysInfoBlock"',
  'data-ui="HeaderServersLabel"',
  'data-ui="HeaderVramLabel"',
  'title={server.running',
]) {
  check(!shell.includes(removed), `main header no longer contains ${removed}`);
}
check(!shell.includes('width: "min(420px, 31vw)"'),
  "the oversized 420px server-control hit target is gone");
check(shell.includes('gridTemplateColumns: "auto 1fr auto"'),
  "the header grid now contains only the left controls, spacer, and window controls");

check(shell.includes('const RIGHT_ALIGNED_KEYS = new Set(["info", "server"'),
  "Server remains available in normal navigation");
check(shell.includes('if (key === "server") { setServerModalOpen(true); return; }'),
  "normal Server navigation still opens the Server modal");
check(shell.includes("{serverModalOpen && (") && shell.includes('dataUi="ServerModal"'),
  "the Server modal itself remains mounted and functional");

check(shell.includes("function useLocalServerKeySync()")
  && shell.includes('invoke<{ enabled: boolean; apiKey: string }>("inference_expose_get")')
  && shell.includes("useLocalServerKeySync();"),
  "startup local-inference key sync no longer depends on rendering the removed header control");

console.log(`OK header server control removal: ${passed}/${passed} checks passed`);
