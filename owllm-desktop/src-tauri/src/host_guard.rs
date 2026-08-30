//! Host services this app's workload makes leak — bounded on a schedule.
//!
//! The disk janitor (`fleet::spawn_global_disk_janitor`) owns everything OwLLM
//! WRITES. This owns the other half of the same problem: memory a *Windows*
//! service leaks because of what OwLLM DOES. Measured on a 14-day session
//! (2026-08-26): `svchost.exe` hosting `PcaSvc` — the Program Compatibility
//! Assistant — held **2,994 MB of private bytes backing 1 MB of on-disk data**,
//! more than 3x the next consumer on the machine and ~40% of the free RAM. It
//! grows with the PROCESS-CREATION rate, and an agent machine creates processes
//! by the thousand (a CLI per turn, plus cargo/rustc/npm/node/git/wsl per
//! build). Restarting the service returned it to 3.9 MB private doing the same
//! job — leak, not workload.
//!
//! Three facts decided the design, each measured rather than assumed:
//!
//! * **A normal user cannot stop it.** `sc sdshow PcaSvc` grants Interactive
//!   Users `RP` (start) but not `WP` (stop); only `BA` may stop it. So the
//!   reclaim needs admin — and a background janitor must never throw a UAC
//!   prompt at someone mid-turn. The guard is therefore installed ONCE, with
//!   one consent, as a SYSTEM scheduled task that then runs unattended forever.
//! * **The graceful stop wedges once bloated.** `Stop-Service` reached
//!   STOP_PENDING, unwound 42 threads to 10, and then sat with its checkpoint
//!   frozen for 8 minutes — the leak breaks its own shutdown path. So the
//!   guard escalates to terminating the process, but only behind a safety
//!   triad, and never before a graceful attempt has been given its full grace
//!   window.
//! * **Terminating is reversible here, and provably so.** `PcaSvc` was the
//!   SOLE tenant of its svchost pid, `IsProcessCritical` was false, and its
//!   failure action is RESTART (not REBOOT) — so the SCM brings it back with a
//!   fresh heap. Those are exactly the three conditions the guard re-checks at
//!   run time; any one unreadable is treated as unsafe and the service is left
//!   alone. Task Manager's "abandon unsaved data and shut down" dialog is that
//!   app's blanket warning for `svchost.exe`, not a kernel critical flag.
//!
//! Non-Windows builds compile to no-ops: there is no equivalent service, and
//! the card hides itself when `supported` is false.

use serde::Serialize;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Every host service known to leak under this app's workload, paired with the
/// footprint at which reclaiming it is worth more than leaving it alone.
/// Format: (service name, what it is, private-bytes threshold).
///
/// The release gate parses this table: a row must name a service in
/// `[A-Za-z0-9_]` (it is interpolated into a WMI filter) and carry a threshold
/// that is neither zero nor unbounded, so a future row cannot smuggle in
/// "restart anything, always".
pub(crate) const LEAKY_SERVICES: &[(&str, &str, u64)] = &[(
    "PcaSvc",
    "Program Compatibility Assistant — leaks with the process-creation rate",
    1024 * 1024 * 1024,
)];

/// How long the guard waits for a clean `Stop-Service` before it escalates.
/// Generous enough that a healthy service always stops gracefully; short
/// enough that a wedged one (measured: still pending after 8 minutes) is not
/// waited on forever.
const GRACE_SECONDS: u32 = 45;

/// The task re-checks this often. The leak needs days to reach the threshold,
/// so a 6-hour beat reclaims it long before it is felt while costing nothing.
const GUARD_INTERVAL: &str = "PT6H";

const TASK_FOLDER: &str = "OwLLM";
const TASK_PATH: &str = "\\OwLLM\\";
const TASK_NAME: &str = "Leaky host services";

