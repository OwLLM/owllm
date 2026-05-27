# Quick Setup Test Script
# Run this to verify the installation is working correctly

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "   LLM Fine-tuning Studio - Installation Test" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

$testsPassed = 0
$testsFailed = 0

# Helper function for test results
function Test-Component {
    param(
        [string]$Name,
        [scriptblock]$Test
    )
    
    Write-Host "Testing: $Name..." -ForegroundColor Yellow -NoNewline
    try {
        $result = & $Test
        if ($result -eq $true -or $LASTEXITCODE -eq 0) {
            Write-Host " ✓ PASS" -ForegroundColor Green
            $script:testsPassed++
            return $true
        } else {
            Write-Host " ✗ FAIL" -ForegroundColor Red
            $script:testsFailed++
            return $false
        }
    } catch {
        Write-Host " ✗ FAIL - $($_.Exception.Message)" -ForegroundColor Red
        $script:testsFailed++
        return $false
    }
}

# Change to script directory
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

Write-Host "Test Location: $scriptDir" -ForegroundColor Gray
Write-Host ""

# Test 1: Python Installation
Test-Component "Python Installation" {
    $version = python --version 2>&1
    if ($version -match "Python 3\.\d+") {
        Write-Host "    → $version" -ForegroundColor Gray
        return $true
    }
    return $false
}

# Test 2: Setup Completion
$setupComplete = Test-Component "Setup Completion" {
    if (Test-Path ".setup_complete") {
        return $true
    }
    Write-Host ""
    Write-Host "    ⚠ Setup not complete. Run LAUNCHER.bat first." -ForegroundColor Yellow
    return $false
}

# Test 3: Setup State File
Test-Component "Setup State File" {
    if (Test-Path ".setup_state.json") {
        $state = Get-Content ".setup_state.json" | ConvertFrom-Json
        Write-Host "    → Setup Date: $($state.setup_date)" -ForegroundColor Gray
        return $true
    }
    return $false
}

# Test 4: Virtual Environment
Test-Component "Virtual Environment" {
    if (Test-Path ".venv\Scripts\python.exe") {
        return $true
    }
    Write-Host ""
    Write-Host "    ℹ No virtual environment (using system Python)" -ForegroundColor Gray
    return $true
}

# Test 5: PyTorch Import
Test-Component "PyTorch Import" {
    $result = python -c "import torch; print(torch.__version__)" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "    → PyTorch $result" -ForegroundColor Gray
        return $true
    }
    return $false
}

# Test 6: CUDA Availability
Test-Component "CUDA Detection" {
    $result = python -c "import torch; print('Available' if torch.cuda.is_available() else 'CPU-only')" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "    → $result" -ForegroundColor Gray
        return $true
    }
    return $false
}

# Test 7: GPU Count
Test-Component "GPU Detection" {
    $result = python -c "import torch; print(f'{torch.cuda.device_count()} GPU(s)' if torch.cuda.is_available() else 'CPU-only')" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "    → $result" -ForegroundColor Gray
        return $true
    }
    return $false
}

# Test 8: Triton Version
Test-Component "Triton Version" {
    $result = python -c "import triton; print(triton.__version__)" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "    → Triton $result" -ForegroundColor Gray
        if ($result -match "^3\.0") {
            return $true
        } else {
            Write-Host "    ⚠ Expected Triton 3.0.x, got $result" -ForegroundColor Yellow
            return $false
        }
    }
    return $false
}

# Test 9: Transformers Import
Test-Component "Transformers Library" {
    $result = python -c "import transformers; print(transformers.__version__)" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "    → Transformers $result" -ForegroundColor Gray
        return $true
    }
    return $false
}

# Test 10: Hugging Face Hub
Test-Component "Hugging Face Hub" {
    $result = python -c "import huggingface_hub; print(huggingface_hub.__version__)" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "    → HF Hub $result" -ForegroundColor Gray
        return $true
    }
    return $false
}

# Test 11: PySide6 (GUI)
Test-Component "PySide6 (GUI)" {
    $result = python -c "from PySide6.QtCore import __version__; print(__version__)" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "    → PySide6 $result" -ForegroundColor Gray
        return $true
    }
    return $false
}

# Test 12: Unsloth (Optional but important)
$unslothOk = Test-Component "Unsloth Library" {
    $result = python -c "from unsloth import FastLanguageModel; print('OK')" 2>&1
    if ($LASTEXITCODE -eq 0 -and $result -match "OK") {
        Write-Host "    → Unsloth available" -ForegroundColor Gray
        return $true
    }
    if ($result -match "AttrsDescriptor" -or $result -match "triton") {
        Write-Host ""
        Write-Host "    ✗ Triton compatibility issue detected!" -ForegroundColor Red
        Write-Host "    → Run: python -m pip install triton==3.0.0" -ForegroundColor Yellow
    }
    return $false
}

# Test 13: Main App Import
Test-Component "Main Application" {
    $result = python -c "from desktop_app.main import MainWindow; print('OK')" 2>&1
    if ($LASTEXITCODE -eq 0) {
        return $true
    }
    return $false
}

# Summary
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Test Results: $testsPassed passed, $testsFailed failed" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

if ($testsFailed -eq 0) {
    Write-Host "✓ All tests passed! Installation is complete and working." -ForegroundColor Green
    Write-Host ""
    Write-Host "You can now:" -ForegroundColor White
    Write-Host "  • Run LAUNCHER.bat to start the application" -ForegroundColor Gray
    Write-Host "  • Download models from the Download tab" -ForegroundColor Gray
    Write-Host "  • Train models from the Train tab" -ForegroundColor Gray
    Write-Host ""
    exit 0
} else {
    Write-Host "⚠ Some tests failed. Please review the errors above." -ForegroundColor Yellow
    Write-Host ""
    
    if (-not $setupComplete) {
        Write-Host "Next step: Run LAUNCHER.bat to complete first-time setup" -ForegroundColor Yellow
    } elseif (-not $unslothOk) {
        Write-Host "Next step: Fix Triton compatibility" -ForegroundColor Yellow
        Write-Host "  Run: python -m pip uninstall triton -y" -ForegroundColor Gray
        Write-Host "  Run: python -m pip install triton==3.0.0" -ForegroundColor Gray
    } else {
        Write-Host "Next step: Run verify_installation.py for detailed diagnostics" -ForegroundColor Yellow
        Write-Host "  Run: python verify_installation.py" -ForegroundColor Gray
    }
    
    Write-Host ""
    exit 1
}

