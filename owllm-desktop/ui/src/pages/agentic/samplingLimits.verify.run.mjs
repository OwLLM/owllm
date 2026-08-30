// Regression gate for the llama-server 400 that killed EVERY local
// request:
//   {"error":{"code":400,"message":"Field 'dry_penalty_last_n': Value
//    must be between 0 <= value <= 2147483647, but got -1"}}
//
// llama-server's request schema hard-limits the DRY/repeat scan windows
// to [0, INT32_MAX] (tools/server/server-schema.cpp). The legacy
// "-1 = whole context" idiom is now rejected outright, before a single
// token is generated. Sampling values must therefore be sanitised at the
// one seam dispatch reads them from.

import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const here = new URL(".", import.meta.url);
const src = (rel) => readFileSync(new URL(rel, here), "utf8").replace(/\r\n/g, "\n");
let pass = 0;
let fail = 0;
const check = (name, ok) => {
  if (ok) { pass++; console.log("ok  ", name); }
  else { fail++; console.error("FAIL", name); }
};

// modelProfiles reads localStorage overrides; under node there is none.
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };

let profiles;
let outDir;
try {
  outDir = mkdtempSync(path.join(tmpdir(), "owllm-sampling-verify-"));
  const outFile = path.join(outDir, "modelProfiles.mjs");
  await build({
    entryPoints: [new URL("./modelProfiles.ts", here).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: outFile,
    logLevel: "silent",
  });
  profiles = await import(pathToFileURL(outFile).href);
} catch (error) {
  console.error(String(error));
} finally {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
}

check("sampling sanitiser is exported", typeof profiles?.sanitizeSampling === "function");

if (profiles?.samplingFor) {
  // The values actually sent. Any negative scan window is a hard 400.
  const windows = ["dry_penalty_last_n", "repeat_last_n", "dry_allowed_length"];
  for (const model of ["qwen3-30b", "muse-glimmer-30b", "llama-3.1-8b", "", "sub/gpt-oss-20b"]) {
    const s = profiles.samplingFor(model);
    check(`sampling for "${model || "(unset)"}" passes llama-server's [0, INT32_MAX] limits`,
      windows.every((k) => typeof s[k] === "number" && s[k] >= 0 && s[k] <= 2147483647));
  }
  // DRY must stay ENABLED — clamping the window to 0 would silently turn
  // off the primary anti-loop sampler instead of fixing the request.
  const base = profiles.samplingFor("qwen3-30b");
  check("DRY stays enabled after sanitising (window > 0, multiplier > 0)",
    base.dry_penalty_last_n > 0 && base.dry_multiplier > 0);
  check("repeat penalty scan window stays enabled", base.repeat_last_n > 0);
}

if (profiles?.sanitizeSampling) {
  // A stale localStorage / remote profile carrying the legacy -1 must not
  // be able to reintroduce the 400.
  const legacy = profiles.sanitizeSampling({
    dry_penalty_last_n: -1,
    repeat_last_n: -1,
    dry_allowed_length: -1,
    top_p: 0.95,
  });
  check("legacy -1 DRY window is repaired, not passed through", legacy.dry_penalty_last_n > 0);
  check("legacy -1 repeat window is repaired, not passed through", legacy.repeat_last_n > 0);
  check("negative dry_allowed_length is floored at 0", legacy.dry_allowed_length === 0);
  check("non-window fields are left untouched", legacy.top_p === 0.95);
}

// dispatch is the only place that builds the request body; the merge with
// per-call overrides must be sanitised AFTER the merge, or a ChatPage
// override could reintroduce a negative window.
const dispatch = src("./dispatch.ts");
check("dispatch sanitises sampling after merging per-call overrides",
  dispatch.includes("sanitizeSampling({ ...samplingFor(p.modelId), ...(p.samplingOverride ?? {}) })"));

// No source may ship the legacy literal again.
check("no bundled profile ships dry_penalty_last_n: -1",
  !src("./modelProfiles.ts").includes("dry_penalty_last_n: -1"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