/// A task registered by an admin is readable by admins only — the measured
/// DACL was `BA` + `SY` and nothing else, so the non-elevated app could never
/// see its own guard and every status read reported "not installed". Built-in
/// Users are granted READ, and deliberately not execute: triggering a reclaim
/// stays an explicit, elevated act.
#[cfg(windows)]
const TASK_SDDL: &str = "D:(A;;FA;;;BA)(A;;FA;;;SY)(A;;FR;;;BU)";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeakyService {
    pub name: String,
    pub label: String,
    pub threshold_bytes: u64,
    pub private_bytes: u64,
    pub pid: u32,
    pub over_threshold: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostGuardStatus {
    /// False on non-Windows — the card hides rather than showing empty rows.
    pub supported: bool,
    pub guard_installed: bool,
    pub services: Vec<LeakyService>,
    /// Tail of the guard's own log, so "it is installed" can be told apart
    /// from "it has actually run". None until the task has run once.
    pub last_runs: Vec<String>,
}

// ---------------------------------------------------------------- the guard
//
// One script, two callers: the SYSTEM scheduled task (unattended, threshold
// enforced) and the card's "Reclaim now" button (elevated on the spot, -Force).
// `Get-OwllmLeakVerdict` is the SINGLE place a reclaim is authorised, and
// -Force may only lower the threshold — it can never skip the safety triad.

/// `__SERVICES__` (the registry as PowerShell objects), `__GRACE__` and
/// `__LOG__` are substituted before the script is written.
#[cfg(windows)]
const GUARD_SCRIPT: &str = r#"param([switch]$Force)
$ErrorActionPreference = 'SilentlyContinue'
$grace = __GRACE__
$log   = '__LOG__'

# The ONE place that authorises a reclaim. Everything it can't read counts
# against reclaiming, never for it.
function Get-OwllmLeakVerdict {
  param([long]$PrivateBytes, [long]$ThresholdBytes,
        [int]$TenantCount, [bool]$IsCritical, [bool]$RebootOnFailure)
  if ($ThresholdBytes -le 0)             { return 'unsafe-no-threshold' }
  if ($PrivateBytes -lt $ThresholdBytes) { return 'below-threshold' }
  if ($TenantCount -ne 1)                { return 'unsafe-shared-host' }
  if ($IsCritical)                       { return 'unsafe-critical-process' }
  if ($RebootOnFailure)                  { return 'unsafe-reboot-on-failure' }
  return 'reclaim'
}

Add-Type -Namespace Owllm -Name Crit -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)]
public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool IsProcessCritical(IntPtr h, out bool critical);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool CloseHandle(IntPtr h);
'@

function Test-OwllmProcessCritical {
  param([int]$TargetPid)
  $h = [Owllm.Crit]::OpenProcess(0x1000, $false, $TargetPid)   # QUERY_LIMITED_INFORMATION
  if ($h -eq [IntPtr]::Zero) { return $true }                  # unreadable -> unsafe
  $crit = $false
  $ok = [Owllm.Crit]::IsProcessCritical($h, [ref]$crit)
  [void][Owllm.Crit]::CloseHandle($h)
  if (-not $ok) { return $true }
  return [bool]$crit
}

# Pure so it can be driven with captured `sc qfailure` text. Only the ACTION
# list may decide: every dump contains a REBOOT_MESSAGE *label*, so matching
# REBOOT anywhere in the output made the guard refuse every reclaim forever.
function Test-OwllmRebootAction {
  param([string]$QfailureText)
  if (-not $QfailureText) { return $true }                     # unreadable -> unsafe
  $i = $QfailureText.IndexOf('FAILURE_ACTIONS')
  if ($i -lt 0) { return $true }                               # unreadable -> unsafe
  return ($QfailureText.Substring($i) -match '\bREBOOT\b')
}

function Test-OwllmRebootOnFailure {
  param([string]$Service)
  $out = & sc.exe qfailure $Service 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $out) { return $true }      # unreadable -> unsafe
  return (Test-OwllmRebootAction -QfailureText ([string]::Join("`n", $out)))
}

function Write-OwllmGuardLog {
  param([string]$Line)
  $dir = Split-Path -Parent $log
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  Add-Content -LiteralPath $log -Value "$stamp $Line"
  $all = @(Get-Content -LiteralPath $log)
  if ($all.Count -gt 40) { Set-Content -LiteralPath $log -Value ($all | Select-Object -Last 40) }
}

