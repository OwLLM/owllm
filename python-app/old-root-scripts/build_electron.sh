#!/bin/bash
# Build script for LLM Fine-tuning Studio Electron App (Linux/macOS)

set -e  # Exit on error

echo "========================================"
echo "LLM Fine-tuning Studio - Build Script"
echo "========================================"
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed!"
    echo "Please install Node.js from https://nodejs.org/"
    exit 1
fi

# Navigate to electron-app directory
cd "$(dirname "$0")/electron-app"

echo "[Step 1/4] Installing dependencies..."
npm install
echo ""

echo "[Step 2/4] Checking Python environment..."
if [ -f "../LLM/.venv/bin/python" ] || [ -f "../LLM/.venv/Scripts/python.exe" ]; then
    echo "[OK] Python virtual environment found"
else
    echo "[WARNING] Python virtual environment not found at ../LLM/.venv/"
    echo "Make sure your Python environment is set up correctly"
fi
echo ""

# Detect platform
PLATFORM=$(uname -s)
echo "[Step 3/4] Building Electron app for $PLATFORM..."

case "$PLATFORM" in
    Darwin)
        echo "Building for macOS..."
        npm run build:mac
        ;;
    Linux)
        echo "Building for Linux..."
        npm run build:linux
        ;;
    *)
        echo "Building for current platform..."
        npm run build
        ;;
esac
echo ""

echo "[Step 4/4] Build complete!"
echo ""
echo "========================================"
echo "Build Output:"
echo "========================================"

if [ -d "dist" ]; then
    ls -lh dist/ | grep -E '\.(dmg|AppImage|deb|rpm|zip)$' || echo "[WARNING] No installer files found"
    echo ""
    echo "Installers created in: electron-app/dist/"
else
    echo "[WARNING] dist/ directory not found"
fi

echo ""
echo "========================================"

