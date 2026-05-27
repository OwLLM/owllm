# Python Installation Checker and Helper
# Run this after installing Python to verify it's working

Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Python Installation Verification" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# Check if Python is available
$pythonCmd = $null
$pythonCommands = @("python", "python3", "py")

foreach ($cmd in $pythonCommands) {
    try {
        $result = & $cmd --version 2>&1
        if ($LASTEXITCODE -eq 0) {
            $pythonCmd = $cmd
            Write-Host "✅ Python found: $cmd" -ForegroundColor Green
            Write-Host "   Version: $result" -ForegroundColor Green
            break
        }
    } catch {
        continue
    }
}

if ($null -eq $pythonCmd) {
    Write-Host "❌ Python not found!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please install Python from: https://www.python.org/downloads/" -ForegroundColor Yellow
    Write-Host "Make sure to check 'Add Python to PATH' during installation." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "After installation, restart this PowerShell window and run this script again." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host ""
Write-Host "Testing Python functionality..." -ForegroundColor Yellow

# Test basic Python functionality
try {
    $testResult = & $pythonCmd -c "print('Python is working!')" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✅ Python execution works" -ForegroundColor Green
    } else {
        Write-Host "❌ Python execution failed" -ForegroundColor Red
    }
} catch {
    Write-Host "❌ Python execution failed: $($_.Exception.Message)" -ForegroundColor Red
}

# Test pip
try {
    $pipResult = & $pythonCmd -m pip --version 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✅ Pip is available" -ForegroundColor Green
        Write-Host "   $pipResult" -ForegroundColor Green
    } else {
        Write-Host "❌ Pip not working" -ForegroundColor Red
    }
} catch {
    Write-Host "❌ Pip not working: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Installing GUI Dependencies" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan

# Create virtual environment if it doesn't exist
if (!(Test-Path ".venv")) {
    Write-Host "Creating virtual environment..." -ForegroundColor Yellow
    & $pythonCmd -m venv .venv
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Failed to create virtual environment!" -ForegroundColor Red
        exit 1
    }
    Write-Host "✅ Virtual environment created" -ForegroundColor Green
}

# Activate virtual environment
Write-Host "Activating virtual environment..." -ForegroundColor Yellow
$activateScript = Join-Path $PSScriptRoot ".venv\Scripts\Activate.ps1"
if (Test-Path $activateScript) {
    & $activateScript
    Write-Host "✅ Virtual environment activated" -ForegroundColor Green
} else {
    Write-Host "❌ Failed to activate virtual environment!" -ForegroundColor Red
    exit 1
}

# Install dependencies
Write-Host "Installing GUI dependencies..." -ForegroundColor Yellow
& pip install -r requirements.txt
if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ Dependencies installed successfully" -ForegroundColor Green
} else {
    Write-Host "❌ Failed to install dependencies!" -ForegroundColor Red
    exit 1
}

# Test GPU availability
Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  GPU Check" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan

try {
    & python -c "import torch; print('GPU Available:', torch.cuda.is_available()); print('GPU Name:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU Mode')" 2>$null
} catch {
    Write-Host "⚠️  Could not check GPU (torch not installed yet)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Ready to Launch GUI!" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "🎉 Everything is set up!" -ForegroundColor Green
Write-Host ""
Write-Host "To start the GUI, run:" -ForegroundColor Cyan
Write-Host "   .\run_gui.ps1" -ForegroundColor Green
Write-Host ""
Write-Host "Or start it manually:" -ForegroundColor Cyan
Write-Host "   streamlit run gui.py" -ForegroundColor Green
Write-Host ""
Write-Host "The GUI will open at: http://localhost:8501" -ForegroundColor Green
Write-Host ""

$startNow = Read-Host "Would you like to start the GUI now? (y/n)"
if ($startNow -eq "y" -or $startNow -eq "Y") {
    Write-Host "Starting GUI..." -ForegroundColor Green
    & streamlit run gui.py
} else {
    Write-Host "You can start the GUI anytime by running .\run_gui.ps1" -ForegroundColor Yellow
}

