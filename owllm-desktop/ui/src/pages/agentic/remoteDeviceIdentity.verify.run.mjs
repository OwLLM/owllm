// Regression gate for the 2026-08-20 "paired devices look offline while
// online" fix. Root cause: re-pairing a machine mints a NEW device_id, so one
// name accumulates dead identities in the registry; every name→device
// resolution took the FIRST match in raw file order and dialed a corpse
// (measured live: 'zeusthor1' had 4 identities, all dead since Aug 9, while
// the live machines answered instantly under their current identities).
// The fix orders the registry list self-first then freshest-first, dedupes the
// agent-facing device roster by name, and makes dial failures name the exact
// identity dialed + its last heartbeat. Source-level structural assertions
// (no Tauri runtime); lives in pages/agentic/ so the smoke matrix
// auto-discovers it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// CRLF-robust read: Windows core.autocrlf checks LF-committed files out as
// CRLF, so a needle containing \n would false-fail on a CRLF working tree.
const read = (rel) => fs.readFileSync(path.resolve(HERE, rel), "utf8").replace(/\r\n/g, "\n");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`✓ ${message}`);
}

const T = "../../../../src-tauri/src"; // ui/src/pages/agentic → owllm-desktop
const registry = read(`${T}/remote_devices/registry.rs`);
// The freshness ordering moved into the pure canonical.rs when device records
// gained deduplication + tombstones, so devices-harness could execute it. Same
// invariants, new home — the assertions below follow it rather than being
// relaxed. Deduplication itself is gated by advanced/deviceIdentity.verify.run.mjs.
const canonical = read(`${T}/remote_devices/canonical.rs`);
const mod = read(`${T}/remote_devices/mod.rs`);
const localTools = read("./localTools.ts");

// ── 1. Registry list is freshness-ordered ─────────────────────────────────
check(
  /pub fn freshness_epoch\(rec: &DeviceRecord\) -> i64/.test(canonical),
  "canonical: freshness_epoch() ranks a record by its newest timestamp",
);
check(
  canonical.includes("rec.public.published_at.as_deref()") &&
    canonical.includes("rec.last_seen.as_deref()"),
  "canonical: freshness considers BOTH the publish heartbeat and last_seen",
);
check(
  /pub fn order_for_resolution\(devices: &mut \[DeviceRecord\]\)[\s\S]*?a\.is_self\s*\n?\s*\.cmp\(&b\.is_self\)\s*\n?\s*\.reverse\(\)[\s\S]*?freshness_epoch\(a\)\.cmp\(&freshness_epoch\(b\)\)\.reverse\(\)/.test(canonical),
  "canonical: order_for_resolution sorts self-first, then freshest-first",
);
check(
  /\.then_with\(\|\| a\.public\.device_id\.cmp\(&b\.public\.device_id\)\)/.test(canonical),
  "canonical: the ordering is total, so the resolution winner is reproducible",
);
check(
  /pub fn canonicalize\([\s\S]*?order_for_resolution\(&mut ordered\);/.test(canonical) &&
    /canonical::canonicalize\(f\.devices, &tombstones\(\)\)/.test(registry),
  "registry: list() applies the resolution ordering (via canonicalize) before returning",
);
check(
  /fn duplicate_name_resolves_to_freshest_identity/.test(canonical) &&
    /fn last_seen_counts_as_freshness/.test(canonical) &&
    /fn self_record_stays_first_and_dateless_records_sink/.test(canonical),
  "canonical: executable unit tests cover the duplicate-name/freshness contract",
);

// ── 2. Name resolution rides that ordering ────────────────────────────────
check(
  /let all = registry::list\(&self_pub\);\s*\n\s*let target = all\s*\n\s*\.iter\(\)\s*\n\s*\.find\(/.test(mod),
  "mod: agent_device_exec resolves a name via the FIRST match of the ordered list",
);

// ── 3. Dial failures are attributable ─────────────────────────────────────
check(
  /send_request\(&target\.public\.device_id, req\)\s*\.await\s*\.map_err\(/.test(mod) ||
    /send_request\(&target\.public\.device_id, req\)\.await\.map_err\(/.test(mod),
  "mod: agent_device_exec wraps dial errors with identity context",
);
check(
  mod.includes("last heartbeat {heartbeat}") && mod.includes("stale_twins"),
  "mod: the error names the dialed identity's last heartbeat + stale same-name twins",
);

// ── 4. Agent-facing roster lists each machine once ────────────────────────
check(
  /const seen = new Set<string>\(\);[\s\S]{0,400}?if \(seen\.has\(k\)\) return false;/.test(localTools),
  "localTools: the advertised 'Paired devices' roster is deduped by name",
);
check(
  localTools.includes('d.device_id === wanted || d.name.toLowerCase() === wanted.toLowerCase()'),
  "localTools: device_exec/device_screenshot still resolve first-match (ordering carries the fix)",
);

console.log(`OK remote device identity freshness: ${passed}/${passed} checks passed`);
