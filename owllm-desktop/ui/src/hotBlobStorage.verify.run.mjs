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
for (const prefix of ["owllm:code:page:", "owllm:code:session:", "owllm:code:chats"]) {
  check(new RegExp(`HOT_BLOB_PREFIXES[\\s\\S]*?"${prefix}"`).test(mirrorCode),
    `${prefix} is a hot-blob prefix (~1 MB, rewritten on a 250ms debounce)`);
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

const HOT_KEY_EXPRS = [
  "pageSessionKey", "codeSessionKey",
  "PAGE_SESSION_PREFIX", "CODE_SESSION_PREFIX",
  "CHATS_KEY", "CHAT_ACTIVE_KEY",
];
const offenders = [];
for (const file of walk(UI_SRC)) {
  if (file.endsWith("stateMirror.ts")) continue; // owns the migration
  const src = stripComments(fs.readFileSync(file, "utf8"));
  for (const m of src.matchAll(/localStorage\.(setItem|getItem|removeItem)\(\s*([^,)]+)/g)) {
    const arg = m[2];
    if (HOT_KEY_EXPRS.some((k) => arg.includes(k)) ||
        /owllm:code:(page|session):/.test(arg)) {
      offenders.push(`${path.relative(UI_SRC, file)}: localStorage.${m[1]}(${arg.trim()})`);
    }
  }
}
check(offenders.length === 0,
  `no source outside stateMirror touches a Code session blob via localStorage${
    offenders.length ? `\n    ${offenders.join("\n    ")}` : ""}`);

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

// --- a future oversized key must announce itself ---------------------------
// Keys that are small today (the vault-synced fine-tuning chat, notebooks) can
// grow. Enumerating them is not a defence; a runtime tripwire is.
check(/BROADCAST_HAZARD_BYTES/.test(mirrorCode) &&
      /warnOversizedLocalStorage\(live\)/.test(mirrorCode),
  "the sweep warns, by key name, about any oversized localStorage value left on the broadcast path");

console.log(`OK hot-blob storage: ${passed}/${passed} checks passed`);
