import fs from "node:fs";
import path from "node:path";

const dist = path.resolve("owllm-desktop", "dist");
const version = "1.0.30";
const base = `https://github.com/OwLLM/owllm/releases/download/v${version}`;
const signature = (name) => {
  const value = fs.readFileSync(path.join(dist, `${name}.sig`), "utf8").trim();
  if (value.length < 200) throw new Error(`invalid signature for ${name}`);
  return value;
};
const entry = (name) => ({
  signature: signature(name),
  url: `${base}/${encodeURIComponent(name)}`,
});
const notes = fs.readFileSync(path.join(dist, "release-notes-v1.0.30.md"), "utf8").trim();
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": entry("OwLLM Desktop Setup.exe"),
    "linux-x86_64": entry("OwLLM.Desktop_1.0.30_amd64.AppImage"),
    "linux-aarch64": entry("OwLLM.Desktop_1.0.30_aarch64.AppImage"),
    "darwin-aarch64": entry("OwLLM.Desktop_universal.app.tar.gz"),
    "darwin-x86_64": entry("OwLLM.Desktop_universal.app.tar.gz"),
  },
};
fs.writeFileSync(path.join(dist, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`LATEST_OK ${Object.keys(manifest.platforms).sort().join(",")}`);
