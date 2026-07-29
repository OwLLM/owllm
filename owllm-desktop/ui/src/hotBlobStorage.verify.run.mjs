// Guard: large, hot-path payloads must never go through localStorage.
//
// THE MECHANISM (measured, not assumed). Blink replicates every localStorage
// mutation into EVERY renderer process hosting that origin — including
// documents that never call localStorage and register no `storage` listener.
// Controlled experiment: three same-origin pages in separate renderers, one
// writing a 1.4 MB value 8x/s for ~2 minutes.
//
//     writer  (does the writing)          55 MB
//     passive (never touches storage)    944 MB
//     blocked (never touches storage)    903 MB
//
// The writer stays small; the OTHER renderers pay. A passive window such as
// the overlay frame runs no tasks, so it never drains them — it grew to 4 GB
// in one session, ~85% of the app's footprint, and caused system-wide paging
// stalls (Office freezing for minutes on this machine).
//
// A previous fix removed localStorage from the overlay page itself. That could
// not work, and this guard exists so that dead end is not retried: the cure is
// that the multi-megabyte payload never enters localStorage in the first
// place. Code page sessions therefore live in SQLite via the hot-blob store.
//
// Source-level checks; no browser required.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_SRC = HERE;

const read = (...p) => fs.readFileSync(path.join(...p), "utf8");

// Comments explain the rule, so a naive scan would match the explanation.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`✓ ${message}`);
}

// --- the store exists and is wired to SQLite -------------------------------
const mirror = read(UI_SRC, "runtime", "stateMirror.ts");
const mirrorCode = stripComments(mirror);

check(/export const HOT_BLOB_PREFIXES/.test(mirrorCode),
  "stateMirror declares HOT_BLOB_PREFIXES (the keys banned from localStorage)");

// Parse the real list out of the source. Every downstream check below is
// derived from it, so adding a prefix automatically extends the ban — the
// first version hardcoded the Code keys here and that is precisely how the
// fine-tuning chat kept writing ~1 MB transcripts to localStorage unnoticed.
const HOT_PREFIXES = [
  ...(mirrorCode.split("export const HOT_BLOB_PREFIXES")[1] ?? "")
    .split("]")[0].matchAll(/"([^"]+)"/g),
].map((m) => m[1]);
check(HOT_PREFIXES.length >= 4,
  `HOT_BLOB_PREFIXES parsed from source (${HOT_PREFIXES.length}): ${HOT_PREFIXES.join(", ")}`);
for (const prefix of ["owllm:code:page:", "owllm:code:session:", "owllm:code:chats", "owllm:chat:v3"]) {
  check(HOT_PREFIXES.includes(prefix),
    `${prefix} is a hot-blob prefix (~1 MB, rewritten on the shared 250ms debounce)`);
}
for (const fn of ["readHotBlob", "writeHotBlob", "deleteHotBlob", "flushHotBlobs"]) {
  check(new RegExp(`export (async )?function ${fn}`).test(mirrorCode),
    `stateMirror exports ${fn}`);
}
check(/state_mirror_save/.test(
  mirrorCode.split("export async function flushHotBlobs")[1] ?? ""),
  "flushHotBlobs persists to SQLite through state_mirror_save");

// The write path must never fall back to localStorage: that is the whole bug.
const writeBody = mirrorCode.split("export function writeHotBlob")[1]?.split("\n}")[0] ?? "";
check(writeBody.length > 0 && !/localStorage/.test(writeBody),
  "writeHotBlob never writes to localStorage");

// The sweep must skip hot keys. Otherwise 'mirrored but absent from
// localStorage' reads as a user deletion and silently drops the history row.
const snapshot = mirrorCode.split("function readDurableSnapshot")[1]?.split("\n}")[0] ?? "";
check(/isHotBlobKey/.test(snapshot),
  "readDurableSnapshot skips hot-blob keys (else the sweep would delete them as 'user deleted')");

