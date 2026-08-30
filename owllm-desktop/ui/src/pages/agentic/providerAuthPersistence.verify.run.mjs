import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../..");
const browser = fs.readFileSync(path.join(ROOT, "src-tauri/src/browser.rs"), "utf8");

let failed = 0;
function check(name, ok) {
  if (ok) console.log(`ok - ${name}`);
  else {
    failed += 1;
    console.error(`not ok - ${name}`);
  }
}

check(
  "provider authorization uses a stable per-provider profile",
  browser.includes("fn provider_auth_profile_key(url: &tauri::Url)")
    && browser.includes("fn provider_auth_data_dir(url: &tauri::Url)")
    && browser.includes('.join("provider-auth")')
    && !browser.includes('join("owllm-provider-auth")')
    && !browser.includes('format!("{}-{id}", std::process::id())'),
);

check(
  "provider authorization is persistent instead of incognito",
  !browser.includes("content = content.incognito(true)")
    && !browser.includes("builder = builder.incognito(true)"),
);

check(
  "persistent auth remains isolated from ordinary browser state and tab restore",
  browser.includes("private_tabs: HashSet<u64>")
    && browser.includes(".filter(|tab| !private_tabs.contains(&tab.id))")
    && browser.includes("provider_auth_data_dir(&auth_profile_url)")
    && browser.includes("browser_data_dir()"),
);

check(
  "macOS 14+ receives a stable isolated provider data store",
  browser.includes("fn provider_auth_store_identifier(url: &tauri::Url) -> [u8; 16]")
    && browser.includes("content = content.data_store_identifier(auth_store_identifier)")
    && browser.includes("builder = builder.data_store_identifier(auth_store_identifier)"),
);

if (failed) {
  console.error(`providerAuthPersistence: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("providerAuthPersistence: all checks passed");