# Objects, not nested arrays: `@(@('a',1))` FLATTENS in PowerShell, so a
# one-row registry would iterate over 'a' and 1 instead of over the row.
foreach ($row in @(__SERVICES__)) {
  $name = $row.Name
  $threshold = [long]$row.Threshold
  if ($Force) { $threshold = 1 }   # lowers the bar; the safety triad still runs

  $svc = Get-CimInstance Win32_Service -Filter "Name='$name'"
  if (-not $svc -or -not $svc.ProcessId) {
    Write-Output "OWLLM_GUARD=$name|not-running|none|0"
    continue
  }
  $target = [int]$svc.ProcessId
  $proc = Get-Process -Id $target
  if (-not $proc) { Write-Output "OWLLM_GUARD=$name|not-running|none|0"; continue }
  $private = [long]$proc.PrivateMemorySize64
  $tenants = @(Get-CimInstance Win32_Service -Filter "ProcessId=$target").Count

  $verdict = Get-OwllmLeakVerdict -PrivateBytes $private -ThresholdBytes $threshold `
    -TenantCount $tenants -IsCritical (Test-OwllmProcessCritical -TargetPid $target) `
    -RebootOnFailure (Test-OwllmRebootOnFailure -Service $name)

  if ($verdict -ne 'reclaim') {
    Write-Output "OWLLM_GUARD=$name|$verdict|none|0"
    if ($verdict -like 'unsafe-*') { Write-OwllmGuardLog "$name verdict=$verdict private=$private" }
    continue
  }

  # Graceful first, ALWAYS. Only a stop that misses its full grace window is
  # escalated -- that is the wedge this guard exists for.
  $method = 'graceful'
  $obj = Get-Service -Name $name
  try {
    $obj.Stop()
    $obj.WaitForStatus('Stopped', (New-TimeSpan -Seconds $grace))
  } catch { }
  $obj.Refresh()
  if ($obj.Status -ne 'Stopped') {
    # Re-read the pid: if the service moved (or the graceful stop finally took
    # and something else inherited the number), the pid we measured is no
    # longer this service and must not be terminated.
    $current = (Get-CimInstance Win32_Service -Filter "Name='$name'").ProcessId
    if ($current -eq $target) {
      Stop-Process -Id $target -Force
      $method = 'terminated'
      for ($i = 0; $i -lt 30 -and $obj.Status -ne 'Stopped'; $i++) { Start-Sleep -Seconds 1; $obj.Refresh() }
    } else {
      $method = 'pid-changed'
    }
  }
  $freed = if ($obj.Status -eq 'Stopped') { $private } else { 0 }
  Write-Output "OWLLM_GUARD=$name|$verdict|$method|$freed"
  Write-OwllmGuardLog "$name verdict=$verdict private=$private method=$method freed=$freed status=$($obj.Status)"
}
"#;

/// Registers the task. Runs ELEVATED (one UAC). Placeholders `__DIR__`,
/// `__SCRIPT__`, `__SRC__`, `__XML__`, `__RESULT__` are substituted before it
/// is written. The guard script is copied into a directory ACL'd to admins
/// only, so the SYSTEM task can never be made to execute something a normal
/// user rewrote. Whatever it fails on is written to `__RESULT__` — an elevated
/// child's console is gone by the time anyone could read it.
#[cfg(windows)]
const INSTALL_SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
$result = '__RESULT__'
try {
  $dir = '__DIR__'
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  # SIDs, not names: locale-independent. SYSTEM + Administrators full, Users read.
  & icacls $dir /inheritance:r /grant '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
  Copy-Item -LiteralPath '__SRC__' -Destination '__SCRIPT__' -Force
  $xml = Get-Content -Raw -LiteralPath '__XML__'

  Register-ScheduledTask -TaskName '__TASK__' -TaskPath '__PATH__' -Xml $xml -Force | Out-Null
  # ...which leaves it admin-readable ONLY. GetFolder wants the folder path
  # WITHOUT a trailing separator; '\OwLLM\' raises 0x80070002.
  $svc = New-Object -ComObject Schedule.Service
  $svc.Connect()
  $svc.GetFolder('\__FOLDER__').GetTask('__TASK__').SetSecurityDescriptor('__SDDL__', 0)

  Set-Content -LiteralPath $result -Value 'OK'
  exit 0
} catch {
  Set-Content -LiteralPath $result -Value ("ERR " + $_.Exception.Message)
  exit 1
}
"#;

