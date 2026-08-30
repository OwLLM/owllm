// Guards the LEAKY-HOST-SERVICE contract: memory a Windows service leaks
// because of this app's workload must be reclaimed on a schedule, and the
// reclaim must never be able to hurt the machine.
//
// The defect class: `PcaSvc` held 2,994 MB of private bytes backing 1 MB of
// data after 14 days of agent turns (restarting it returned it to 3.9 MB doing
// the same job — leak, not workload). Three measured facts shape the guard,
// and each one is a way this feature could silently become dangerous or
// useless, so each is pinned here:
//
//  1. A normal user CANNOT stop the service (`sc sdshow PcaSvc` gives
//     Interactive Users RP but not WP). So the reclaim needs admin — and a
//     background sweep that raised a UAC dialog would take the GUI hostage.
//     The janitor pass must therefore stay report-only.
//  2. The graceful stop WEDGES once bloated (STOP_PENDING, checkpoint frozen
//     for 8 minutes). So the guard escalates to terminating — which means the
//     safety triad (sole tenant / not critical / no reboot-on-failure) is the
//     only thing standing between this feature and killing something load
//     bearing. Every unreadable input must count AGAINST reclaiming.
//  3. The SYSTEM task executes a script on disk, so that script's directory
//     must not be writable by a normal user, or the guard becomes a local
//     privilege-escalation path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "../../../..");
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
let passed = 0;
const check = (ok, message) => {
  if (!ok) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
};

const guard = read(path.join(DESKTOP, "src-tauri", "src", "host_guard.rs"));
const fleet = read(path.join(DESKTOP, "src-tauri", "src", "fleet.rs"));
const lib = read(path.join(DESKTOP, "src-tauri", "src", "lib.rs"));
const card = read(path.join(DESKTOP, "ui", "src", "pages", "core", "HostGuardCard.tsx"));
const info = read(path.join(DESKTOP, "ui", "src", "pages", "core", "InfoPage.tsx"));

// Slice a Rust item body so every assertion is anchored to the function it
// names — a bare substring search would happily match a comment elsewhere.
const bodyOf = (source, signature) => {
  const start = source.indexOf(signature);
  if (start < 0) return "";
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return "";
};
const rawStr = (name) => {
  const m = new RegExp(`const ${name}: &str = r#"([\\s\\S]*?)"#;`).exec(guard);
  check(!!m, `the ${name} literal is declared where the gate can read it`);
  return m[1];
};

