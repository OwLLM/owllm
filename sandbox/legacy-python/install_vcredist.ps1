# Download and install Visual C++ Redistributables (required for PyTorch)

Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Installing Visual C++ Redistributables" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "This is required for PyTorch to work on Windows." -ForegroundColor Yellow
Write-Host ""

$vcredistUrl = "https://aka.ms/vs/17/release/vc_redist.x64.exe"
$downloadPath = "$env:TEMP\vc_redist.x64.exe"

Write-Host "Downloading Visual C++ Redistributables..." -ForegroundColor Yellow
try {
    Invoke-WebRequest -Uri $vcredistUrl -OutFile $downloadPath -UseBasicParsing
    Write-Host "✅ Download complete" -ForegroundColor Green
} catch {
    Write-Host "❌ Download failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please download manually from:" -ForegroundColor Yellow
    Write-Host $vcredistUrl -ForegroundColor Cyan
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host ""
Write-Host "Installing Visual C++ Redistributables..." -ForegroundColor Yellow
Write-Host "You may see a UAC prompt - please allow it." -ForegroundColor Yellow
Write-Host ""

try {
    Start-Process -FilePath $downloadPath -ArgumentList "/install", "/quiet", "/norestart" -Wait -NoNewWindow
    Write-Host "✅ Installation complete!" -ForegroundColor Green
} catch {
    Write-Host "❌ Installation failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "Try running the installer manually:" -ForegroundColor Yellow
    Write-Host $downloadPath -ForegroundColor Cyan
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "  IMPORTANT: Restart your computer!" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "After restarting, PyTorch should work correctly." -ForegroundColor Yellow
Write-Host ""
Write-Host "To test after restart:" -ForegroundColor Cyan
Write-Host "  python -c 'import torch; print(torch.__version__)'" -ForegroundColor Green
Write-Host ""

$restart = Read-Host "Would you like to restart now? (y/n)"
if ($restart -eq "y" -or $restart -eq "Y") {
    Write-Host "Restarting computer in 10 seconds..." -ForegroundColor Yellow
    Start-Sleep 2
    Restart-Computer -Force
} else {
    Write-Host "Please restart manually when ready." -ForegroundColor Yellow
}

