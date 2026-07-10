<#
.SYNOPSIS
  Establish a Certum SimplySign signing session WITHOUT typing the OTP from your
  phone, so the ~2h SimplySign session re-auth stops interrupting every build.

.WHY
  A SimplySign session lasts ~2 hours (fixed -- not configurable, not per-signature).
  Across a day of builds it keeps lapsing, so you re-enter the phone OTP ~10x.
  The QR code you scanned when enrolling SimplySign is a STANDARD otpauth:// TOTP
  seed (HMAC-SHA1, 30s). If that seed is available on this machine, we can generate
  the current 6-digit code ourselves and log in unattended -- the 2h expiry no
  longer matters because the script just re-logs in whenever the cert isn't mounted.

.SECURITY TRADEOFF (read this)
  This puts your 2FA seed on the build machine -- exactly the protection your phone
  was providing. That is the standard indie-dev pattern, but it is YOUR call. Store
  the seed as a machine/user env var or a git-ignored file. NEVER commit it.

.SETUP
  Provide the seed via ONE of:
    $env:CERTUM_OTP_URI    = 'otpauth://totp/...?secret=BASE32&digits=6&period=30'
    $env:CERTUM_OTP_SECRET = 'BASE32SECRET'      # just the secret, if you have it raw
  Optional:
    $env:CERTUM_USERID     = 'your SimplySign card/user id'   # only if the login
                                                              # field isn't pre-filled
    $env:CERTUM_EXE_PATH   = 'C:\...\SimplySignDesktop.exe'   # if auto-detect fails

.VERIFY FIRST (do this before trusting the auto-login)
    powershell -NoProfile -File scripts\Connect-SimplySign.ps1 -CodeOnly
  The printed code MUST match the code shown in your SimplySign phone app at the
  same moment. If it does, the seed is correct and the GUI auto-fill can be trusted.

.PARAMETER Thumbprint
  The Authenticode cert SHA1. When given, the script (a) no-ops if that cert is
  already in the store (still inside the 2h window) and (b) treats "cert appeared
  in the store" as the readiness signal -- so a failed auto-fill FAILS FAST on
  timeout instead of hanging a non-interactive build.

.PARAMETER CodeOnly
  Just print the current TOTP and exit. No launch, no login. For verifying the seed.
#>
[CmdletBinding()]
param(
  [string]$Thumbprint = $env:OWLLM_SIGN_THUMBPRINT,
  [switch]$CodeOnly,
  [int]$TimeoutSec = 120
)

$ErrorActionPreference = 'Stop'

function ConvertFrom-Base32 {
  param([Parameter(Mandatory)][string]$Text)
  $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  $clean = ($Text -replace '=','' -replace '\s','').ToUpper()
  $bits = New-Object System.Text.StringBuilder
  foreach ($ch in $clean.ToCharArray()) {
    $idx = $alphabet.IndexOf($ch)
    if ($idx -lt 0) { continue }   # ignore anything outside the base32 alphabet
    [void]$bits.Append([Convert]::ToString($idx, 2).PadLeft(5, '0'))
  }
  $s = $bits.ToString()
  $bytes = New-Object System.Collections.Generic.List[byte]
  for ($i = 0; ($i + 8) -le $s.Length; $i += 8) {
    [void]$bytes.Add([Convert]::ToByte($s.Substring($i, 8), 2))
  }
  return ,($bytes.ToArray())
}

function Get-Totp {
  param(
    [Parameter(Mandatory)][byte[]]$Key,
    [int]$Digits = 6,
    [int]$Period = 30
  )
  $unix    = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $counter = [int64][Math]::Floor($unix / $Period)
  $msg     = [BitConverter]::GetBytes($counter)
  if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($msg) }   # RFC 4226 = big-endian
  $hmac = New-Object System.Security.Cryptography.HMACSHA1
  try {
    $hmac.Key = $Key
    $hash = $hmac.ComputeHash($msg)
  } finally { $hmac.Dispose() }
  $offset = $hash[$hash.Length - 1] -band 0x0f
  $bin = ((($hash[$offset]     -band 0x7f) -shl 24) -bor
          (($hash[$offset + 1] -band 0xff) -shl 16) -bor
          (($hash[$offset + 2] -band 0xff) -shl 8)  -bor
           ($hash[$offset + 3] -band 0xff))
  $mod = [int64][Math]::Pow(10, $Digits)
  return ([int64]($bin % $mod)).ToString().PadLeft($Digits, '0')
}

