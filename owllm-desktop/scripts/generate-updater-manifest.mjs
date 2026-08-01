import fs from "node:fs";
import path from "node:path";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const version = required("UPDATER_VERSION");
const releaseTag = required("UPDATER_RELEASE_TAG");
const platform = required("UPDATER_PLATFORM");
const asset = required("UPDATER_ASSET");
const signatureFile = required("UPDATER_SIGNATURE_FILE");
const output = required("UPDATER_OUTPUT");
const repository = process.env.UPDATER_REPOSITORY?.trim() || "OwLLM/owllm";

if (releaseTag.replace(/^v/, "") !== version) {
  throw new Error(`Release tag ${releaseTag} does not match updater version ${version}`);
}
if (path.basename(asset) !== asset) {
  throw new Error("UPDATER_ASSET must be a filename, not a path");
}

const signature = fs.readFileSync(signatureFile, "utf8").trim();
let decodedSignature = "";
try {
  decodedSignature = Buffer.from(signature, "base64").toString("utf8");
} catch {
  // The actionable error below is shared with malformed-but-decodable input.
}
if (
  !decodedSignature.startsWith("untrusted comment: signature from tauri secret key\n") ||
  !decodedSignature.includes("\ntrusted comment: timestamp:")
) {
  throw new Error(`Invalid Tauri updater signature: ${signatureFile}`);
}

const manifest = {
  version,
  notes: process.env.UPDATER_NOTES?.trim() || `OwLLM Desktop v${version}`,
  pub_date: process.env.UPDATER_PUB_DATE?.trim() || new Date().toISOString(),
  platforms: {
    [platform]: {
      signature,
      url: `https://github.com/${repository}/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(asset)}`,
    },
  },
};

fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Generated ${output} for ${platform}`);
