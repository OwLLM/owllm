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
// included.
const popupCloseMatch = src.slice(popupStart).match(/<\/div>\s*\n\s*\)\}/);
check(popupCloseMatch, "the Settings dropdown has a detectable conditional close");
const popupEnd = popupStart + (popupCloseMatch.index ?? 0) + popupCloseMatch[0].length;
const popup = src.slice(popupStart, popupEnd);

// --- Marketplace entry: Settings only, never permanent header chrome ---
const marketIdx = popup.indexOf('data-ui="MarketplaceButton"');
check(marketIdx !== -1, "MarketplaceButton is inside the Settings dropdown");
check(/MarketplaceButton[\s\S]*?onOpenMarketplace\(\)/.test(popup),
  "the Settings Marketplace button opens Marketplace");
check((src.match(/data-ui="MarketplaceButton"/g) ?? []).length === 1,
  "Marketplace has one entry and is not duplicated in the header");

// --- Dedicated resource/integration navigation row ---
const navigationIdx = popup.indexOf('data-ui="SettingsNavigationRow"');
check(navigationIdx !== -1, "the dropdown contains the dedicated resource navigation row");
for (const [key, label] of [
  ["assets", "Assets"],
  ["bridges", "Bridges"],
  ["mcp", "MCP"],
  ["accounts", "Accounts"],
]) {
  check(popup.includes(`{ key: "${key}"`) && popup.includes(`label: "${label}"`),
    `${label} is exposed from the dedicated Settings row`);
}
const navigationBlock = popup.slice(navigationIdx, popup.indexOf("</div>", navigationIdx));
check(navigationBlock.includes('gridTemplateColumns: "repeat(4, minmax(0, 1fr))"'),
  "Assets, Bridges, MCP, and Accounts share one four-column row");
check(navigationBlock.includes("onOpenSettingsPage(item.key)"),
  "the dedicated row routes each destination through shell navigation");

const subTabsAt = src.indexOf("function SubTabs(");
const subTabsEnd = src.indexOf("// PageModal", subTabsAt);
const subTabs = src.slice(subTabsAt, subTabsEnd);
check(subTabs.includes("SETTINGS_NAV_KEYS") && subTabs.includes("pages.filter"),
  "Settings destinations are filtered out of the workspace tab strip");

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

// --- Ordering: destination rows lead, GitHub container stays last ---
const onboardingIdx = popup.indexOf('data-ui="SettingsOnboardingRow"');
const accountIdx = popup.indexOf('data-ui="SettingsAccountRow"');
check(onboardingIdx !== -1, "the dropdown contains the onboarding entry (SettingsOnboardingRow)");
check(accountIdx !== -1, "the GitHub container (SettingsAccountRow) exists in the dropdown");
check(marketIdx < navigationIdx && navigationIdx < signingIdx,
  "Marketplace and the dedicated navigation row precede Signing");
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

// --- Every Settings destination opens as a POPUP, never a tab switch ---
// Switching the workspace tab would disrupt whatever the user was doing, so
// Assets / Bridges / MCP / Accounts all render through PageModal.
check(/const \[settingsModalKey, setSettingsModalKey\] = useState<string \| null>\(null\)/.test(src),
  "one settingsModalKey drives every Settings destination popup");
check(/settingsModalPage && \([\s\S]{0,400}?dataUi="SettingsPageModal"[\s\S]{0,300}?<settingsModalPage\.component \/>/.test(src),
  "the Settings destination renders inside a PageModal popup");
check(/ALL_MODULES\.flatMap\(m => m\.pages\)\.find\(p => p\.key === settingsModalKey\)/.test(src),
  "the popup page is resolved from the module registry, not a duplicate import");
// Both navigation entry points (the dropdown's owllm:navigate event and a
// direct tab click) must land on the popup, not on setActiveKey.
check((src.match(/if \(SETTINGS_NAV_KEYS\.has\(key\)\) \{ setSettingsModalKey\(key\); return; \}/g) ?? []).length === 2,
  "both the navigate event and the tab handler open the popup instead of switching tabs");
check(!/<BridgesPage \/>/.test(src) && !/import BridgesPage/.test(src),
  "Bridges no longer needs its own import/render — it goes through the shared popup");

// --- The dropdown survives opening AND closing a popup ---
check(!/setSettingsOpen\(false\); onOpenSettingsPage/.test(src)
  && !/setSettingsOpen\(false\); onOpenSigning/.test(src),
  "opening a Settings popup does not dismiss the dropdown");
check(/data-owllm-overlay="1"/.test(src),
  "PageModal marks itself as an overlay");
const dismissAt = src.indexOf("const onPointerDown = (event: PointerEvent)");
check(dismissAt !== -1, "the dropdown has an outside-click dismiss handler");
const dismissBlock = src.slice(dismissAt, dismissAt + 900);
check(/closest\?\.\("\[data-owllm-overlay\]"\)/.test(dismissBlock),
  "clicking inside an open popup does not dismiss the dropdown behind it");
check(/document\.querySelector\("\[data-owllm-overlay\]"\)/.test(dismissBlock),
  "Esc closes the topmost popup rather than the dropdown");
check(/if \(!settingsRef\.current\?\.contains\(target as Node\)\) setSettingsOpen\(false\)/.test(dismissBlock),
  "a click outside the dropdown still closes it");

// --- Chrome: same surface as the second header, static rainbow ring ---
const popupStyleAt = popup.indexOf("maxHeight:");
const popupStyle = popup.slice(popupStyleAt, popup.indexOf("</div>", popupStyleAt));
check(popupStyle.includes("linear-gradient(var(--bg-card), var(--bg-card)) padding-box"),
  "the dropdown surface matches the second header (--bg-card)");
check(popupStyle.includes("${HEADER_AURA_GRADIENT} border-box")
  && popupStyle.includes('border: "2px solid transparent"'),
  "the dropdown wears the multicolour frame as a border-box ring");
check(!/animation/.test(popupStyle),
  "the dropdown frame is static — never spinning or glowing");

console.log(`OK settings-dropdown-nav audit: ${passed} checks passed`);