/// The task definition. Raw XML rather than the ScheduledTasks cmdlets: an
/// indefinite repetition is expressed exactly here, where `-RepetitionDuration`
/// differs between PowerShell builds. Runs as SYSTEM (`S-1-5-18`) because only
/// an admin principal may stop the service at all.
#[cfg(windows)]
const TASK_XML: &str = r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>OwLLM: reclaim host services that leak under an agent workload (see host_guard.rs).</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger><Enabled>true</Enabled></BootTrigger>
    <TimeTrigger>
      <StartBoundary>2026-01-01T03:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition><Interval>__INTERVAL__</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "__SCRIPT__"</Arguments>
    </Exec>
  </Actions>
</Task>
"#;

#[cfg(windows)]
fn guard_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into()))
        .join("OwLLM")
        .join("hostguard")
}

#[cfg(windows)]
fn guard_script_path() -> std::path::PathBuf {
    guard_dir().join("leak-guard.ps1")
}

#[cfg(windows)]
fn guard_log_path() -> std::path::PathBuf {
    guard_dir().join("leak-guard.log")
}

/// The guard script with this build's registry, grace window and log path
/// baked in. One source of truth: the same text the task runs is the text
/// "Reclaim now" runs.
#[cfg(windows)]
fn guard_script_body() -> String {
    let rows = LEAKY_SERVICES
        .iter()
        .map(|(name, _, threshold)| {
            format!("[pscustomobject]@{{Name='{name}';Threshold={threshold}}}")
        })
        .collect::<Vec<_>>()
        .join(", ");
    GUARD_SCRIPT
        .replace("__SERVICES__", &rows)
        .replace("__GRACE__", &GRACE_SECONDS.to_string())
        .replace("__LOG__", &guard_log_path().to_string_lossy())
}

#[cfg(windows)]
fn powershell(args: &[&str]) -> Result<std::process::Output, String> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive"])
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("powershell: {e}"))
}

/// Is the scheduled task registered? Query only — a standard user may read the
/// task even though it runs as SYSTEM.
#[cfg(windows)]
fn task_installed() -> bool {
    let tn = format!("{TASK_PATH}{TASK_NAME}");
    powershell(&["-Command", &format!("schtasks /Query /TN \"{tn}\" | Out-Null; exit $LASTEXITCODE")])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Read-only probe of every registered service: pid and private bytes.
#[cfg(windows)]
fn probe_services() -> Vec<LeakyService> {
    let names = LEAKY_SERVICES
        .iter()
        .map(|(n, _, _)| format!("'{n}'"))
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        "$ErrorActionPreference='SilentlyContinue'; foreach ($n in @({names})) {{ \
           $s = Get-CimInstance Win32_Service -Filter \"Name='$n'\"; $p2 = 0; $b = 0; \
           if ($s -and $s.ProcessId) {{ $p2 = $s.ProcessId; $pr = Get-Process -Id $p2; if ($pr) {{ $b = $pr.PrivateMemorySize64 }} }} \
           Write-Output \"OWLLM_SVC=$n|$p2|$b\" }}"
    );
    let out = powershell(&["-Command", &script])
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    LEAKY_SERVICES
        .iter()
        .map(|(name, label, threshold)| {
            let (mut pid, mut private_bytes) = (0u32, 0u64);
            for line in out.lines() {
                let Some(rest) = line.trim().strip_prefix("OWLLM_SVC=") else { continue };
                let mut it = rest.split('|');
                if it.next() != Some(*name) {
                    continue;
                }
                pid = it.next().and_then(|v| v.trim().parse().ok()).unwrap_or(0);
                private_bytes = it.next().and_then(|v| v.trim().parse().ok()).unwrap_or(0);
            }
            LeakyService {
                name: (*name).to_string(),
                label: (*label).to_string(),
                threshold_bytes: *threshold,
                private_bytes,
                pid,
                over_threshold: private_bytes >= *threshold,
            }
        })
        .collect()
}