// Boot must hydrate the cache before React renders, or reads return null and
// the user sees an empty history - the exact 'my history disappeared' class.
const restore = mirrorCode.split("export async function restoreStateMirror")[1] ?? "";
check(/isHotBlobKey/.test(restore) && /hotBlobs\.set/.test(restore),
  "restoreStateMirror hydrates the hot-blob cache from SQLite");
check(/hotLegacy\.add/.test(restore),
  "restoreStateMirror adopts pre-upgrade localStorage copies for migration");
// Deleting the localStorage copy before the DB has it would destroy history if
// the backend were down at boot — the 'my history disappeared' failure mode.
const flush = mirrorCode.split("export async function flushHotBlobs")[1] ?? "";
check(/state_mirror_save[\s\S]*hotLegacy[\s\S]*localStorage\.removeItem/.test(flush),
  "a pre-upgrade localStorage copy is dropped only AFTER the DB acknowledges the value");

const main = stripComments(read(UI_SRC, "main.tsx"));
check(/await restoreStateMirror\(\)/.test(main) &&
      main.indexOf("await restoreStateMirror()") < main.indexOf("createRoot"),
  "main.tsx awaits restoreStateMirror() before the first render (keeps reads synchronous)");

// --- no hot key may be written to localStorage anywhere --------------------
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

// Key-builder helpers whose return value is a hot key by construction.
const HOT_KEY_EXPRS = [
  "pageSessionKey", "codeSessionKey",
  "PAGE_SESSION_PREFIX", "CODE_SESSION_PREFIX",
  "CHATS_KEY", "CHAT_ACTIVE_KEY",
];
const isHotLiteral = (s) => HOT_PREFIXES.some((p) => s.includes(p));

const offenders = [];
for (const file of walk(UI_SRC)) {
  if (file.endsWith("stateMirror.ts")) continue; // owns the migration
  const src = stripComments(fs.readFileSync(file, "utf8"));
  // A hot key is usually reached through a local alias (`const LS_KEY =
  // "owllm:chat:v3"`), so scanning for the literal at the call site alone
  // misses it. Resolve single-literal consts in this file first.
  const aliases = [...src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*"([^"]+)"/g)]
    .filter((m) => isHotLiteral(m[2]))
    .map((m) => m[1]);
  for (const m of src.matchAll(/localStorage\.(setItem|getItem|removeItem)\(\s*([^,)]+)/g)) {
    const arg = m[2].trim();
    const hit = HOT_KEY_EXPRS.some((k) => arg.includes(k)) ||
                aliases.some((a) => new RegExp(`\\b${a}\\b`).test(arg)) ||
                isHotLiteral(arg);
    if (hit) offenders.push(`${path.relative(UI_SRC, file)}: localStorage.${m[1]}(${arg})`);
  }
}
check(offenders.length === 0,
  `no source outside stateMirror routes a hot-blob key through localStorage${
    offenders.length ? `\n    ${offenders.join("\n    ")}` : ""}`);

