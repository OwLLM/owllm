// Verify the Code page chat aura stays a SOFT shifting halo:
//   - the psychedelic colour-cycling spin is still applied to both chat panes
//   - the strong "breathe" box-shadow pulse is gone (removed 2026-07-16)
//   - the static halo stays low-intensity (every rgba alpha <= 0.25)
//   - the page-tab working pulse (owllm-tab-working) is untouched
// Run: node ui/src/pages/agentic/codePageAura.verify.run.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "CodePage.tsx"), "utf8");

let failures = 0;
function check(name, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
}

// Colour-cycling spin still present and used by both panes.
const animMatch = src.match(/const PSYCHEDELIC_AURA_ANIMATION = "([^"]+)"/);
check("aura animation constant exists", !!animMatch);
check("aura animation keeps the colour-cycling spin", !!animMatch && animMatch[1].includes("owllm-aura-spin"));
check("aura animation has no breathe pulse", !!animMatch && !animMatch[1].includes("breathe"));
check("breathe keyframes removed", !src.includes("owllm-code-aura-breathe"));
check("both chat panes animate the aura", (src.match(/PSYCHEDELIC_AURA_ANIMATION : undefined/g) || []).length === 2);

// Static halo is soft: shared constant, all alphas low.
const haloMatch = src.match(/const PSYCHEDELIC_AURA_HALO = "([^"]+)"/);
check("halo constant exists", !!haloMatch);
const alphas = haloMatch ? [...haloMatch[1].matchAll(/rgba\([^)]*,\s*(\.?\d*\.?\d+)\)/g)].map((m) => parseFloat(m[1])) : [];
check("halo alphas are low-intensity (<= 0.25)", alphas.length > 0 && alphas.every((a) => a <= 0.25));
check("both chat panes use the soft halo", (src.match(/PSYCHEDELIC_AURA_HALO : undefined/g) || []).length === 2);

// The page-title/tab pulse must remain exactly as shipped.
check("tab working pulse keyframes untouched", src.includes("@keyframes owllm-tab-working") && src.includes('0 0 18px rgba(176,124,255,0.90)'));
check("tab working pulse still animated", src.includes('"owllm-tab-working 1.4s ease-in-out infinite"'));

console.log(failures === 0 ? "\nAll aura checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
