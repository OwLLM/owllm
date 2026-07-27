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
// The dropdown is the JSX inside `{settingsOpen && ( ... )}`. It closes when the
// HeaderSettingsPopup </div> is followed by the conditional `)}`. Mode toggles
// (visibleToggles.map) live later in the same left cluster and must NOT be
// included, because the global Marketplace button sits between the dropdown and
// the toggles.
const popupCloseMatch = src.slice(popupStart).match(/<\/div>\s*\n\s*\)\}/);
check(popupCloseMatch, "the Settings dropdown has a detectable conditional close");
const popupEnd = popupStart + (popupCloseMatch.index ?? 0) + popupCloseMatch[0].length;
const popup = src.slice(popupStart, popupEnd);

// --- Marketplace entry: now a global header button, NOT inside the dropdown ---
// It is intentionally moved to the top-level header cluster (next to Settings / mode
// toggles) and is validated by openWebUrl.verify.run.mjs. This dropdown must NOT
// contain a duplicate Marketplace entry.
const marketIdx = popup.indexOf('data-ui="MarketplaceButton"');
check(marketIdx === -1, "MarketplaceButton is no longer inside the Settings dropdown");

// --- Label text ---
const signingIdx = popup.indexOf('data-ui="SettingsSigningRow"');
check(signingIdx !== -1, "the dropdown contains the Signing/credential entry (SettingsSigningRow)");
check(popup.includes(">Certificates and Logs in<"),
  'the Signing entry label reads exactly "Certificates and Logs in"');

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

// --- Ordering: Signing and Onboarding lead, GitHub container stays last ---
const onboardingIdx = popup.indexOf('data-ui="SettingsOnboardingRow"');
const accountIdx = popup.indexOf('data-ui="SettingsAccountRow"');
check(onboardingIdx !== -1, "the dropdown contains the onboarding entry (SettingsOnboardingRow)");
check(accountIdx !== -1, "the GitHub container (SettingsAccountRow) exists in the dropdown");
check(signingIdx < onboardingIdx,
  "the Signing entry is positioned before the Onboarding entry");
check(onboardingIdx < accountIdx,
  "the Onboarding entry is positioned before the GitHub container");
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
