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
// just before the header mode toggles (visibleToggles.map). Scope to that region.
const popupEnd = src.indexOf('visibleToggles.map', popupStart);
check(popupEnd > popupStart, "the Settings dropdown region is bounded before the header mode toggles");
const popup = src.slice(popupStart, popupEnd);

// --- Marketplace entry: moved into the dropdown, before the Certificates row ---
const marketIdx = popup.indexOf('data-ui="MarketplaceButton"');
check(marketIdx !== -1, "the dropdown contains the Marketplace entry (MarketplaceButton)");
check(/MarketplaceButton[\s\S]*?onOpenMarketplace\(\)/.test(popup),
  "the Marketplace entry opens the marketplace (onOpenMarketplace)");

// --- Label text ---
const signingIdx = popup.indexOf('data-ui="SettingsSigningRow"');
check(signingIdx !== -1, "the dropdown contains the Signing/credential entry (SettingsSigningRow)");
check(popup.includes(">Certificates and Logs in<"),
  'the Signing entry label reads exactly "Certificates and Logs in"');
check(marketIdx < signingIdx,
  "the Marketplace entry is positioned before the Certificates and Logs in entry");

// The entry opens the Signing hub as a centered popup (PageModal) — it is no
// longer a header tab, so this dropdown row is its only entry point.
check(/SettingsSigningRow[\s\S]*?onOpenSigning\(\)/.test(popup),
  "the Signing entry opens the Signing popup (onOpenSigning)");
// The onOpenSigning prop is wired to open the SigningModal at the render site.
check(/onOpenSigning=\{\(\) => setSigningModalOpen\(true\)\}/.test(src),
  "onOpenSigning is wired to open the Signing popup");

// The Signing popup is actually rendered (PageModal → SigningModal → SigningPage).
check(/signingModalOpen && \([\s\S]*?dataUi="SigningModal"[\s\S]*?<SigningPage \/>/.test(src),
  "the Signing popup (SigningModal) renders the SigningPage component");

// Signing is no longer a header SubTab — it must not appear in any module's
// page list (removed from ADVANCED.pages so it never renders in SubTabs).
const modules = fs.readFileSync(path.join(HERE, "core", "modules.ts"), "utf8");
check(!/key:\s*"signing"/.test(modules),
  "the Signing page is removed from the header tabs (not in modules.ts pages)");

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
