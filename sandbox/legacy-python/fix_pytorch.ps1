# Fix PyTorch DLL initialization error on Windows
# This script will reinstall PyTorch with CPU-only version if needed

Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Fixing PyTorch DLL Error" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

Set-Location -Path $PSScriptRoot

# Check if virtual environment exists
if (!(Test-Path ".venv")) {
    Write-Host "ERROR: Virtual environment not found!" -ForegroundColor Red
    Write-Host "Run .\install_python.ps1 first." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

# Activate virtual environment
Write-Host "Activating virtual environment..." -ForegroundColor Yellow
$activateScript = Join-Path $PSScriptRoot ".venv\Scripts\Activate.ps1"
if (Test-Path $activateScript) {
    & $activateScript
} else {
    Write-Host "ERROR: Failed to activate virtual environment!" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Step 1: Uninstalling PyTorch" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
& pip uninstall torch torchvision torchaudio -y

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Step 2: Installing CPU-only PyTorch" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "Installing PyTorch CPU version (more stable on Windows)..." -ForegroundColor Yellow
& pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: Failed to install PyTorch!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Alternative: Install Visual C++ Redistributables:" -ForegroundColor Yellow
    Write-Host "https://aka.ms/vs/17/release/vc_redist.x64.exe" -ForegroundColor Cyan
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Step 3: Verifying Installation" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
& python -c "import torch; print('PyTorch version:', torch.__version__); print('CUDA available:', torch.cuda.is_available())"

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "================================================" -ForegroundColor Green
    Write-Host "  SUCCESS! PyTorch is now working." -ForegroundColor Green
    Write-Host "================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "You can now run the GUI:" -ForegroundColor Cyan
    Write-Host "  .\start_gui.ps1" -ForegroundColor Green
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "ERROR: PyTorch still not working." -ForegroundColor Red
    Write-Host ""
    Write-Host "Please try:" -ForegroundColor Yellow
    Write-Host "1. Install Visual C++ Redistributables:" -ForegroundColor Yellow
    Write-Host "   https://aka.ms/vs/17/release/vc_redist.x64.exe" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "2. Restart your computer" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "3. Run this script again" -ForegroundColor Yellow
    Write-Host ""
}

Read-Host "Press Enter to exit"

