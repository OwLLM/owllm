// Regression: Windows Schannel reports curl exit 35 when the certificate
// revocation endpoint is temporarily offline. Module bootstrap must retry that
// one condition without disabling ordinary TLS certificate validation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../../..");
const SCRIPT = process.env.OWLLM_VERIFY_BUILD_MODULES
  || path.join(APP, "scripts", "build-modules.ps1");
const source = fs.readFileSync(SCRIPT, "utf8").replace(/\r\n/g, "\n");
const start = source.indexOf("function Get-Upstream");
const end = source.indexOf("\nfunction Expand-Strip", start);
const block = start >= 0 && end > start ? source.slice(start, end) : "";

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}`); }
}

check("Get-Upstream is locatable", block.length > 0);
check("the first download remains strict", /& curl\.exe @curlArgs/.test(block));
check("only curl exit 35 enables the revocation-offline retry",
  /if \(\$LASTEXITCODE -eq 35\)/.test(block));
check("the retry uses Schannel's narrow best-effort revocation option",
  /& curl\.exe --ssl-revoke-best-effort @curlArgs/.test(block));
check("other failures remain fatal", /if \(\$LASTEXITCODE -ne 0\)[\s\S]*throw "curl failed/.test(block));

if (process.platform === "win32" && block) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-module-tls-"));
  const harness = path.join(tmp, "verify.ps1");
  const dest = path.join(tmp, "payload.zip");
  fs.writeFileSync(harness, [
    "$ForceRedownload = $true",
    "$script:attempts = 0",
    "function Write-Sub { param([string]$message) }",
    "function curl.exe {",
    "  $script:attempts += 1",
    "  $outIndex = [Array]::IndexOf($args, '--output')",
    "  if ($script:attempts -eq 1) { $global:LASTEXITCODE = 35; return }",
    "  if ($args -notcontains '--ssl-revoke-best-effort') { $global:LASTEXITCODE = 60; return }",
    "  Set-Content -NoNewline -Path $args[$outIndex + 1] -Value 'verified payload'",
    "  $global:LASTEXITCODE = 0",
    "}",
    block,
    `Get-Upstream 'https://example.invalid/module.zip' '${dest.replaceAll("'", "''")}'`,
    "if ($script:attempts -ne 2) { exit 11 }",
    "",
  ].join("\r\n"));
  const run = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harness], {
    encoding: "utf8", timeout: 30_000,
  });
  check("the real function retries exit 35 and completes the download",
    run.status === 0 && fs.readFileSync(dest, "utf8") === "verified payload");
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures) process.exit(1);
console.log("module download TLS regression passed");