// --- anti-recurrence: every transcript persister must be classified --------
// The bug class is "a chat page persists its transcript on the shared 250 ms
// chatRuntime debounce, through localStorage". Enumerating pages is what
// failed last time, so instead: any file registering a chatRuntime persister
// must be in this list, and each must persist to SQLite (hot blob for the
// localStorage-shaped pages, update_project for the agent pages). A NEW chat
// page trips this until someone states which path it uses.
const PERSISTER_PAGES = {
  "pages/agentic/AgentsPage.tsx": /invoke\(\s*"update_project"/,
  "pages/agentic/CodePage.tsx": /writeHotBlob\(/,
  "pages/finetuning/ChatPage.tsx": /writeHotBlob\(/,
};
const registrars = walk(UI_SRC)
  .filter((f) => /registerPersister\(/.test(stripComments(fs.readFileSync(f, "utf8"))))
  .map((f) => path.relative(UI_SRC, f).replace(/\\/g, "/"))
  .filter((f) => f !== "runtime/chatRuntime.ts"); // declares the API
check(registrars.every((f) => f in PERSISTER_PAGES),
  `every chatRuntime persister page is classified (found: ${registrars.join(", ")})`);
for (const [rel, pattern] of Object.entries(PERSISTER_PAGES)) {
  const src = stripComments(read(UI_SRC, ...rel.split("/")));
  check(pattern.test(src),
    `${rel} persists its transcript to SQLite (${pattern.source})`);
}

// --- the Code page actually uses the store ---------------------------------
const codePage = stripComments(read(UI_SRC, "pages", "agentic", "CodePage.tsx"));
check(/writeHotBlob\(pageSessionKey\(/.test(codePage),
  "CodePage persists the per-page session through the hot-blob store");
check(/writeHotBlob\(codeSessionKey\(/.test(codePage),
  "CodePage persists the per-project session through the hot-blob store");
check(/readHotBlob\(pageSessionKey\(/.test(codePage) &&
      /readHotBlob\(codeSessionKey\(/.test(codePage),
  "CodePage reads both session copies through the hot-blob store");
check(/deleteHotBlob\(pageSessionKey\(/.test(codePage),
  "CodePage deletes a page session through the hot-blob store");
check(/savedPageIdsForLocalProject\(hotBlobStorage/.test(codePage),
  "CodePage enumerates saved pages from the hot-blob store, not localStorage");

// Recovering the model choice must still see the blobs after the move.
const pageSettings = stripComments(read(UI_SRC, "state", "pageSettings.ts"));
check(/hotBlobKeys\(\)/.test(pageSettings) && /readHotBlob\(/.test(pageSettings),
  "pageSettings' codeModel migration scans the hot-blob store too");

// --- the fine-tuning chat actually uses the store --------------------------
// It streams tokens through the SAME chatRuntime 250 ms persister as the Code
// page, rewriting all three columns' transcripts each time. The first fix
// moved only the Code page and dismissed this one as "small today" — it is the
// same write pattern, so it gets the same treatment.
const ftChat = stripComments(read(UI_SRC, "pages", "finetuning", "ChatPage.tsx"));
check(/writeHotBlob\(LS_KEY/.test(ftChat),
  "fine-tuning ChatPage persists its transcript through the hot-blob store");
check(/readHotBlob\(LS_KEY/.test(ftChat),
  "fine-tuning ChatPage reads its transcript through the hot-blob store");
check(!/localStorage\.(setItem|getItem)\(\s*LS_KEY/.test(ftChat),
  "fine-tuning ChatPage never routes LS_KEY through localStorage");

// --- moving a key out of localStorage must not drop it from vault sync -----
// vaultSync's snapshot enumerates localStorage, so a hot blob is invisible to
// it. owllm:chat:v3 syncs across devices (it is not in the deny-list), and
// migrating it silently would have ended that — cross-PC history just stops.
const vault = stripComments(read(UI_SRC, "runtime", "vaultSync.ts"));
check(/hotBlobKeys\(\)/.test(vault) && /readHotBlob\(/.test(vault),
  "vaultSync's snapshot includes hot blobs (else migrating a key kills its cross-device sync)");
check(/isHotBlobKey\(k\)\s*\)?\s*writeHotBlob\(|isHotBlobKey\([\s\S]{0,40}writeHotBlob\(/.test(vault),
  "vaultSync adopts a hot blob through writeHotBlob, not localStorage");

// --- a future oversized key must announce itself ---------------------------
// Keys that are small today (notebooks, per-page settings) can grow.
// Enumerating them is not a defence; a runtime tripwire is.
check(/BROADCAST_HAZARD_BYTES/.test(mirrorCode) &&
      /warnOversizedLocalStorage\(live\)/.test(mirrorCode),
  "the sweep warns, by key name, about any oversized localStorage value left on the broadcast path");

console.log(`OK hot-blob storage: ${passed}/${passed} checks passed`);
