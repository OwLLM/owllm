// Regression gate for the CodePage model-picker visual states.
// The code picker intentionally opts into a solid psychedelic treatment while
// every other ModelPicker keeps the established default appearance.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => fs.readFileSync(path.join(HERE, file), "utf8").replace(/\r\n/g, "\n");
const picker = read("ModelPicker.tsx");
const codePage = read("CodePage.tsx");
const styles = fs.readFileSync(path.resolve(HERE, "../../styles.css"), "utf8").replace(/\r\n/g, "\n");

let failures = 0;
const check = (label, condition) => {
  if (condition) console.log(`  PASS ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}`); }
};

const solidBlockStart = styles.indexOf(".ow-model-picker--solid-psychedelic");
const solidBlockEnd = styles.indexOf(".owc__tray", solidBlockStart);
const solidBlock = styles.slice(solidBlockStart, solidBlockEnd);
const noGlow = (block) => [...block.matchAll(/box-shadow\s*:\s*([^;]+)/gi)].every((m) => m[1].trim() === "none")
  && !/filter\s*:\s*drop-shadow/i.test(block)
  && !/text-shadow\s*:/i.test(block);
const luminance = (hex) => {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};
const contrast = (background, foreground) => {
  const a = luminance(background);
  const b = luminance(foreground);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

check("CodePage opts into the solid psychedelic picker appearance",
  codePage.includes('appearance="solid-psychedelic"')
  && (codePage.match(/appearance="solid-psychedelic"/g) || []).length === 1
  && codePage.includes('renderCodeModelPicker("primary"')
  && codePage.includes('renderCodeModelPicker("secondary"'));
check("ModelPicker exposes the opt-in appearance without changing the default",
  picker.includes('appearance = "default"')
  && picker.includes('appearance?: "default" | "solid-psychedelic"')
  && picker.includes('className={appearance === "solid-psychedelic"')
  && picker.includes('className="ow-model-picker__trigger"')
  && picker.includes('className="ow-model-picker__option"'));
check("selected and unselected trigger states are explicit",
  solidBlock.includes('.ow-model-picker__trigger[data-state="selected"]')
  && solidBlock.includes('.ow-model-picker__trigger[data-state="unselected"]')
  && solidBlock.includes('background: #b07cff;')
  && solidBlock.includes('background: var(--bg-surface);'));
check("selected and unselected option states are explicit",
  solidBlock.includes('.ow-model-picker__option[data-state="selected"]')
  && solidBlock.includes('.ow-model-picker__option[data-state="unselected"]'));
check("hover states use solid psychedelic colors",
  solidBlock.includes('.ow-model-picker__trigger:hover:not(:disabled)')
  && solidBlock.includes('.ow-model-picker__option:hover:not(:disabled)')
  && solidBlock.includes('background: #ff5c8a;'));
check("selected and hover states contain no glow effects", noGlow(solidBlock));
check("keyboard focus is visible without replacing it with a glow",
  solidBlock.includes(':focus-visible')
  && solidBlock.includes('outline: 2px solid #ffd93c;')
  && solidBlock.includes('outline-offset: 2px;')
  && solidBlock.includes('box-shadow: none;'));
check("hardcoded psychedelic foreground pairs remain readable",
  solidBlock.includes('color: #160c24;')
  && solidBlock.includes('color: #260812;')
  && contrast("#b07cff", "#160c24") >= 4.5
  && contrast("#ff5c8a", "#260812") >= 4.5);

if (failures) throw new Error(`FAILED: ${failures} CodePage model-picker style check(s).`);
console.log("\nAll CodePage model-picker style checks passed.");
