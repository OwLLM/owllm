# build-modules.ps1 -- assemble module ZIPs from upstream binaries.
#
# What this does:
#   1. Reads owllm-desktop/bootstrap-manifest.json (pinned upstream URLs).
#   2. For each module, downloads the upstream artifact(s), filters/repacks
#      into a clean ZIP at owllm-desktop/dist/modules/<variant-id>-<version>.zip.
#   3. Computes SHA-256 of each ZIP, writes alongside as .sha256.
#   4. Emits dist/modules/manifest.json -- paste these hashes into
#      data/modules/registry.json before publishing the registry update.
#
# Idempotent -- skips downloads already in the local cache (.cache/upstream/).
# Cache entries and output zips are keyed by moduleVersion, so bumping a pin in
# bootstrap-manifest.json always refetches instead of repacking the old engine.
#
# Usage:
#   pwsh -File scripts/build-modules.ps1                    # build all
#   pwsh -File scripts/build-modules.ps1 -Only local-inference-cuda
#   pwsh -File scripts/build-modules.ps1 -Skip finetune-*   # skip slow ones

param(
    [string[]]$Only,
    [string[]]$Skip,
    [switch]$ForceRedownload,
    [switch]$ForceRebuild
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "Continue"

$here = Split-Path -Parent $PSScriptRoot
$cacheDir = Join-Path $here ".cache\upstream"
$workDir = Join-Path $here ".cache\work"
$outDir = Join-Path $here "dist\modules"
$manifestPath = Join-Path $here "bootstrap-manifest.json"

foreach ($d in @($cacheDir, $workDir, $outDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

if (-not (Test-Path $manifestPath)) {
    Write-Error "bootstrap-manifest.json not found at $manifestPath"
    exit 1
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

function Write-Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Write-Sub($message) { Write-Host "    $message" -ForegroundColor DarkGray }

function Get-CacheTag {
    # Cache filenames MUST carry the pinned version. Keyed on the variant id
    # alone, bumping moduleVersion in bootstrap-manifest.json silently reused
    # the PREVIOUS engine's bytes and republished it under the new version --
    # the zips came out byte-identical to the old ones. Falls back to a hash of
    # the source URLs so an entry without moduleVersion still invalidates.
    param($cfg)
    if ($cfg.moduleVersion) { return ($cfg.moduleVersion -replace '[^A-Za-z0-9._-]', '_') }
    $urls = @()
    if ($cfg.upstreamUrl) { $urls += $cfg.upstreamUrl }
    if ($cfg.components) { foreach ($c in $cfg.components) { $urls += $c.url } }
    if (-not $urls) { return "nover" }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes(($urls -join "|")))
    return (($bytes | ForEach-Object { $_.ToString("x2") }) -join "").Substring(0, 12)
}

function Get-Upstream {
    param([string]$url, [string]$dest)
    if ((Test-Path $dest) -and -not $ForceRedownload) {
        Write-Sub "cache hit: $(Split-Path $dest -Leaf)"
        return
    }
    Write-Sub "fetching $url"
    $tmp = "$dest.part"
    if (Test-Path $tmp) { Remove-Item -Force $tmp }
    # curl.exe (built into Windows 10/11) -- Invoke-WebRequest's legacy
    # stack in PowerShell 5.1 hangs on the 302 redirect GitHub Releases
    # issues to release-assets.githubusercontent.com for some files
    # (notably cudart-*.zip). curl handles redirects + retries reliably.
    & curl.exe --fail --location --retry 3 --retry-delay 2 --silent --show-error --output $tmp $url
    if ($LASTEXITCODE -ne 0) {
        if (Test-Path $tmp) { Remove-Item -Force $tmp }
        throw "curl failed (exit $LASTEXITCODE) for $url"
    }
    Move-Item -Force $tmp $dest
}

function Expand-Strip {
    # -Merge keeps whatever is already in $dest. Composite modules extract
    # several components into ONE directory, and the unconditional wipe made
    # each component delete the previous one -- the CUDA module shipped as the
    # cudart DLLs alone, with no llama-server.exe at all.
    param([string]$zip, [string]$dest, [int]$strip = 0, [switch]$Merge)
    if (-not $Merge -and (Test-Path $dest)) { Remove-Item -Recurse -Force $dest }
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    if ($strip -eq 0) {
        Expand-Archive -Path $zip -DestinationPath $dest -Force
    } else {
        $tmp = Join-Path $workDir ("strip-" + [Guid]::NewGuid().ToString("N"))
        Expand-Archive -Path $zip -DestinationPath $tmp -Force
        # Move contents of top-level dir(s) into dest, dropping `strip` levels.
        $items = Get-ChildItem $tmp
        if ($items.Count -eq 1 -and $items[0].PSIsContainer -and $strip -eq 1) {
            Get-ChildItem $items[0].FullName | ForEach-Object {
                Move-Item -Force $_.FullName (Join-Path $dest $_.Name)
            }
        } else {
            Get-ChildItem $tmp | ForEach-Object {
                Move-Item -Force $_.FullName (Join-Path $dest $_.Name)
            }
        }
        Remove-Item -Recurse -Force $tmp
    }
}

function Expand-TarGz {
    param([string]$tarGz, [string]$dest, [int]$strip = 0)
    # Use Windows bsdtar (handles Windows paths and materialises symlinks).
    $tar = Join-Path $env:SystemRoot "System32\tar.exe"
    if (-not (Test-Path $tar)) { throw "Windows tar.exe not found at $tar" }
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    if ($strip -eq 0) {
        & $tar -xzf $tarGz -C $dest
        if ($LASTEXITCODE -ne 0) { throw "tar extraction failed (exit $LASTEXITCODE) for $tarGz" }
    } else {
        $tmp = Join-Path $workDir ("strip-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        & $tar -xzf $tarGz -C $tmp
        if ($LASTEXITCODE -ne 0) { throw "tar extraction failed (exit $LASTEXITCODE) for $tarGz" }
        $items = Get-ChildItem $tmp
        if ($items.Count -eq 1 -and $items[0].PSIsContainer -and $strip -eq 1) {
            Get-ChildItem $items[0].FullName | ForEach-Object {
                Move-Item -Force $_.FullName (Join-Path $dest $_.Name)
            }
        } else {
            Get-ChildItem $tmp | ForEach-Object {
                Move-Item -Force $_.FullName (Join-Path $dest $_.Name)
            }
        }
        Remove-Item -Recurse -Force $tmp
    }
}

function Build-Simple {
    param([string]$variantId, $cfg)
    Write-Step "building $variantId"
    $isTarGz = $cfg.upstreamUrl -match "\.tar\.gz$"
    $cacheExt = if ($isTarGz) { ".tar.gz" } else { ".zip" }
    $cacheFile = Join-Path $cacheDir ($variantId + "-" + (Get-CacheTag $cfg) + "-upstream" + $cacheExt)
    Get-Upstream -url $cfg.upstreamUrl -dest $cacheFile
    $extractDir = Join-Path $workDir $variantId
    $strip = if ($null -ne $cfg.extractStrip) { $cfg.extractStrip } else { 0 }
    if ($isTarGz) {
        Expand-TarGz -tarGz $cacheFile -dest $extractDir -strip $strip
    } else {
        Expand-Strip -zip $cacheFile -dest $extractDir -strip $strip
    }

    # Optional include filter -- drop everything not matching.
    if ($cfg.include) {
        $allFiles = Get-ChildItem -Recurse -File $extractDir
        $keep = New-Object 'System.Collections.Generic.HashSet[string]'
        foreach ($pat in $cfg.include) {
            Get-ChildItem -Recurse -File $extractDir -Filter $pat | ForEach-Object {
                $null = $keep.Add($_.FullName)
            }
        }
        $allFiles | Where-Object { -not $keep.Contains($_.FullName) } | Remove-Item -Force
    }

    Build-Zip -srcDir $extractDir -variantId $variantId -version $cfg.moduleVersion -require $cfg.requireFiles
}

function Build-Composite {
    param([string]$variantId, $cfg)
    Write-Step "building $variantId (composite)"
    $extractDir = Join-Path $workDir $variantId
    if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }
    New-Item -ItemType Directory -Path $extractDir -Force | Out-Null

    foreach ($comp in $cfg.components) {
        Write-Sub "component: $($comp.name)"
        $ext = if ($comp.url -match "\.zip$") { ".zip" }
               elseif ($comp.url -match "\.tar\.gz$") { ".tar.gz" }
               else { "" }
        $compCache = Join-Path $cacheDir ($variantId + "-" + (Get-CacheTag $cfg) + "-" + $comp.name + $ext)
        Get-Upstream -url $comp.url -dest $compCache
        if ($comp.url -match "\.zip$") {
            $compDest = if ($comp.destDir) { Join-Path $extractDir $comp.destDir } else { $extractDir }
            $compStrip = if ($null -ne $comp.extractStrip) { $comp.extractStrip } else { 0 }
            Expand-Strip -zip $compCache -dest $compDest -strip $compStrip -Merge
        } elseif ($comp.destFile) {
            Copy-Item $compCache (Join-Path $extractDir $comp.destFile) -Force
        } else {
            Write-Warning "component $($comp.name) has no extraction strategy -- copying raw"
            Copy-Item $compCache (Join-Path $extractDir (Split-Path $compCache -Leaf)) -Force
        }
    }
    Build-Zip -srcDir $extractDir -variantId $variantId -version $cfg.moduleVersion -require $cfg.requireFiles
}

function Build-Wheelhouse {
    param([string]$variantId, $cfg)
    Write-Step "building $variantId (wheelhouse)"
    $reqPath = Join-Path (Split-Path $here -Parent) $cfg.requirementsFile
    if (-not (Test-Path $reqPath)) {
        Write-Warning "skip $variantId -- requirements file missing: $reqPath"
        Write-Warning "  (create it before this module can be published)"
        return
    }
    $py = Get-Command python -ErrorAction SilentlyContinue
    if (-not $py) {
        Write-Warning "skip $variantId -- python not on PATH"
        return
    }
    $extractDir = Join-Path $workDir $variantId
    if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }
    New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
    $args = @("-m", "pip", "download", "-r", $reqPath, "-d", $extractDir)
    if ($cfg.pipExtraIndexUrl) { $args += @("--extra-index-url", $cfg.pipExtraIndexUrl) }
    Write-Sub "pip download -> $extractDir"
    & python $args
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "pip download failed for $variantId"
        return
    }
    Build-Zip -srcDir $extractDir -variantId $variantId -version $cfg.moduleVersion -require $cfg.requireFiles
}

function Build-Zip {
    # $version stamps the output name for the same reason Get-CacheTag stamps
    # the download cache: <variantId>.zip alone made a version bump a no-op
    # ("cache hit") that republished the previous engine's bytes.
    param([string]$srcDir, [string]$variantId, [string]$version, [string[]]$require)
    $suffix = if ($version) { "-" + ($version -replace '[^A-Za-z0-9._-]', '_') } else { "" }
    $outZip = Join-Path $outDir ($variantId + $suffix + ".zip")

    # A payload missing its entrypoint is worse than a failed build: it uploads
    # and installs, then dies at runtime. Fail here instead.
    if ($require) {
        $present = (Get-ChildItem -Recurse -File $srcDir | ForEach-Object { $_.Name })
        foreach ($needed in $require) {
            if ($present -notcontains $needed) {
                throw "$variantId payload is missing required file '$needed' -- refusing to package"
            }
        }
    }
    if ((Test-Path $outZip) -and -not $ForceRebuild) {
        Write-Sub "cache hit: $(Split-Path $outZip -Leaf)"
    } else {
        if (Test-Path $outZip) { Remove-Item -Force $outZip }
        # Compress-Archive buffers each entry through a MemoryStream and dies
        # with "Stream was too long" on entries >2 GB (e.g. ggml-large-v3.bin).
        # ZipArchive in Create mode streams entries straight to disk and emits
        # Zip64 headers on its own when an entry or the archive exceeds the
        # 32-bit limits, so building the archive by hand lifts that ceiling.
        Add-Type -AssemblyName System.IO.Compression
        $srcDir = (Resolve-Path $srcDir).Path
        $srcLen = $srcDir.Length + 1
        $zipStream = $null
        $archive = $null
        try {
            $zipStream = [System.IO.FileStream]::new($outZip, [System.IO.FileMode]::Create)
            $archive = [System.IO.Compression.ZipArchive]::new(
                $zipStream,
                [System.IO.Compression.ZipArchiveMode]::Create,
                $true
            )
            foreach ($file in (Get-ChildItem -Recurse -File $srcDir)) {
                $entryName = $file.FullName.Substring($srcLen).Replace('\', '/')
                $entry = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
                $entryStream = $entry.Open()
                try {
                    $fileStream = [System.IO.FileStream]::new($file.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read)
                    try {
                        $fileStream.CopyTo($entryStream)
                    } finally {
                        $fileStream.Dispose()
                    }
                } finally {
                    $entryStream.Dispose()
                }
            }
        } finally {
            if ($archive) { $archive.Dispose() }
            if ($zipStream) { $zipStream.Dispose() }
        }
    }
    $hash = (Get-FileHash -Algorithm SHA256 $outZip).Hash.ToLower()
    $size = (Get-Item $outZip).Length
    Set-Content -Path (Join-Path $outDir ($variantId + $suffix + ".sha256")) -Value $hash -NoNewline
    Write-Sub ("size: {0:N0} bytes  sha256: {1}" -f $size, $hash)
    return @{
        variant = $variantId
        zip = $outZip
        zipName = (Split-Path $outZip -Leaf)
        version = $version
        sizeBytes = $size
        sha256 = $hash
    }
}

# --------- run ---------
$results = @()
foreach ($prop in $manifest.modules.PSObject.Properties) {
    $id = $prop.Name
    if ($Only -and -not ($Only -contains $id)) { continue }
    if ($Skip) {
        $skipped = $false
        foreach ($pat in $Skip) { if ($id -like $pat) { $skipped = $true; break } }
        if ($skipped) { Write-Sub "skipped: $id"; continue }
    }
    $cfg = $prop.Value
    try {
        $res = $null
        if ($cfg.buildKind -eq "wheelhouse") {
            $res = Build-Wheelhouse -variantId $id -cfg $cfg
        } elseif ($cfg.components) {
            $res = Build-Composite -variantId $id -cfg $cfg
        } else {
            $res = Build-Simple -variantId $id -cfg $cfg
        }
        if ($res) { $results += $res }
    } catch {
        Write-Error "$id failed: $_"
    }
}

$summary = @{
    builtAt = (Get-Date -Format "o")
    modules = $results
} | ConvertTo-Json -Depth 6
Set-Content -Path (Join-Path $outDir "manifest.json") -Value $summary
Write-Step "done -- see $outDir\manifest.json"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Copy each sha256 from dist\modules\*.sha256 into data\modules\registry.json"
Write-Host "  2. Update downloadUrl in registry.json to point at the GitHub Release tag"
Write-Host "  3. Upload dist\modules\*.zip to a GitHub Release at github.com/ruigro/LocaLLM/releases"
Write-Host "  4. Commit + push data\modules\registry.json so app picks up the update"
