import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "generate-updater-manifest.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-updater-manifest-"));
const signatureFile = path.join(temp, "update.AppImage.sig");
const output = path.join(temp, "latest-linux-aarch64.json");
const signature = Buffer.from(
  "untrusted comment: signature from tauri secret key\nfixture\ntrusted comment: timestamp:1\tfile:update.AppImage\nfixture\n",
).toString("base64");
fs.writeFileSync(signatureFile, `${signature}\n`);

const env = {
  ...process.env,
  UPDATER_VERSION: "1.2.3",
  UPDATER_RELEASE_TAG: "v1.2.3",
  UPDATER_PLATFORM: "linux-aarch64",
  UPDATER_ASSET: "OwLLM.Desktop_aarch64.AppImage",
  UPDATER_SIGNATURE_FILE: signatureFile,
  UPDATER_OUTPUT: output,
  UPDATER_PUB_DATE: "2026-01-02T03:04:05.000Z",
};

const generated = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
assert.equal(generated.status, 0, generated.stderr);
const manifest = JSON.parse(fs.readFileSync(output, "utf8"));
assert.deepEqual(manifest, {
  version: "1.2.3",
  notes: "OwLLM Desktop v1.2.3",
  pub_date: "2026-01-02T03:04:05.000Z",
  platforms: {
    "linux-aarch64": {
      signature,
      url: "https://github.com/OwLLM/owllm/releases/download/v1.2.3/OwLLM.Desktop_aarch64.AppImage",
    },
  },
});

const mismatched = spawnSync(process.execPath, [script], {
  env: { ...env, UPDATER_RELEASE_TAG: "v1.2.4" },
  encoding: "utf8",
});
assert.notEqual(mismatched.status, 0, "mismatched release tags must fail the release gate");
assert.match(mismatched.stderr, /does not match updater version/);

fs.rmSync(temp, { recursive: true, force: true });
console.log("updater manifest verifier: 2/2 passed");
