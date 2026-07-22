// Focused verification for relocating the GitHub account / login control from
// the Home page into the header Settings popup (⚙ → final row). Source-level
// structural assertions (no browser/React/Tauri runtime): the control must be
// PRESENT in Settings (wired to the existing GitHub auth/account state), ABSENT
// from the Home page, and its auth behavior (status load, live-change refresh,
// open-modal-to-sign-in/out) must be preserved. Lives in pages/agentic/ so the
// smoke matrix auto-discovers it; it reads the AppShell + HomePage sources by
// relative path.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Read source for content matching independent of the checkout's line endings
// (Windows core.autocrlf checks LF-committed files out as CRLF, so a needle
// containing \n would false-fail on a CRLF working tree).
const readSource = (rel) => fs.readFileSync(path.resolve(HERE, rel), "utf8").replace(/\r\n/g, "\n");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`✓ ${message}`);
}

const shell = readSource("../../AppShell.tsx");
const home = readSource("../core/HomePage.tsx");

// ── 1. PRESENT in Settings ────────────────────────────────────────────────
const rowAt = shell.indexOf('data-ui="SettingsAccountRow"');
check(rowAt !== -1, "the account row is present in AppShell (Settings popup)");

// It must live inside the Settings popup, as the FINAL row — after the last
// existing row (SettingsRow3, the chat-text-size row).
const popupAt = shell.indexOf('data-ui="HeaderSettingsPopup"');
const row3At = shell.indexOf('data-ui="SettingsRow3"');
check(popupAt !== -1 && rowAt > popupAt, "the account row is rendered inside the header Settings popup");
check(row3At !== -1 && rowAt > row3At, "the account row is the final row — after SettingsRow3 (chat text size)");

// ── 2. ABSENT from the Home page ──────────────────────────────────────────
check(!home.includes('data-ui="SyncAccountBar"'), "the SyncAccountBar is gone from the Home page");
check(!home.includes("openSyncOnboarding"), "the Home page no longer references openSyncOnboarding");
check(!home.includes("githubStatus"), "the Home page no longer imports/uses githubStatus");
check(!home.includes("GITHUB_CHANGED_EVENT"), "the Home page no longer subscribes to GITHUB_CHANGED_EVENT");
check(!home.includes("Why connect GitHub"), "the Home page's 'Why connect GitHub?' teaser is gone");

// ── 3. Preserved auth behavior (wired to the existing account state) ──────
// AppShell must now own the account state + live-refresh wiring the Home page
// used to have, and the row must open the real sign-in/out modal.
check(shell.includes('import AccountSyncModal, { openSyncOnboarding } from "./pages/core/AccountSyncModal"'),
  "AppShell imports openSyncOnboarding from the AccountSyncModal (the login/sign-out flow owner)");
check(shell.includes('import { githubStatus, GITHUB_CHANGED_EVENT } from "./pages/agentic/github"'),
  "AppShell imports the existing GitHub auth/account bindings");
check(shell.includes("githubStatus().then"), "AppShell loads the live GitHub account status");
check(shell.includes("window.addEventListener(GITHUB_CHANGED_EVENT, load)"),
  "AppShell refreshes on the in-window github-changed broadcast (connect/disconnect reflects immediately)");
check(shell.includes('window.addEventListener("focus", load)'),
  "AppShell refreshes on window focus (out-of-window browser device-flow completes)");

// The row's click opens the modal (which owns login + disconnect) and closes
// the popup so the modal isn't hidden behind it.
// Window spans the whole card button (the highlighted container with badge +
// CTA pill is larger than a bare row, so this is generously sized).
const rowSlice = shell.slice(rowAt, rowAt + 3600);
check(rowSlice.includes("openSyncOnboarding()"), "clicking the account row opens the sign-in/out modal");
check(rowSlice.includes("setSettingsOpen(false)"), "opening the modal first closes the Settings popup");

// Display of the logged-in account vs. the signed-out prompt is preserved.
check(rowSlice.includes("account.connected"), "the row branches on the connected account state");
check(rowSlice.includes("Synced as @") && rowSlice.includes("{account.login}"),
  "when connected, the row shows the logged-in GitHub login");
check(rowSlice.includes("Finish onboarding"), "when signed out, the row links back to the full onboarding journey");
check(rowSlice.includes("GitHub sign-in and AI subscription setup"),
  "the signed-out row explains that onboarding covers identity and AI access");

// ── 4. Highlighted container (user spec 2026-07-17: bigger fonts + pretty
//       container so the sign-in stands out) ──────────────────────────────
check(rowSlice.includes("borderRadius: 12") && rowSlice.includes("linear-gradient"),
  "the account row is a rounded, accent-tinted highlighted container");
check(rowSlice.includes("fontSize: 14.5"),
  "the account label uses a larger, prominent font");
check(rowSlice.includes('borderRadius: 999') && rowSlice.includes('"Manage →"') && rowSlice.includes('"Continue →"'),
  "the call-to-action renders as a pill button");

// The globally-mounted modal (the actual auth surface) is still rendered.
check(shell.includes("<AccountSyncModal />"), "the AccountSyncModal remains mounted so the auth flow still works");

console.log(`OK settings account row: ${passed}/${passed} checks passed`);