#[cfg(windows)]
fn status_impl() -> HostGuardStatus {
    let last_runs = std::fs::read_to_string(guard_log_path())
        .map(|t| {
            t.lines()
                .rev()
                .take(5)
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        })
        .unwrap_or_default();
    HostGuardStatus {
        supported: true,
        guard_installed: task_installed(),
        services: probe_services(),
        last_runs,
    }
}

#[cfg(not(windows))]
fn status_impl() -> HostGuardStatus {
    HostGuardStatus::default()
}

/// Run a script elevated (one UAC) and wait. Only the wrapper's own path
/// crosses the command line, so nothing in the script needs quoting — the
/// same shape `sandbox::reclaim_disk_impl` uses for the diskpart wrapper.
#[cfg(windows)]
fn run_elevated(path: &std::path::Path) -> Result<(), String> {
    // -PassThru + `exit $p.ExitCode`: without it the OUTER shell reports the
    // success of *launching* the child, so a helper that failed every step
    // still looked like it worked.
    let launch = format!(
        "$p = Start-Process powershell -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','{}'); exit $p.ExitCode",
        path.display()
    );
    let out = powershell(&["-Command", &launch])
        .map_err(|e| format!("launch elevated helper: {e}"))?;
    if !out.status.success() {
        return Err("The admin prompt was declined or the helper failed. Nothing was changed.".into());
    }
    Ok(())
}

#[cfg(windows)]
fn install_impl() -> Result<HostGuardStatus, String> {
    let tmp = std::env::temp_dir();
    let src = tmp.join("owllm_leak_guard.ps1");
    let xml = tmp.join("owllm_leak_guard.xml");
    let setup = tmp.join("owllm_leak_guard_setup.ps1");
    let result = tmp.join("owllm_leak_guard_setup.txt");
    let script = guard_script_path();
    let _ = std::fs::remove_file(&result);

    std::fs::write(&src, guard_script_body()).map_err(|e| format!("write guard script: {e}"))?;
    std::fs::write(
        &xml,
        TASK_XML
            .replace("__INTERVAL__", GUARD_INTERVAL)
            .replace("__SCRIPT__", &script.to_string_lossy()),
    )
    .map_err(|e| format!("write task xml: {e}"))?;
    std::fs::write(
        &setup,
        INSTALL_SCRIPT
            .replace("__DIR__", &guard_dir().to_string_lossy())
            .replace("__SRC__", &src.to_string_lossy())
            .replace("__SCRIPT__", &script.to_string_lossy())
            .replace("__XML__", &xml.to_string_lossy())
            .replace("__RESULT__", &result.to_string_lossy())
            .replace("__SDDL__", TASK_SDDL)
            .replace("__FOLDER__", TASK_FOLDER)
            .replace("__TASK__", TASK_NAME)
            .replace("__PATH__", TASK_PATH),
    )
    .map_err(|e| format!("write setup script: {e}"))?;

    let outcome = run_elevated(&setup);
    // The helper's own reason beats a generic "it failed" — its console is
    // gone the moment it exits, so it writes what broke to a file.
    let reported = std::fs::read_to_string(&result).unwrap_or_default();
    for f in [&src, &xml, &setup, &result] {
        let _ = std::fs::remove_file(f);
    }
    if let Some(detail) = reported.trim().strip_prefix("ERR ") {
        return Err(format!("The guard could not be installed: {detail}"));
    }
    outcome?;

    // Self-verifying: the helper's exit code is not the claim — the task
    // being queryable afterwards is.
    let status = status_impl();
    if !status.guard_installed {
        return Err("The helper ran but the scheduled task is not registered. Nothing is guarding these services.".into());
    }
    Ok(status)
}

#[cfg(windows)]
fn remove_impl() -> Result<HostGuardStatus, String> {
    let setup = std::env::temp_dir().join("owllm_leak_guard_remove.ps1");
    std::fs::write(
        &setup,
        format!(
            "$ErrorActionPreference='SilentlyContinue'\nUnregister-ScheduledTask -TaskName '{TASK_NAME}' -TaskPath '{TASK_PATH}' -Confirm:$false\nexit 0\n"
        ),
    )
    .map_err(|e| format!("write helper: {e}"))?;
    let outcome = run_elevated(&setup);
    let _ = std::fs::remove_file(&setup);
    outcome?;
    Ok(status_impl())
}

