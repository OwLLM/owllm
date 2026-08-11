// World Chat peer identity — one machine, one name.
//
// The map and the country list name a public node by `presenceServerCode(id)`
// ("Server OW-0UVYMD5"). The chat used to name the very same node by slicing
// the raw id ("OW-523DF1"), so a user who clicked the Singapore dot and talked
// to it found a history full of codes that matched nothing on the globe — and
// concluded their conversations had been crossed with other machines. They had
// not been: the thread was Singapore all along, wearing a second name.
//
// Pinned here:
//   * the chat's fallback label IS the map's server code — executed, not
//     pattern-matched, including the real repro vector from that report;
//   * a chosen nickname still wins over the code;
//   * the panel decorates a bare code with the place the map knows the node
//     by ("🇸🇬 · Punggol · OW-0UVYMD5"), in the inbox, the thread title and
//     the request rows, and the map feeds it that knowledge.
//
// Reports EVERY failure rather than throwing on the first.

import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1)));
const UI = path.resolve(HERE, "../../..");

const failures = [];
let checks = 0;

function check(label, condition, detail = "") {
  checks += 1;
  if (!condition) failures.push(detail ? `${label} — ${detail}` : label);
}

function read(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch { return ""; }
}

// --- executed: the fallback label is the map's own server code --------------

let esbuild = null;
try { esbuild = await import("esbuild"); }
catch (reason) { check("esbuild is available to run the modules", false, String(reason).slice(0, 120)); }

if (esbuild) {
  try {
    const load = async (entry) => {
      const built = await esbuild.build({
        entryPoints: [path.join(UI, entry)],
        bundle: true, write: false, format: "esm", platform: "neutral",
      });
      return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
    };
    const chat = await load("src/pages/gamify/worldChat.ts");
    const presence = await load("src/pages/gamify/worldPresence.ts");

    // The id from the actual report: the Singapore node whose dot said
    // "Server OW-0UVYMD5" while its chat thread said "OW-523DF1".
    const singapore = "523df119a4eddeb413d7b99041a7843e6bdcea40aa9c3a638b5c68020f9d5c0e";
    check("the map's code for the repro node is stable",
      presence.presenceServerCode(singapore) === "OW-0UVYMD5",
      `got ${presence.presenceServerCode(singapore)}`);
    check("the chat labels the repro node with the MAP's code, not an id slice",
      chat.worldChatLabel(undefined, singapore) === "OW-0UVYMD5",
      `got ${chat.worldChatLabel(undefined, singapore)}`);

    // Any id, same law — the two surfaces may never disagree again.
    for (const id of ["c26469df398602927a7b01d9d8c16367745a14d81ce66efbd603453275f43616", "abc123", "00ff00ff00ff"]) {
      check(`chat and map agree on ${id.slice(0, 8)}`,
        chat.worldChatLabel(undefined, id) === presence.presenceServerCode(id),
        `${chat.worldChatLabel(undefined, id)} vs ${presence.presenceServerCode(id)}`);
    }

    check("a nickname still wins over the code",
      chat.worldChatLabel({ nick: "Kash" }, singapore) === "Kash");
    check("an empty id stays an empty label",
      chat.worldChatLabel(undefined, "") === "");
    check("the avatar initial survives the OW- prefix of a server code",
      chat.chatAvatarInitial(presence.presenceServerCode(singapore)) === "0");
  } catch (reason) {
    check("worldChat/worldPresence execute", false, String(reason).slice(0, 200));
  }
}

// --- pinned: the panel shows the place the map knows the node by ------------

const panel = read(path.join(UI, "src/pages/gamify/WorldChatPanel.tsx"));
check("WorldChatPanel exists", panel.length > 0);
check("the panel receives the map's places",
  /nodePlaces\?: Map<string, string>/.test(panel));
check("a bare code is decorated with its place",
  /const placed = \(id: string, label: string\)/.test(panel)
  && /nodePlaces\?\.get\(id\)/.test(panel));
check("the place only decorates a code, never a nickname",
  /label === presenceServerCode\(id\)/.test(panel));
check("the inbox rows are placed",
  /\{placed\(entry\.peerId, entry\.label\)/.test(panel));
check("the thread title is placed",
  /placed\(target, worldChatLabel\(chat\.peers\[target\], target\)\)/.test(panel));
check("the request rows are placed",
  /placed\(id, worldChatLabel\(chat\.peers\[id\], id\)\)/.test(panel));

const page = read(path.join(UI, "src/pages/gamify/WorldMapPage.tsx"));
check("WorldMapPage exists", page.length > 0);
check("the map builds the places from the live public nodes",
  /const nodePlaces = useMemo\(/.test(page) && /regionWithFlag\(node\.region\)/.test(page));
check("the map hands the places to the chat",
  /nodePlaces=\{nodePlaces\}/.test(page));

// --- verdict ----------------------------------------------------------------

if (failures.length) {
  console.error(`worldChatPeerCode: ${failures.length}/${checks} checks FAILED`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`worldChatPeerCode: ${checks} checks passed`);
