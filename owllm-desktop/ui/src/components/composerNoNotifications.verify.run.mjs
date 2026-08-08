// Verify harness: notifications NEVER render inside a chat composer.
//
// The composer container is the input box. Page notices used to be passed to
// <Composer status=…> / <Composer notice=…>, which rendered multi-line prose in
// the container header — it wrapped to several lines, grew the box and shoved
// the model picker sideways (reported repeatedly by the user). The fix is
// structural: Composer has no notification slot at all, and every notice goes
// to the shared toast surface (components/Toast.tsx) mounted at the app root.
//
// Run: node ui/src/components/composerNoNotifications.verify.run.mjs
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
// CRLF-normalize reads: Windows checkouts materialize LF-committed sources as
// CRLF, and multi-line needles with \n must still match (recurring lesson).
// A missing file is a FAILURE with a readable label, not a stack trace: when
// the toast surface is deleted this gate must still say which check broke.
const readLF = (p) => {
  try { return fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n"); }
  catch { return ""; }
};

const composer = readLF(path.join(root, "ui", "src", "components", "Composer.tsx"));
const toast = readLF(path.join(root, "ui", "src", "components", "Toast.tsx"));
const mainTsx = readLF(path.join(root, "ui", "src", "main.tsx"));
const styles = readLF(path.join(root, "ui", "src", "styles.css"));
const codePage = readLF(path.join(root, "ui", "src", "pages", "agentic", "CodePage.tsx"));
const agentsPage = readLF(path.join(root, "ui", "src", "pages", "agentic", "AgentsPage.tsx"));
const chatPage = readLF(path.join(root, "ui", "src", "pages", "finetuning", "ChatPage.tsx"));

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`  PASS ${label}`);
  else { failures++; console.log(`  FAIL ${label}`); }
}

console.log("composerNoNotifications.verify — notices live in toasts, not in the composer");

// --- 1. Composer has no notification slot --------------------------------
check(!/^\s*status\?:/m.test(composer),
  "Composer has no `status` prop");
check(!/^\s*notice\?:/m.test(composer),
  "Composer has no `notice` prop");
check(!composer.includes("owc__status") && !composer.includes("owc__notice"),
  "Composer renders no status/notice element");
check(!styles.includes(".owc__status") && !styles.includes(".owc__notice"),
  "the composer status/notice styles are gone with them");
check(composer.includes("composerNoNotifications.verify.run.mjs"),
  "Composer documents WHY the slot is absent, pointing at this gate");

// --- 2. No caller anywhere can smuggle one back in -----------------------
// Every <Composer …/> element in the tree is inspected, not a hand-listed pair
// of pages: a new surface added next year is covered the day it is written.
function tsxFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsxFiles(p));
    else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}
const srcDir = path.join(root, "ui", "src");
const offenders = [];
let composerSites = 0;
for (const file of fs.existsSync(srcDir) ? tsxFiles(srcDir) : []) {
  for (const el of readLF(file).match(/<Composer\b[\s\S]*?\n\s*\/>/g) ?? []) {
    composerSites++;
    if (/\bstatus=/.test(el) || /\bnotice=/.test(el)) offenders.push(path.relative(root, file));
  }
}
check(composerSites > 0, "the tree still renders <Composer/> (gate is looking at something real)");
check(offenders.length === 0,
  `no <Composer/> anywhere passes status/notice${offenders.length ? ` — offenders: ${[...new Set(offenders)].join(", ")}` : ""}`);

// --- 3. The replacement surface exists and is mounted --------------------
check(/export function notify\(/.test(toast) && /export function ToastHost\(/.test(toast),
  "Toast.tsx exports notify() and ToastHost");
check(toast.includes('if (!body) return;'),
  "notify() ignores blank text (pages clear a notice by passing \"\")");
check(/DISMISS_MS/.test(toast) && /dismissToast/.test(toast),
  "toasts auto-dismiss and can be dismissed by clicking");
check(mainTsx.includes("<ToastHost />") && mainTsx.includes('from "./components/Toast"'),
  "ToastHost is mounted once at the app root");
check(styles.includes(".owl-toasts") && styles.includes("position: fixed"),
  "the toast stack floats over the UI instead of occupying layout");

// --- 4. The pages actually route their notices there ---------------------
check(codePage.includes('import { notify } from "../../components/Toast"'),
  "CodePage sends its page notices to the toast surface");
check(!/\bsetStatus\b/.test(codePage),
  "CodePage has no setStatus writing into the composer header");
check(!/^\s*status: string;/m.test(codePage),
  "CodePage no longer persists a page notice in its saved state");
check(codePage.includes("On branch ${outcome.branch}") &&
      /notify\(`On branch \$\{outcome\.branch\}/.test(codePage),
  "the worktree-ready message (the one reported) is a toast, not composer text");
check(agentsPage.includes('import { notify } from "../../components/Toast"') &&
      /const flashNote = \(msg: string\) => notify\(msg\);/.test(agentsPage),
  "AgentsPage dock notices (mic/attachment failures) are toasts");
check(chatPage.includes('import { notify } from "../../components/Toast"') &&
      !/attachmentError/.test(chatPage),
  "the fine-tuning chat's attachment errors are toasts too");

console.log(failures === 0
  ? `\ncomposerNoNotifications.verify: OK`
  : `\ncomposerNoNotifications.verify: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
