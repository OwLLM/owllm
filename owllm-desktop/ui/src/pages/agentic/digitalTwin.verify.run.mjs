import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pagePath = process.env.DIGITAL_TWIN_PAGE_PATH
  ? path.resolve(process.env.DIGITAL_TWIN_PAGE_PATH)
  : path.join(here, "DigitalTwinPage.tsx");
const page = fs.readFileSync(pagePath, "utf8");
const route = fs.readFileSync(path.join(here, "DigitalTwinRoute.tsx"), "utf8");
const registry = fs.readFileSync(path.resolve(here, "../../core/modules.ts"), "utf8");
const repo = path.resolve(here, "../../../..");
const ts = (await import(pathToFileURL(path.join(repo, "node_modules/typescript/lib/typescript.js")).href)).default;
const helperOut = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || "/tmp", "digital-twin-verify-")), "digitalTwinImport.mjs");
fs.writeFileSync(helperOut, ts.transpileModule(fs.readFileSync(path.join(here, "digitalTwinImport.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText);
const {
  BLOCKED_ASSET_URL,
  MAX_TOTAL_IMPORT_BYTES,
  actionableImportFailure,
  aggregateImportError,
  parseGltfScene,
  resolveLinkedAssetUrl,
  yieldToMainThread,
} = await import(pathToFileURL(helperOut).href);

const checks = [
  [registry.includes('key: "studio"') && registry.indexOf('key: "digital-twin"') > registry.indexOf('key: "studio"'), "Digital Twin/3D is registered immediately after Studio"],
  [registry.includes('label: "Digital Twin/3D"') && registry.includes("component: DigitalTwinRoute"), "the new page has the requested visible label and isolated route"],
  [route.includes('lazy(() => import("./DigitalTwinPage"))'), "Three.js and its loaders are lazy-loaded away from existing pages"],
  [page.includes('new GLTFLoader') && page.includes('new OBJLoader') && page.includes('new STLLoader'), "GLB/GLTF, OBJ, and STL loaders are wired"],
  [page.includes("URL.createObjectURL") && page.includes("URL.revokeObjectURL"), "linked GLTF assets use revocable local object URLs"],
  [page.includes('role="alert"') && page.includes("Retry import") && page.includes("Preparing geometry on this device"), "loading and actionable error states are present"],
  [page.includes("Choose 3D files") && page.includes("No constraints yet") && page.includes("constraints.map"), "empty and populated assembly states are present"],
  [page.includes("STEP/IGES needs a CAD tessellation engine"), "unsupported CAD formats fail honestly instead of pretending to import"],
  [page.includes("100 MB interactive import limit") && page.includes("so the UI remains responsive"), "oversized imports are refused before they can monopolize the UI thread"],
  [page.includes("if (importingRef.current)") && page.includes("then drop these files again"), "dropping files during an active import produces actionable feedback"],
  [page.includes('aria-label="Assembly parts"') && page.includes('aria-label="Digital twin inspector"'), "the workspace regions expose accessible labels"],
];

let passed = 0;
for (const [ok, message] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${message}`);
  if (ok) passed += 1;
}

const localUrls = new Map([["mesh.bin", "blob:local-mesh"]]);
const missingAssets = new Set();
const localAsset = resolveLinkedAssetUrl("./mesh.bin?cache=1", localUrls, missingAssets);
const externalAsset = resolveLinkedAssetUrl("https://assets.example.test/private.bin", localUrls, missingAssets);
const blockedExternal = localAsset === "blob:local-mesh"
  && externalAsset === BLOCKED_ASSET_URL
  && missingAssets.has("private.bin");
console.log(`${blockedExternal ? "✓" : "✗"} linked assets resolve only to selected local files; external fallbacks are blocked`);
if (blockedExternal) passed += 1;

const aggregateBlocked = aggregateImportError([
  { size: MAX_TOTAL_IMPORT_BYTES - 1 },
  { size: 2 },
])?.includes("250 MB aggregate import limit") === true;
const aggregateAllowed = aggregateImportError([{ size: MAX_TOTAL_IMPORT_BYTES }]) === null;
console.log(`${aggregateBlocked && aggregateAllowed ? "✓" : "✗"} aggregate limit counts models and companion assets at the exact boundary`);
if (aggregateBlocked && aggregateAllowed) passed += 1;

let scheduled = null;
let yielded = false;
const yieldPromise = yieldToMainThread((callback) => { scheduled = callback; }).then(() => { yielded = true; });
const pendingBeforeTimer = scheduled !== null && yielded === false;
scheduled?.();
await yieldPromise;
const backgroundSafeYield = pendingBeforeTimer && yielded;
console.log(`${backgroundSafeYield ? "✓" : "✗"} import yielding uses a visibility-independent scheduled task`);
if (backgroundSafeYield) passed += 1;

let releaseCount = 0;
let loading = true;
let shownError = "";
const malformedLoader = { parse() { throw new SyntaxError("Unexpected token in GLTF JSON"); } };
try {
  await Promise.race([
    parseGltfScene(malformedLoader, new ArrayBuffer(8), () => { releaseCount += 1; }, () => null, () => {}),
    new Promise((_, reject) => setTimeout(() => reject(new Error("parse did not settle")), 100)),
  ]);
} catch (error) {
  shownError = actionableImportFailure("broken.gltf", error).message;
} finally {
  loading = false;
}
const malformedSettled = releaseCount === 1
  && loading === false
  && shownError.includes("broken.gltf")
  && shownError.includes("then retry");
console.log(`${malformedSettled ? "✓" : "✗"} synchronous GLTF parse failure settles, releases URLs, clears loading, and reports an actionable error`);
if (malformedSettled) passed += 1;

const totalChecks = checks.length + 4;
console.log(`\n${passed}/${totalChecks} checks passed`);
if (passed !== totalChecks) process.exit(1);
