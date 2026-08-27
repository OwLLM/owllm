#!/usr/bin/env node
// Open a sealed OwLLM bug report.
//
// Reports from people who are not on the team cannot reach the private intake
// repo, so they are filed as issues on the PUBLIC repo with the whole payload
// sealed to the team's X25519 key (see src-tauri/src/support_seal.rs). This is
// the tool that opens one.
//
//   node scripts/decrypt-report.mjs <file-with-the-issue-body>
//   gh issue view 42 -R OwLLM/owllm --json body -q .body | node scripts/decrypt-report.mjs
//
// The secret key is read from OWLLM_SUPPORT_REPORT_SECRET (base64) or, by
// default, from ~/OwLLM/support-report-key/owllm-support-report-v1.secret.
// It is NEVER in this repo and never ships in a build.
//
// Dependency-free on purpose: node:crypto does X25519 and AES-256-GCM, so
// triage works on any machine with Node and no install step.

import { createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Must stay byte-identical to KDF_CONTEXT / SEAL_ALG / SEAL_VERSION in
// src-tauri/src/support_seal.rs — the regression gate asserts both sides.
const KDF_CONTEXT = Buffer.from("owllm-support-report-v1/aead-key");
const SEAL_ALG = "x25519-aes256gcm";
const SEAL_VERSION = 1;

const DER_X25519_PRIV_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const DER_X25519_PUB_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

const rawToPrivateKey = (raw) =>
  createPrivateKey({ key: Buffer.concat([DER_X25519_PRIV_PREFIX, raw]), format: "der", type: "pkcs8" });
const rawToPublicKey = (raw) =>
  createPublicKey({ key: Buffer.concat([DER_X25519_PUB_PREFIX, raw]), format: "der", type: "spki" });

/** Pull the armored block out of anything (a whole issue body, an email, …). */
export function extractArmored(text) {
  const m = /-----BEGIN OWLLM SEALED REPORT-----([\s\S]*?)-----END OWLLM SEALED REPORT-----/.exec(text);
  if (!m) throw new Error("no sealed OwLLM report block found in the input");
  return m[1].replace(/\s+/g, "");
}

/**
 * Decrypt an armored block with a 32-byte X25519 secret. Mirrors
 * support_seal::open_sealed: same KDF, same AAD, same refusal to touch an
 * envelope whose version or algorithm it does not recognise.
 */
export function openSealedReport(secretRaw, text) {
  if (secretRaw.length !== 32) throw new Error(`secret key must be 32 bytes, got ${secretRaw.length}`);
  const env = JSON.parse(Buffer.from(extractArmored(text), "base64").toString("utf8"));
  if (env.v !== SEAL_VERSION) throw new Error(`unsupported envelope version ${env.v}`);
  if (env.alg !== SEAL_ALG) throw new Error(`unsupported algorithm ${env.alg}`);

  const epk = Buffer.from(env.epk, "base64");
  const rpk = Buffer.from(env.rpk, "base64");
  const nonce = Buffer.from(env.n, "base64");
  const ctAndTag = Buffer.from(env.ct, "base64");
  if (nonce.length !== 12) throw new Error("bad nonce length");

  const shared = diffieHellman({ privateKey: rawToPrivateKey(secretRaw), publicKey: rawToPublicKey(epk) });
  const key = createHash("sha256").update(KDF_CONTEXT).update(shared).update(epk).update(rpk).digest();

  // aes-gcm (Rust) appends the 16-byte tag to the ciphertext; node wants them apart.
  const tag = ctAndTag.subarray(ctAndTag.length - 16);
  const ct = ctAndTag.subarray(0, ctAndTag.length - 16);
  const aad = Buffer.from(`v=${SEAL_VERSION};alg=${SEAL_ALG};epk=${env.epk};rpk=${env.rpk};n=${env.n}`);

  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

function loadSecret() {
  const b64 = process.env.OWLLM_SUPPORT_REPORT_SECRET;
  if (b64) return Buffer.from(b64.trim(), "base64");
  const path = join(homedir(), "OwLLM", "support-report-key", "owllm-support-report-v1.secret");
  try {
    return Buffer.from(readFileSync(path, "utf8").trim(), "base64");
  } catch {
    throw new Error(
      `no report key. Set OWLLM_SUPPORT_REPORT_SECRET (base64) or put the key in ${path}`,
    );
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (isMain) {
  const readStdin = async () => {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8");
  };
  const text = process.argv[2] ? readFileSync(process.argv[2], "utf8") : await readStdin();
  const payload = JSON.parse(openSealedReport(loadSecret(), text));
  process.stdout.write(`# ${payload.title}\n\n${payload.bodyMd}\n`);
}
