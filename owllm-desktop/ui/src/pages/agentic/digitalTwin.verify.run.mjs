import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pagePath = process.env.DIGITAL_TWIN_PAGE_PATH
  ? path.resolve(process.env.DIGITAL_TWIN_PAGE_PATH)
  : path.join(here, "DigitalTwinPage.tsx");
const page = fs.readFileSync(pagePath, "utf8");
const route = fs.readFileSync(path.join(here, "DigitalTwinRoute.tsx"), "utf8");
const registry = fs.readFileSync(path.resolve(here, "../../core/modules.ts"), "utf8");

const checks = [
  [registry.includes('key: "studio"') && registry.indexOf('key: "digital-twin"') > registry.indexOf('key: "studio"'), "Digital Twin/3D is registered immediately after Studio"],
  [registry.includes('label: "Digital Twin/3D"') && registry.includes("component: DigitalTwinRoute"), "the new page has the requested visible label and isolated route"],
  [route.includes('lazy(() => import("./DigitalTwinPage"))'), "Three.js and its loaders are lazy-loaded away from existing pages"],
  [page.includes('new GLTFLoader') && page.includes('new OBJLoader') && page.includes('new STLLoader'), "GLB/GLTF, OBJ, and STL loaders are wired"],
  [page.includes("URL.createObjectURL") && page.includes("URL.revokeObjectURL"), "linked GLTF assets use revocable local object URLs"],
  [page.includes("return BLOCKED_ASSET_URL") && page.includes("Missing linked asset") && !page.includes("?? url"), "unmapped GLTF assets are blocked locally and report which companion files to select"],
  [page.includes('role="alert"') && page.includes("Retry import") && page.includes("Preparing geometry on this device"), "loading and actionable error states are present"],
  [page.includes("Choose 3D files") && page.includes("No constraints yet") && page.includes("constraints.map"), "empty and populated assembly states are present"],
  [page.includes("STEP/IGES needs a CAD tessellation engine"), "unsupported CAD formats fail honestly instead of pretending to import"],
  [page.includes("100 MB interactive import limit") && page.includes("so the UI remains responsive"), "oversized imports are refused before they can monopolize the UI thread"],
  [page.includes("MAX_TOTAL_IMPORT_BYTES") && page.includes("250 MB aggregate import limit") && page.includes("files.reduce((sum, file) => sum + file.size, 0)"), "aggregate import size is capped across models and linked assets"],
  [page.includes("window.setTimeout(resolve, 0)") && !page.includes("window.requestAnimationFrame") && page.includes("importRunRef.current += 1"), "multi-file imports yield without depending on window visibility and stale work remains cancellable"],
  [page.includes("if (importingRef.current)") && page.includes("then drop these files again"), "dropping files during an active import produces actionable feedback"],
  [page.includes('aria-label="Assembly parts"') && page.includes('aria-label="Digital twin inspector"'), "the workspace regions expose accessible labels"],
];

let passed = 0;
for (const [ok, message] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${message}`);
  if (ok) passed += 1;
}
console.log(`\n${passed}/${checks.length} checks passed`);
if (passed !== checks.length) process.exit(1);
