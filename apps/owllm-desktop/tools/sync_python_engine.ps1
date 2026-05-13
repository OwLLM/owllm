param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
)

$ErrorActionPreference = "Stop"

$srcRoot = Join-Path $RepoRoot "LLM"
$dstRoot = Join-Path $RepoRoot "apps\owllm-desktop\python_engine\LLM"

Write-Host "Syncing python_engine subset:"
Write-Host "  from: $srcRoot"
Write-Host "    to: $dstRoot"

New-Item -ItemType Directory -Force -Path $dstRoot | Out-Null

$copyDirs = @(
  "configs",
  "constraints",
  "core",
  "metadata",
  "scripts",
  "tool_server",
  "tools",
  "data",
  "db",
  "runtime",
  "bootstrap",
  "environments",
  "profiles",
  "logs",
  "tests"
)

foreach ($d in $copyDirs) {
  $s = Join-Path $srcRoot $d
  if (Test-Path $s) {
    robocopy $s (Join-Path $dstRoot $d) /E /MT:16 /R:1 /W:1 | Out-Null
  }
}

$files = @(
  "system_detector.py",
  "setup_state.py",
  "model_integrity_checker.py",
  "installer_v2.py",
  "pip_worker.py",
  "smart_installer.py",
  "check_dependencies.py",
  "check_install_state.py",
  "sitecustomize.py"
)

foreach ($f in $files) {
  $p = Join-Path $srcRoot $f
  if (Test-Path $p) {
    Copy-Item -Force $p (Join-Path $dstRoot $f)
  }
}

# Junction large / mutable dirs to the canonical LLM tree (no multi-GB duplication).
$junctions = @(
  "models",
  "wheelhouse",
  ".envs",
  "hf_cache",
  "cache",
  "fine_tuned",
  "test_output",
  "unsloth_compiled_cache"
)

foreach ($j in $junctions) {
  $s = Join-Path $srcRoot $j
  $t = Join-Path $dstRoot $j
  if ((Test-Path $s) -and -not (Test-Path $t)) {
    cmd /c mklink /J "$t" "$s" | Out-Null
  }
}

Write-Host "Done."