// ------------------------------------------------- the leaky-service registry
const registry = /const LEAKY_SERVICES: &\[\(&str, &str, u64\)\] = &\[([\s\S]*?)\];/.exec(guard);
check(!!registry, "the LEAKY_SERVICES registry is declared where the gate can read it");
const rows = [...registry[1].matchAll(/\(\s*"([^"]+)",\s*"([^"]+)",\s*([0-9 *_]+),/g)]
  .map((m) => [m[1], m[2], Function(`return ${m[3].replace(/_/g, "")}`)()]);
check(rows.length >= 1, `the registry lists every guarded service (${rows.length} rows)`);
check(rows.some(([n]) => n === "PcaSvc"),
  "PcaSvc — the measured 3 GB leak — is still guarded; dropping the row is a release failure");
for (const [name, what, threshold] of rows) {
  check(/^[A-Za-z0-9_]+$/.test(name),
    `"${name}" is a bare service name — it is interpolated into a WMI filter and a task action`);
  check(what.trim().length > 0, `"${name}" says what it is, so a future reader can judge the row`);
  check(threshold >= 256 * 1024 * 1024 && threshold <= 64 * 1024 * 1024 * 1024,
    `"${name}" has a real threshold (${(threshold / 2 ** 30).toFixed(1)} GiB) — neither "restart always" nor "never"`);
}
check(guard.includes("fn leaky_service_registry_is_well_formed("),
  "cargo regression test present: leaky_service_registry_is_well_formed");

// --------------------------------------------------------- the guard script
const script = rawStr("GUARD_SCRIPT");
check(script.includes("function Get-OwllmLeakVerdict"),
  "there is ONE function that authorises a reclaim, so the decision cannot drift across callers");
const verdict = /function Get-OwllmLeakVerdict \{([\s\S]*?)\n\}/.exec(script);
check(!!verdict, "the verdict function is sliceable");
for (const [needle, why] of [
  ["if ($ThresholdBytes -le 0)", "a missing/zero threshold is UNSAFE, never an invitation to reclaim"],
  ["if ($PrivateBytes -lt $ThresholdBytes)", "a service under its threshold is left alone"],
  ["if ($TenantCount -ne 1)", "a svchost shared with other services is never touched"],
  ["if ($IsCritical)", "a kernel-critical process is never touched"],
  ["if ($RebootOnFailure)", "a service configured to REBOOT the machine on failure is never touched"],
]) {
  check(verdict[1].includes(needle), why);
}
// Order matters: every unsafe test must precede the single 'reclaim' return.
const okAt = verdict[1].indexOf("return 'reclaim'");
for (const needle of ["-ne 1", "IsCritical", "RebootOnFailure"]) {
  check(verdict[1].indexOf(needle) < okAt && okAt > 0,
    `the ${needle} safety test runs BEFORE a reclaim can be authorised`);
}
check((verdict[1].match(/return 'reclaim'/g) || []).length === 1,
  "there is exactly one path to 'reclaim' — no second, unguarded exit");

// Unreadable inputs must count AGAINST reclaiming.
const crit = /function Test-OwllmProcessCritical \{([\s\S]*?)\n\}/.exec(script);
check(!!crit && /\$h -eq \[IntPtr\]::Zero\) \{ return \$true/.test(crit[1]),
  "a process we cannot open is treated as CRITICAL — unreadable means unsafe, not safe");
check(!!crit && /if \(-not \$ok\) \{ return \$true \}/.test(crit[1]),
  "a failed IsProcessCritical query is treated as CRITICAL");
const failure = /function Test-OwllmRebootOnFailure \{([\s\S]*?)\n\}/.exec(script);
check(!!failure && /return \$true/.test(failure[1]),
  "an unreadable failure-action config is treated as REBOOT-on-failure");
const rebootAction = /function Test-OwllmRebootAction \{([\s\S]*?)\n\}/.exec(script);
check(!!rebootAction, "the failure-action parse is a pure function the gate can drive with captured text");
check(rebootAction[1].includes("IndexOf('FAILURE_ACTIONS')") && rebootAction[1].includes("\\bREBOOT\\b"),
  "only the ACTION list decides — every sc dump carries a REBOOT_MESSAGE label, and matching it made the guard refuse every reclaim");

// Graceful first, always; terminate only after the full grace window.
const graceAt = script.indexOf("$obj.WaitForStatus('Stopped'");
const killAt = script.indexOf("Stop-Process -Id $target -Force");
check(graceAt > 0 && killAt > graceAt,
  "the service is asked to stop gracefully BEFORE any terminate — the terminate exists only for the wedge");
check(/if \(\$obj\.Status -ne 'Stopped'\) \{[\s\S]*?if \(\$current -eq \$target\) \{\n\s*Stop-Process -Id \$target -Force/.test(script),
  "the terminate is reachable ONLY when the graceful stop missed its grace window");
check(/\$current = \(Get-CimInstance Win32_Service -Filter "Name='\$name'"\)\.ProcessId/.test(script) &&
      script.indexOf("$current = (Get-CimInstance") < killAt,
  "the pid is re-read against the service before terminating — a recycled pid must never be killed in its place");
check((script.match(/Stop-Process/g) || []).length === 1,
  "there is exactly one terminate in the whole guard");
check(/const GRACE_SECONDS: u32 = 45;/.test(guard),
  "the grace window is a real wait (45s) — long enough that a healthy service always stops cleanly");

// -Force may lower the bar; it must never skip the safety triad.
check(script.includes("if ($Force) { $threshold = 1 }"),
  "-Force lowers the threshold only");
check(!/\$Force[^\n]*(Stop-Process|Stop-Service|\$obj\.Stop)/.test(script),
  "no code path lets -Force reach a stop without going through the verdict");
check(/if \(\$verdict -ne 'reclaim'\) \{/.test(script),
  "anything that is not a 'reclaim' verdict continues without touching the service");

// The guard must leave evidence that it RAN, not just that it is installed.
check(script.includes("function Write-OwllmGuardLog") && script.includes("Write-OwllmGuardLog \"$name verdict=$verdict private=$private method=$method"),
  "every reclaim is logged with its verdict, size and method — an installed-but-never-run guard is visible as such");
check(/if \(\$all\.Count -gt 40\)/.test(script),
  "the guard's own log is bounded — a janitor must not become a producer");

// ------------------------------------------------------- the scheduled task
const xml = rawStr("TASK_XML");
check(xml.includes("<UserId>S-1-5-18</UserId>"),
  "the task runs as SYSTEM — the only principal permitted to stop these services");
check(xml.includes("<RunLevel>HighestAvailable</RunLevel>"),
  "the task runs with highest privileges, so it never needs a prompt");
check(/<Repetition><Interval>__INTERVAL__<\/Interval><StopAtDurationEnd>false<\/StopAtDurationEnd><\/Repetition>/.test(xml),
  "the task REPEATS indefinitely — a one-shot task would guard exactly once");
check(/const GUARD_INTERVAL: &str = "PT(\d+)H";/.test(guard),
  "the repetition interval is a real hours value");
check(xml.includes("<BootTrigger>"),
  "the guard also runs after a reboot, so a machine that is rarely up still gets swept");
check(xml.includes("<Enabled>true</Enabled>") && xml.includes("<StartWhenAvailable>true</StartWhenAvailable>"),
  "a missed run is caught up rather than skipped forever");

// The SYSTEM task executes a file on disk: that file must not be user-writable.
const install = rawStr("INSTALL_SCRIPT");
check(install.includes("/inheritance:r"),
  "the guard directory drops inherited ACLs before granting anything");
check(install.includes("'*S-1-5-32-545:(OI)(CI)RX'"),
  "Users get READ+EXECUTE on the guard directory");
check(!/545:\(OI\)\(CI\)(F|M|W)/.test(install),
  "Users NEVER get write on the directory the SYSTEM task executes from — that would be a privilege-escalation path");
check(install.includes("'*S-1-5-18:(OI)(CI)F'") && install.includes("'*S-1-5-32-544:(OI)(CI)F'"),
  "SYSTEM and Administrators keep full control (SIDs, not locale-dependent names)");

// The registered task must be readable by the non-elevated app. Measured DACL
// straight from Register-ScheduledTask, twice, from a clean state:
// `D:(A;ID;0x1f019f;;;BA)(A;ID;0x1f019f;;;SY)(A;ID;FA;;;BA)(A;;FR;;;SY)` —
// admins and SYSTEM, nobody else. Without the grant below the app's own status
// read reports "not installed" forever, which is how this was nearly shipped.
const registerAt = install.indexOf("Register-ScheduledTask");
check(install.includes("SetSecurityDescriptor('__SDDL__', 0)") && install.indexOf("SetSecurityDescriptor") > registerAt,
  "the task's DACL is set after registration — a default-DACL task is invisible to the non-elevated app that must read it");
const sddl = /const TASK_SDDL: &str = "([^"]+)";/.exec(guard);
check(!!sddl && /\(A;;FR;;;BU\)/.test(sddl[1]),
  "built-in Users are granted READ on the task, so status reads never lie about it being installed");
check(!!sddl && !/\(A;;(FA|FX|FRFX|GA|GW)[^)]*;BU\)/.test(sddl[1]),
  "Users get READ only — never write or execute on a task that runs as SYSTEM");
check(!!sddl && /\(A;;FA;;;BA\)/.test(sddl[1]) && /\(A;;FA;;;SY\)/.test(sddl[1]),
  "Administrators and SYSTEM keep full control of the task");

// Every placeholder must actually be substituted. An unsubstituted one is not
// a cosmetic slip: `GetTask('__TASK__')` fails with 0x80070002 and the guard
// installs with a default DACL, silently.
for (const [name, text] of [["GUARD_SCRIPT", script], ["TASK_XML", xml], ["INSTALL_SCRIPT", install]]) {
  const placeholders = [...new Set((text.match(/__[A-Z_]+__/g) || []))];
  check(placeholders.length > 0, `${name} has placeholders the gate can account for`);
  for (const ph of placeholders) {
    check(guard.includes(`.replace("${ph}"`) || guard.includes(`.replace(/${ph}/g`),
      `${name}'s ${ph} is substituted before the script is written`);
  }
}

// Install is self-verifying: the helper's exit code is not the claim.
const installImpl = bodyOf(guard, "fn install_impl()");
check(installImpl.includes("if !status.guard_installed"),
  "install re-queries the task afterwards — an approved UAC that registered nothing must report failure");
check(bodyOf(guard, "fn task_installed()").includes("schtasks /Query"),
  "installed-ness is answered by asking the OS, never by a local sentinel file");
check(/catch \{\s*Set-Content -LiteralPath \$result -Value \("ERR " \+ \$_\.Exception\.Message\)/.test(install),
  "the elevated helper writes WHY it failed — its console is gone before anyone could read it");
check(installImpl.includes(`strip_prefix("ERR ")`),
  "install surfaces the helper's own reason instead of a generic failure");
check(bodyOf(guard, "fn run_elevated(").includes("-PassThru") &&
      bodyOf(guard, "fn run_elevated(").includes("exit $p.ExitCode"),
  "the elevated child's exit code is propagated — without it a helper that failed every step still reports success");

// ---------------------------------------------------- wiring, and no hostage
check(/^\s*crate::host_guard::auto_note\(\);/m.test(fleet),
  "the janitor pass actually calls the host-service check — an unwired guard reports nothing");
const note = bodyOf(guard, "pub(crate) fn auto_note()");
check(note.length > 0 && !/run_elevated|install_impl|reclaim_now_impl|RunAs/.test(note),
  "the background janitor NEVER elevates — it reports; the installed task does the work");
check(/^mod host_guard;/m.test(lib), "the module is declared");
for (const cmd of ["host_guard_status", "host_guard_install", "host_guard_remove", "host_guard_reclaim_now"]) {
  check(lib.includes(`host_guard::${cmd},`), `${cmd} is registered — an unregistered command is a dead button`);
}
check((guard.match(/#\[serde\(rename_all = "camelCase"\)\]/g) || []).length >= 2,
  "both wire structs are pinned to camelCase");
check(info.includes("<HostGuardCard />") && info.includes('import HostGuardCard from "./HostGuardCard"'),
  "the card is mounted on the Info page — the one-time consent has somewhere to be given");
for (const key of ["guardInstalled", "overThreshold", "thresholdBytes", "privateBytes", "lastRuns"]) {
  check(card.includes(key), `the card reads the camelCase wire key ${key}`);
  check(!card.includes(key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)),
    `the card never reads the snake_case spelling of ${key} (the dead-fallback bug class)`);
}
check(card.includes("if (status && !status.supported) return null;"),
  "the card hides itself where there is no such service — macOS and Linux see nothing");

// -------------------------------------------- the verdict function, EXECUTED
// Static reading proves the tests are present; only running them proves they
// decide correctly. The shipped function text is extracted and exercised
// against a truth table, then the WHOLE shipped script is run against a
// threshold no process can reach — so every probe (CIM, tenant count, critical
// check, failure-action check) executes for real with no side effect.
if (process.platform !== "win32") {
  console.log("… skipped: the guard is Windows-only, and this host is " + process.platform +
    " (the static contract above still ran; the behavioural half runs on the Windows release host)");
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-hostguard-"));
  try {
    // 1) the verdict truth table
    const cases = [
      ["below-threshold", "-PrivateBytes 10 -ThresholdBytes 100 -TenantCount 1 -IsCritical $false -RebootOnFailure $false"],
      ["unsafe-no-threshold", "-PrivateBytes 10 -ThresholdBytes 0 -TenantCount 1 -IsCritical $false -RebootOnFailure $false"],
      ["unsafe-shared-host", "-PrivateBytes 200 -ThresholdBytes 100 -TenantCount 2 -IsCritical $false -RebootOnFailure $false"],
      ["unsafe-critical-process", "-PrivateBytes 200 -ThresholdBytes 100 -TenantCount 1 -IsCritical $true -RebootOnFailure $false"],
      ["unsafe-reboot-on-failure", "-PrivateBytes 200 -ThresholdBytes 100 -TenantCount 1 -IsCritical $false -RebootOnFailure $true"],
      ["reclaim", "-PrivateBytes 200 -ThresholdBytes 100 -TenantCount 1 -IsCritical $false -RebootOnFailure $false"],
    ];
    const truthTable = [
      `function Get-OwllmLeakVerdict {${verdict[1]}\n}`,
      ...cases.map(([, args], i) => `Write-Output "CASE${i}=$(Get-OwllmLeakVerdict ${args})"`),
    ].join("\n");
    const tPath = path.join(dir, "verdict.ps1");
    fs.writeFileSync(tPath, truthTable, "utf8");
    const tOut = execFileSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", tPath],
      { encoding: "utf8" });
    cases.forEach(([want], i) => {
      check(tOut.includes(`CASE${i}=${want}`),
        `the SHIPPED verdict function, executed: ${want} for ${cases[i][1].replace(/-\w+ /g, "").trim()}`);
    });

    // 1b) the failure-action parse, against REAL `sc qfailure` text. The
    //     RESTART sample is a verbatim capture from a Windows 10 host; the
    //     REBOOT_MESSAGE-set case is the exact false positive that made a
    //     forced reclaim answer 'unsafe-reboot-on-failure' for a service
    //     configured to RESTART.
    const scRestart = [
      "[SC] QueryServiceConfig2 SUCCESS", "",
      "SERVICE_NAME: PcaSvc",
      "        RESET_PERIOD (in seconds)    : 86400",
      "        REBOOT_MESSAGE               : ",
      "        COMMAND_LINE                 : ",
      "        FAILURE_ACTIONS              : RESTART -- Delay = 60000 milliseconds.",
      "                                       RESTART -- Delay = 60000 milliseconds.",
    ].join("\n");
    const scLabelSet = scRestart.replace("REBOOT_MESSAGE               : ", "REBOOT_MESSAGE               : the machine will REBOOT");
    const scReboot = scRestart + "\n                                       REBOOT -- Delay = 120000 milliseconds.";
    const rebootCases = [
      ["False", scRestart, "a RESTART-only service is safe to reclaim"],
      ["False", scLabelSet, "a populated REBOOT_MESSAGE label does NOT make a RESTART service unsafe"],
      ["True", scReboot, "a service with a REBOOT action is refused"],
      ["True", "", "empty sc output is refused"],
      ["True", "SERVICE_NAME: X\n  RESET_PERIOD : 1", "output without an action list is refused"],
    ];
    const rPath = path.join(dir, "reboot.ps1");
    fs.writeFileSync(rPath, [
      `function Test-OwllmRebootAction {${rebootAction[1]}\n}`,
      ...rebootCases.map(([, text], i) =>
        `Write-Output "RCASE${i}=$(Test-OwllmRebootAction -QfailureText @'\n${text}\n'@)"`),
    ].join("\n"), "utf8");
    const rOut = execFileSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", rPath],
      { encoding: "utf8" });
    rebootCases.forEach(([want, , why], i) => {
      check(rOut.includes(`RCASE${i}=${want}`), `the SHIPPED failure-action parse, executed: ${why}`);
    });

    // 2) the whole shipped script, on the REAL registry, against a threshold
    //    no process can reach. Real rows and not a synthetic list, because the
    //    row list is the part that can degenerate: `@(@('a',1))` flattens in
    //    PowerShell, so a one-row registry once iterated over 'P' and a number
    //    instead of over the row — and a two-row test could not see it.
    const UNREACHABLE = "9223372036854775807";
    const logPath = path.join(dir, "leak-guard.log");
    const runScript = (rowText, file) => {
      const body = script
        .replace("__SERVICES__", rowText)
        .replace("__GRACE__", "45")
        .replace(/__LOG__/g, logPath.replace(/\\/g, "\\\\"));
      const p = path.join(dir, file);
      fs.writeFileSync(p, body, "utf8");
      return execFileSync("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", p],
        { encoding: "utf8" });
    };
    const rowLiteral = (name, threshold) => `[pscustomobject]@{Name='${name}';Threshold=${threshold}}`;
    check(guard.includes("[pscustomobject]@{{Name='{name}';Threshold={threshold}}}"),
      "the registry is emitted as objects — the one shape that cannot flatten for a single-row registry");

    const realOut = runScript(rows.map(([n]) => rowLiteral(n, UNREACHABLE)).join(", "), "guard-real.ps1");
    for (const [name] of rows) {
      check(new RegExp(`OWLLM_GUARD=${name}\\|(below-threshold|not-running)\\|none\\|0`).test(realOut),
        `the SHIPPED guard script, run on the REAL registry, reports a verdict for ${name}`);
    }
    const fakeOut = runScript(rowLiteral("OwllmNoSuchService", UNREACHABLE), "guard-fake.ps1");
    check(/OWLLM_GUARD=OwllmNoSuchService\|not-running\|none\|0/.test(fakeOut),
      "a service that does not exist on this machine is reported, never assumed");
    check(!/Stop-Process|Stop-Service/.test(realOut + fakeOut) && !fs.existsSync(logPath),
      "nothing was stopped and nothing was logged — a service under its threshold is genuinely untouched");
  } catch (e) {
    // A failed check() must keep its own message — re-labelling it as a
    // "behavioural failure" would hide which contract actually broke.
    if (String(e?.message ?? "").startsWith("FAIL ")) throw e;
    const detail = String(e?.stderr ?? e?.message ?? e).split("\n").slice(0, 12).join("\n");
    check(false, `the shipped guard failed its behavioural check:\n${detail}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
}

console.log(`\nall checks passed (${passed})`);
