// Focused regression for the compact main application header. This lives in
// pages/agentic so scripts/smoke-matrix.mjs discovers it before release.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../..");
const shell = fs.readFileSync(path.join(SRC, "AppShell.tsx"), "utf8").replace(/\r\n/g, "\n");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
}

const headerStart = shell.indexOf('data-ui="AppHeader"');
const headerEnd = shell.indexOf('<style>{`', headerStart);
const header = shell.slice(headerStart, headerEnd);
check(headerStart !== -1 && headerEnd !== -1, "main application header is present");
check(header.includes('height: 88, boxSizing: "border-box"'),
  "header height shrinks by the requested 12 pixels");
check(header.includes('padding: "7px 18px 1px 20px"'),
  "header padding is 3px smaller on top and 9px smaller on bottom");

const sysStart = shell.indexOf('data-ui="SysInfoBlock"');
const sysEnd = shell.indexOf("\n    </div>\n  );", sysStart);
const sysInfo = shell.slice(sysStart, sysEnd);
check(sysStart !== -1 && sysEnd !== -1, "right-side system status remains present");
check(!sysInfo.includes('data-ui="HeaderApiKeyLabel"') && !sysInfo.includes("API key: owllm-local"),
  "hardcoded API-key line is absent from the header");
check(sysInfo.includes('data-ui="HeaderServersLabel"') && sysInfo.includes('data-ui="HeaderVramLabel"'),
  "server and VRAM status remain visible");
check(sysInfo.includes('<GenSpeedBadge variant="header" />'),
  "live generation speed remains available without the API-key line");

console.log(`app header compact verification: ${passed}/${passed} passed`);
