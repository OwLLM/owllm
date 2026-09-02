$ErrorActionPreference = 'Stop'

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$resultRoot = Join-Path $env:SystemRoot "Temp\OwLLM-BcdRepair-$stamp"
$logPath = Join-Path $resultRoot 'repair.log'
$statusPath = Join-Path $resultRoot 'status.txt'
$efiDrive = 'S:'

New-Item -ItemType Directory -Path $resultRoot -Force | Out-Null
Start-Transcript -Path $logPath -Force | Out-Null

function Set-RepairStatus {
  param([string]$Value)
  Set-Content -LiteralPath $statusPath -Value $Value -Encoding ASCII
}

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
  )
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE"
  }
}

Set-RepairStatus 'STARTED'
$mountedHere = $false

try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]$identity
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'The repair was not elevated.'
  }

  $bitLockerText = (& manage-bde.exe -status C: 2>&1 | Out-String)
  $bitLockerText | Set-Content -LiteralPath (Join-Path $resultRoot 'bitlocker-before.txt') -Encoding UTF8
  if ($bitLockerText -match 'Protection Status:\s+Protection On') {
    Set-RepairStatus 'ABORTED_BITLOCKER_PROTECTION_ON'
    throw 'BitLocker protection is active. Repair aborted to avoid an unverified recovery-key prompt.'
  }

  if (Test-Path -LiteralPath "$efiDrive\") {
    throw "$efiDrive is already in use; refusing to mount over it."
  }

  Invoke-Native mountvol.exe $efiDrive /S
  $mountedHere = $true
  $bcdPath = "$efiDrive\EFI\Microsoft\Boot\BCD"
  if (-not (Test-Path -LiteralPath $bcdPath)) {
    throw "EFI BCD store was not found at $bcdPath"
  }

  Copy-Item -LiteralPath $bcdPath -Destination (Join-Path $resultRoot 'BCD.original') -Force
  Invoke-Native bcdedit.exe /store $bcdPath /enum all /v *> (Join-Path $resultRoot 'bcd-before.txt')

  $preExport = Join-Path $resultRoot 'BCD.pre-export'
  & bcdedit.exe /export $preExport *> (Join-Path $resultRoot 'export-before.txt')
  $preExportExit = $LASTEXITCODE
  "Pre-repair BCD export exit code: $preExportExit" | Write-Output

  $efiBackupPath = "$bcdPath.owllm-backup-$stamp"
  Move-Item -LiteralPath $bcdPath -Destination $efiBackupPath -Force
  try {
    Invoke-Native bcdboot.exe "$env:SystemRoot" /s $efiDrive /f UEFI /v
  } catch {
    if (Test-Path -LiteralPath $bcdPath) {
      Remove-Item -LiteralPath $bcdPath -Force
    }
    Move-Item -LiteralPath $efiBackupPath -Destination $bcdPath -Force
    throw
  }

  Invoke-Native bcdedit.exe /store $bcdPath /enum all /v *> (Join-Path $resultRoot 'bcd-after.txt')
  $postExport = Join-Path $resultRoot 'BCD.post-export'
  Invoke-Native bcdedit.exe /export $postExport *> (Join-Path $resultRoot 'export-after.txt')

  $originalHash = (Get-FileHash -LiteralPath (Join-Path $resultRoot 'BCD.original') -Algorithm SHA256).Hash
  $backupHash = (Get-FileHash -LiteralPath $efiBackupPath -Algorithm SHA256).Hash
  $newHash = (Get-FileHash -LiteralPath $bcdPath -Algorithm SHA256).Hash
  if ($originalHash -ne $backupHash) {
    throw 'The preserved EFI BCD backup hash does not match the original.'
  }

  @(
    "ResultRoot=$resultRoot"
    "PreExportExit=$preExportExit"
    "OriginalBackupSHA256=$originalHash"
    "NewBcdSHA256=$newHash"
    "EfiBackup=$efiBackupPath"
  ) | Set-Content -LiteralPath (Join-Path $resultRoot 'summary.txt') -Encoding UTF8
  Set-RepairStatus 'SUCCESS'
} catch {
  $_ | Out-String | Set-Content -LiteralPath (Join-Path $resultRoot 'error.txt') -Encoding UTF8
  if ((Get-Content -LiteralPath $statusPath -ErrorAction SilentlyContinue) -eq 'STARTED') {
    Set-RepairStatus 'FAILED'
  }
  throw
} finally {
  if ($mountedHere) {
    & mountvol.exe $efiDrive /D | Out-Null
  }
  Stop-Transcript | Out-Null
}
