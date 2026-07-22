// Settings dropdown navigation regression guard.
// The Settings dropdown (HeaderSettingsPopup) must expose the Signing/credential
// hub as a "Certificates and Logs in" entry on its own separate line, positioned
// immediately before the GitHub container (SettingsAccountRow), and the GitHub
// container must stay the LAST item of the dropdown across all sign-in states.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_SHELL = path.join(HERE, "AppShell.tsx");
const src = fs.readFileSync(APP_SHELL, "utf8");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`OK ${message}`);
}

// Isolate the Settings dropdown so ordering assertions are scoped to it.
const popupStart = src.indexOf('data-ui="HeaderSettingsPopup"');
check(popupStart !== -1, "the Settings dropdown (HeaderSettingsPopup) exists");
// The dropdown closes at the `)}` that ends its `settingsOpen && ( ... )` block,
// just before the Marketplace button in the header. Scope to that region.
const popupEnd = src.indexOf('data-ui="MarketplaceButton"', popupStart);
check(popupEnd > popupStart, "the Settings dropdown region is bounded before the Marketplace button");
const popup = src.slice(popupStart, popupEnd);

// --- Label text ---
const signingIdx = popup.indexOf('data-ui="SettingsSigningRow"');
check(signingIdx !== -1, "the dropdown contains the Signing/credential entry (SettingsSigningRow)");
check(popup.includes(">Certificates and Logs in<"),
  'the Signing entry label reads exactly "Certificates and Logs in"');

// The entry opens the existing Signing page via the shared navigate event —
// no bespoke route, no modules.ts rename.
check(/SettingsSigningRow[\s\S]*?owllm:navigate[\s\S]*?key:\s*"signing"/.test(popup),
  "the Signing entry navigates to the existing Signing page (key: signing)");

// --- Layout: its own separate line (full-width block row) ---
const signingBlock = popup.slice(signingIdx, popup.indexOf("</button>", signingIdx));
check(signingBlock.includes('width: "100%"') && signingBlock.includes("display: \"flex\""),
  "the Signing entry renders on its own separate full-width line");

// --- Ordering: immediately before the GitHub container, which stays last ---
const accountIdx = popup.indexOf('data-ui="SettingsAccountRow"');
check(accountIdx !== -1, "the GitHub container (SettingsAccountRow) exists in the dropdown");
check(signingIdx < accountIdx,
  "the Signing entry is positioned before the GitHub container");
// Nothing else sits between them (immediately-before): no other data-ui row.
const between = popup.slice(popup.indexOf("</button>", signingIdx) + "</button>".length, accountIdx);
check(!/data-ui="/.test(between),
  "the Signing entry is immediately before the GitHub container (no row in between)");
// The GitHub container is the last interactive row of the dropdown in EVERY
// state: no further data-ui row appears after it within the dropdown region.
const afterAccount = popup.slice(accountIdx + 'data-ui="SettingsAccountRow"'.length);
check(!/data-ui="Settings\w+Row"/.test(afterAccount),
  "the GitHub container remains the last item in the dropdown across all states");
// Its two state branches (connected / not connected) are still one trailing
// container, so 'last' holds regardless of sign-in state.
check(/SettingsAccountRow[\s\S]*account\.connected \?/.test(popup),
  "the GitHub container renders both connected and signed-out states");

console.log(`OK settings-dropdown-nav audit: ${passed} checks passed`);
