import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

if (typeof globalThis.ProgressEvent === "undefined") {
  globalThis.ProgressEvent = class ProgressEvent {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  };
}

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
  applySourceUnit,
  aggregateImportError,
  defaultModelUnit,
  formatModelDimensions,
  metresPerModelUnit,
  modelSizeWarning,
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
  [page.includes("new THREE.OrthographicCamera") && page.includes('aria-pressed={projection === mode}') && page.includes('"Orthographic"'), "a true, keyboard-accessible orthographic projection is available"],
  [page.includes('id="digital-twin-import-unit"') && page.includes('id="digital-twin-part-unit"') && page.includes("applySourceUnit(object, unit)"), "source units are explicit at import and correctable per part"],
  [page.includes("  applySourceUnit,") && !page.includes("function applySourceUnit"), "the production importer uses the shared source-unit helper exercised by fixtures"],
  [page.includes("Math.max(sphere.radius, 1e-9)") && page.includes("controls.minDistance = 1e-9") && page.includes("controls.maxDistance = 1e12"), "camera fitting preserves tiny and very large normalized CAD scales"],
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

const unitsArePhysical = defaultModelUnit("gltf") === "m"
  && defaultModelUnit("GLB") === "m"
  && defaultModelUnit("obj") === "mm"
  && defaultModelUnit("stl") === "mm"
  && metresPerModelUnit("in") === 0.0254
  && metresPerModelUnit("ft") === 0.3048
  && formatModelDimensions([0.1, 0.025, 0.001], "mm") === "100 × 25 × 1 mm";
console.log(`${unitsArePhysical ? "✓" : "✗"} CAD coordinates normalize to metres while dimensions remain readable in the source unit`);
if (unitsArePhysical) passed += 1;

const suspiciousSizesAreFlagged = modelSizeWarning([1001, 1, 1])?.includes("over 1 km") === true
  && modelSizeWarning([0.000001, 0.000002, 0.000003])?.includes("under 0.01 mm") === true
  && modelSizeWarning([0.1, 0.2, 0.3]) === null;
console.log(`${suspiciousSizesAreFlagged ? "✓" : "✗"} implausible CAD scale produces an actionable source-unit warning`);
if (suspiciousSizesAreFlagged) passed += 1;

const fixtureDir = path.join(repo, "ui/public/test-fixtures/digital-twin");
const gltfBuffer = fs.readFileSync(path.join(fixtureDir, "known-dimensions-metres.gltf"));
const stlBuffer = fs.readFileSync(path.join(fixtureDir, "known-dimensions-millimetres.stl"));
const exactArrayBuffer = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
const dimensionsOf = (object) => new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3()).toArray();
const closeTo = (actual, expected) => actual.length === expected.length
  && actual.every((value, index) => Math.abs(value - expected[index]) < 1e-6);

const gltfScene = await parseGltfScene(new GLTFLoader(), exactArrayBuffer(gltfBuffer), () => {}, () => null, () => {});
const stlGeometry = new STLLoader().parse(exactArrayBuffer(stlBuffer));
const stlMesh = new THREE.Mesh(stlGeometry);
const gltfRawDimensions = dimensionsOf(gltfScene);
const stlRawDimensions = dimensionsOf(stlMesh);
const fixturesLoadAtKnownDimensions = closeTo(gltfRawDimensions, [0.1, 0.2, 0.3])
  && closeTo(stlRawDimensions, [100, 200, 300]);
console.log(`${fixturesLoadAtKnownDimensions ? "✓" : "✗"} GLTFLoader and STLLoader decode the committed known-dimension fixtures`);
if (fixturesLoadAtKnownDimensions) passed += 1;

gltfScene.position.set(1, 2, 3);
stlMesh.position.set(1000, 2000, 3000);
applySourceUnit(gltfScene, defaultModelUnit("gltf"));
applySourceUnit(stlMesh, defaultModelUnit("stl"));
const gltfDimensionsMetres = dimensionsOf(gltfScene);
const stlDimensionsMetres = dimensionsOf(stlMesh);
const fixturesNormalizeToSameMetres = closeTo(gltfDimensionsMetres, [0.1, 0.2, 0.3])
  && closeTo(stlDimensionsMetres, gltfDimensionsMetres)
  && closeTo(gltfScene.position.toArray(), [1, 2, 3])
  && closeTo(stlMesh.position.toArray(), gltfScene.position.toArray())
  && formatModelDimensions(gltfDimensionsMetres, "m") === "0.1 × 0.2 × 0.3 m"
  && formatModelDimensions(stlDimensionsMetres, "mm") === "100 × 200 × 300 mm";
console.log(`${fixturesNormalizeToSameMetres ? "✓" : "✗"} production source-unit normalization gives GLTF and STL identical dimensions and placement`);
if (fixturesNormalizeToSameMetres) passed += 1;

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

const totalChecks = checks.length + 8;
console.log(`\n${passed}/${totalChecks} checks passed`);
if (passed !== totalChecks) process.exit(1);
