// Focused verification for the "Keep frame" control: persisted
// toggle/restore behavior via the pure framePreferences module, plus
// source-level checks that the Settings checkbox renders INSIDE the
// MiniFrameReplica and that the miniature shares the real frame's
// geometry function. Transpiles the real module; no browser required.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "../..");
const require = createRequire(path.join(DESKTOP, "package.json"));
const ts = require("typescript");
const source = fs.readFileSync(path.join(HERE, "framePreferences.ts"), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-frame-"));
const modulePath = path.join(temp, "framePreferences.cjs");
fs.writeFileSync(modulePath, output);
const frame = require(modulePath);

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`✓ ${message}`);
}

function makeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    dump: () => Object.fromEntries(values),
  };
}

// --- persisted toggle + restore behavior -----------------------------
const empty = makeStorage();
check(frame.readKeepFrameVisible(empty) === false, "missing preference defaults to a fading frame");

const store = makeStorage();
frame.saveKeepFrameVisible(true, store);
check(store.dump()[frame.KEEP_FRAME_VISIBLE_KEY] === "1", "checking the box persists \"1\" under the keep-visible key");
check(frame.readKeepFrameVisible(store) === true, "a fresh startup read restores the checked state");

frame.saveKeepFrameVisible(false, store);
check(store.dump()[frame.KEEP_FRAME_VISIBLE_KEY] === "0", "unchecking the box persists \"0\"");
check(frame.readKeepFrameVisible(store) === false, "a fresh startup read restores the unchecked state");

const garbage = makeStorage({ [frame.KEEP_FRAME_VISIBLE_KEY]: "definitely" });
check(frame.readKeepFrameVisible(garbage) === false, "corrupt persisted values fail safely to the default");

const broken = {
  getItem: () => { throw new Error("blocked"); },
  setItem: () => { throw new Error("blocked"); },
};
frame.saveKeepFrameVisible(true, broken); // must not throw
check(frame.readKeepFrameVisible(broken) === false, "blocked storage reads and writes fail safely");

// --- Settings control: checkbox lives inside the mini frame replica ---
const shell = fs.readFileSync(path.join(HERE, "AppShell.tsx"), "utf8");
check(shell.includes("import { readKeepFrameVisible, saveKeepFrameVisible } from \"./framePreferences\"")
  && !shell.includes('"owllm:window-frame:keep-visible"'),
  "AppShell persists through the shared framePreferences module, not an inline key");
check(shell.includes("useState<boolean>(() => readKeepFrameVisible())"),
  "keep-frame state is restored from storage at startup");
check(shell.includes("saveKeepFrameVisible(keepFrameVisible)"),
  "every toggle writes the persisted preference");

const geometryCalls = shell.split("computeFrameGeometry(").length - 1;
check(shell.includes("function computeFrameGeometry(") && geometryCalls >= 3,
  "HybridFrame and MiniFrameReplica share one frame-geometry function");

const labelAt = shell.indexOf('data-ui="KeepFrameVisible"');
const replicaOpenAt = shell.indexOf("<MiniFrameReplica", labelAt);
const checkboxAt = shell.indexOf("checked={keepFrameVisible}", replicaOpenAt);
const replicaCloseAt = shell.indexOf("</MiniFrameReplica>", replicaOpenAt);
check(labelAt !== -1 && replicaOpenAt !== -1 && checkboxAt !== -1 && replicaCloseAt !== -1
  && labelAt < replicaOpenAt && replicaOpenAt < checkboxAt && checkboxAt < replicaCloseAt,
  "the keep-visible checkbox renders inside the mini frame graphic");
check(shell.slice(replicaOpenAt, checkboxAt).includes("active={keepFrameVisible}"),
  "the mini frame chrome mirrors the checkbox state");
check(shell.includes("onKeepFrameVisible(event.target.checked)"),
  "the checkbox drives the existing keep-frame-visible state");

const replicaDef = shell.slice(shell.indexOf("function MiniFrameReplica"), shell.indexOf("function ModeBar"));
check(replicaDef.includes("computeFrameGeometry(MINI_FRAME_REF_W, MINI_FRAME_REF_H)")
  && replicaDef.includes("viewBox={`0 0 ${MINI_FRAME_REF_W} ${MINI_FRAME_REF_H}`}"),
  "the miniature scales the real frame geometry through an SVG viewBox");
check(replicaDef.includes("corner_ul.png") && replicaDef.includes("corner_br.png")
  && replicaDef.includes("owl_studio_square.png")
  && replicaDef.includes("FRAME_BG") && replicaDef.includes("FRAME_COLOR") && replicaDef.includes("FRAME_ACCENT"),
  "the miniature reuses the real frame's corner art, owl badge, and accent styling");

fs.rmSync(temp, { recursive: true, force: true });
console.log(`OK keep-frame control: ${passed}/${passed} checks passed`);