function Test-CertMounted {
  param([string]$Tp)
  if (-not $Tp) { return $false }
  $want = ($Tp -replace '\s','').ToUpper()
  return [bool](Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue |
                Where-Object { $_.Thumbprint -eq $want })
}

# --- resolve the seed + TOTP parameters -------------------------------------
$digits = 6; $period = 30; $secret = $null
if ($env:CERTUM_OTP_URI) {
  $uri = $env:CERTUM_OTP_URI
  if ($uri -match '(?i)secret=([A-Za-z2-7=]+)') { $secret = $Matches[1] }
  if ($uri -match '(?i)digits=(\d+)')           { $digits = [int]$Matches[1] }
  if ($uri -match '(?i)period=(\d+)')           { $period = [int]$Matches[1] }
} elseif ($env:CERTUM_OTP_SECRET) {
  $secret = $env:CERTUM_OTP_SECRET
}
if (-not $secret) {
  throw "No TOTP seed: set `$env:CERTUM_OTP_URI (otpauth://...) or `$env:CERTUM_OTP_SECRET. See -?"
}

$code = Get-Totp -Key (ConvertFrom-Base32 $secret) -Digits $digits -Period $period

if ($CodeOnly) {
  Write-Host $code
  Write-Host "(valid for the rest of this 30s window -- compare with your phone to verify the seed)" -ForegroundColor DarkGray
  exit 0
}

# --- idempotent: already inside the 2h window? do nothing -------------------
if ($Thumbprint -and (Test-CertMounted $Thumbprint)) {
  Write-Host "SimplySign cert already mounted ($Thumbprint) -- session still live, nothing to do." -ForegroundColor Green
  exit 0
}

# --- launch SimplySign Desktop + auto-fill the OTP -------------------------
# NOTE: this drives the GUI via SendKeys -- the fragile part. Verify -CodeOnly
# matches your phone first, then confirm the field order below matches YOUR
# SimplySign version once, interactively. If the login field order differs,
# adjust the SendKeys sequence; everything above (the TOTP) is version-independent.
$exe = $env:CERTUM_EXE_PATH
if (-not $exe) {
  $exe = Get-ChildItem -Path "$env:ProgramFiles\Certum","${env:ProgramFiles(x86)}\Certum" `
           -Filter 'SimplySign*.exe' -Recurse -ErrorAction SilentlyContinue |
         Select-Object -First 1 -ExpandProperty FullName
}
if (-not $exe -or -not (Test-Path $exe)) {
  throw "SimplySign Desktop exe not found -- set `$env:CERTUM_EXE_PATH to SimplySignDesktop.exe."
}

Add-Type -AssemblyName System.Windows.Forms
$wshell = New-Object -ComObject WScript.Shell

$proc = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 3
# Bring the login window to the foreground (by PID, then by title as a fallback).
if (-not $wshell.AppActivate($proc.Id)) { [void]$wshell.AppActivate('SimplySign') }
Start-Sleep -Milliseconds 800

if ($env:CERTUM_USERID) {
  [System.Windows.Forms.SendKeys]::SendWait($env:CERTUM_USERID)
  [System.Windows.Forms.SendKeys]::SendWait('{TAB}')
  Start-Sleep -Milliseconds 300
}
[System.Windows.Forms.SendKeys]::SendWait($code)
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')

# --- wait on a REAL readiness signal: the cert showing up in the store ------
if (-not $Thumbprint) {
  Write-Host "OTP submitted. No -Thumbprint given, so readiness can't be verified -- assuming success." -ForegroundColor Yellow
  exit 0
}
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  if (Test-CertMounted $Thumbprint) {
    Write-Host "SimplySign session established -- cert $Thumbprint mounted." -ForegroundColor Green
    exit 0
  }
  Start-Sleep -Seconds 2
}
throw "Timed out after ${TimeoutSec}s waiting for cert $Thumbprint to mount. The OTP auto-fill likely missed the login field -- run with -CodeOnly to confirm the seed, then log in once interactively to check the SendKeys field order."
