#!/bin/bash
# Quick launcher for LLM Fine-tuning Studio Electron App (Development)

echo "========================================"
echo "LLM Fine-tuning Studio - Quick Start"
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

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "[First Run] Installing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        echo "[ERROR] Failed to install dependencies!"
        exit 1
    fi
    echo ""
fi

echo "Starting LLM Fine-tuning Studio..."
echo ""

# Start the app
npm start

