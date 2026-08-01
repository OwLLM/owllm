#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(HERE, name), "utf8").replace(/\r\n/g, "\n");
const code = read("CodePage.tsx");
const picker = read("ModelPicker.tsx");
const publish = read("PublishCards.tsx");
const memory = read("localTools.ts");
const nativeMemory = fs.readFileSync(path.resolve(HERE, "../../../../src-tauri/src/memory.rs"), "utf8").replace(/\r\n/g, "\n");

let failures = 0;
const check = (label, ok) => {
  if (ok) console.log(`PASS ${label}`);
  else { failures += 1; console.error(`FAIL ${label}`); }
};

// Both Code composers are now the ONE shared <Composer/> (components/Composer.tsx);
// the header slot still carries that agent's model picker and Terminal button.
const primaryToolbar = code.slice(code.indexOf('dataUi="CodePrimaryComposer"'), code.indexOf("attachments={codeAttachments}"));
const secondaryToolbar = code.slice(code.indexOf('dataUi="CodeSecondaryComposer"'), code.indexOf("attachments={secondaryAttachments}"));
const publisher = publish.slice(publish.indexOf('data-ui="GitPublisherContainer"'), publish.indexOf("{/* Commit popup"));

check("Project Memory remains visible in the left project rail", code.includes('data-ui="CodeProjectMemory"'));
check("primary model and Terminal share the toolbar aligned above its composer", primaryToolbar.includes("<ModelPicker") && primaryToolbar.includes('renderTerminalButton("primary")'));
check("second-agent model and Terminal share the toolbar aligned above its composer", secondaryToolbar.includes("<ModelPicker") && secondaryToolbar.includes('renderTerminalButton("secondary")'));
check("both composer pickers explicitly open upward", primaryToolbar.includes('placement="top"') && secondaryToolbar.includes('placement="top"') && picker.includes('placement?: "auto" | "top" | "bottom"'));
check("publisher activity renders before the first Git facts row",
  publisher.indexOf('data-ui="PublisherActivity"') >= 0
    && publisher.indexOf('data-ui="PublisherActivity"') < publisher.indexOf("Live repo facts"));
check("publisher results no longer leak into the composer status",
  !publish.includes("onStatus") && !publish.includes("status(`✓") && !publish.includes("status(`✗"));
check("persisted Up-to-date text is removed from the composer during hydration",
  code.includes('s.status === "✓ Up to date. Local and origin/main are already the same commit."')
    && code.includes("PublisherCards"));
check("ordinary completed runs are not promoted to durable facts",
  !memory.includes("autoCurateScopedTeamFact") && !memory.includes("auto-curated,implementation"));
check("legacy generated facts are archived outside graph/search instead of deleted",
  nativeMemory.includes("archive legacy auto-curated memory")
    && nativeMemory.includes("SET kind = 'archived'")
    // Search may only ever consider 'fact' and 'worklog'. The kind restriction
    // moved from a literal in the SQL into a validated `wanted` list bound as
    // parameters — because applying it AFTER the query's 500-row window meant a
    // busy project's facts fell out of reach. The invariant is unchanged: an
    // unknown or 'archived' kind is dropped, never queried.
    && /kind IN \(\{placeholders\}\)/.test(nativeMemory)
    && /k\.as_str\(\) == "fact" \|\| k\.as_str\(\) == "worklog"/.test(nativeMemory)
    // No kinds asked for → both queryable kinds, never 'archived'.
    && /_ => vec!\["fact"\.to_string\(\), "worklog"\.to_string\(\)\]/.test(nativeMemory)
    // A kinds list that survives the whitelist EMPTY returns no rows, rather than
    // falling through to the default and silently widening the caller's search.
    && /known\.is_empty\(\)[\s\S]{0,400}?return Ok\(Vec::new\(\)\)/.test(nativeMemory));

if (failures) process.exit(1);
console.log("all checks passed");