/// Reclaim now, without waiting for the task's next beat. `-Force` lowers the
/// threshold only; the safety triad still decides.
#[cfg(windows)]
fn reclaim_now_impl() -> Result<Vec<String>, String> {
    let tmp = std::env::temp_dir();
    let guard = tmp.join("owllm_leak_guard_now_body.ps1");
    let helper = tmp.join("owllm_leak_guard_now.ps1");
    let out = tmp.join("owllm_leak_guard_now.txt");
    let _ = std::fs::remove_file(&out);
    // The elevated child owns its own console, so the wrapper captures the
    // guard's verdicts into a file the caller reads back. The guard script
    // itself is written verbatim — the task and this button run one text.
    std::fs::write(&guard, guard_script_body()).map_err(|e| format!("write guard script: {e}"))?;
    std::fs::write(
        &helper,
        format!(
            "$ErrorActionPreference='SilentlyContinue'\n& '{}' -Force | Set-Content -LiteralPath '{}'\nexit 0\n",
            guard.to_string_lossy(),
            out.to_string_lossy()
        ),
    )
    .map_err(|e| format!("write helper: {e}"))?;
    let outcome = run_elevated(&helper);
    let _ = std::fs::remove_file(&helper);
    let _ = std::fs::remove_file(&guard);
    outcome?;
    let text = std::fs::read_to_string(&out).unwrap_or_default();
    let _ = std::fs::remove_file(&out);
    let verdicts: Vec<String> = text
        .lines()
        .filter_map(|l| l.trim().strip_prefix("OWLLM_GUARD=").map(str::to_string))
        .collect();
    if verdicts.is_empty() {
        return Err("The reclaim helper produced no verdict — nothing was changed.".into());
    }
    Ok(verdicts)
}

#[cfg(not(windows))]
fn install_impl() -> Result<HostGuardStatus, String> {
    Err("host-service guard is Windows-only".into())
}
#[cfg(not(windows))]
fn remove_impl() -> Result<HostGuardStatus, String> {
    Err("host-service guard is Windows-only".into())
}
#[cfg(not(windows))]
fn reclaim_now_impl() -> Result<Vec<String>, String> {
    Err("host-service guard is Windows-only".into())
}

/// One janitor pass: report only. The janitor NEVER elevates — a background
/// sweep that raises a UAC dialog would take the GUI hostage, which is exactly
/// what the installed task exists to avoid. When a service is over its
/// threshold and no guard is registered, say so in the log; the Info card is
/// where the one-time consent is offered.
pub(crate) fn auto_note() {
    #[cfg(windows)]
    {
        let status = status_impl();
        for svc in status.services.iter().filter(|s| s.over_threshold) {
            if status.guard_installed {
                eprintln!(
                    "[owllm] {} holds {} MB — the host-service guard will reclaim it on its next pass",
                    svc.name,
                    svc.private_bytes / (1024 * 1024)
                );
            } else {
                eprintln!(
                    "[owllm] {} holds {} MB and no host-service guard is installed — enable it on the Info page",
                    svc.name,
                    svc.private_bytes / (1024 * 1024)
                );
            }
        }
    }
}

#[tauri::command]
pub async fn host_guard_status() -> HostGuardStatus {
    tokio::task::spawn_blocking(status_impl)
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn host_guard_install() -> Result<HostGuardStatus, String> {
    tokio::task::spawn_blocking(install_impl)
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[tauri::command]
pub async fn host_guard_remove() -> Result<HostGuardStatus, String> {
    tokio::task::spawn_blocking(remove_impl)
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[tauri::command]
pub async fn host_guard_reclaim_now() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(reclaim_now_impl)
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[cfg(test)]
mod tests {
    #[test]
    fn leaky_service_registry_is_well_formed() {
        assert!(!super::LEAKY_SERVICES.is_empty());
        for (name, what, threshold) in super::LEAKY_SERVICES {
            // The name is interpolated into a WMI filter and a task action.
            assert!(name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
            assert!(!what.trim().is_empty());
            // Neither "restart always" nor "never restart".
            assert!(*threshold >= 256 * 1024 * 1024 && *threshold <= 64 * 1024 * 1024 * 1024);
        }
    }
}
