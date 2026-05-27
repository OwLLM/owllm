# Quick Reference - LLM Fine-tuning Studio Electron App

## Installation

```bash
# 1. Install Node.js from https://nodejs.org/

# 2. Install dependencies
cd electron-app
npm install
```

## Development

```bash
# Quick start (auto-installs dependencies)
start_electron.bat          # Windows
./start_electron.sh         # Linux/macOS

# Or manually
cd electron-app
npm start
```

## Building

```bash
# Build installer for your platform
build_electron.bat          # Windows → .exe installers
./build_electron.sh         # Linux/macOS → .AppImage/.deb/.dmg

# Output: electron-app/dist/
```

## Generated Icons (Optional)

```bash
cd electron-app/assets
generate_icons.bat          # Windows
./generate_icons.sh         # Linux/macOS
```

## File Locations

| What | Where |
|------|-------|
| **Streamlit GUI** | `LLM/gui.py` (UNCHANGED) |
| **Electron Main** | `electron-app/main.js` |
| **npm Config** | `electron-app/package.json` |
| **Installers** | `electron-app/dist/` (after build) |
| **Icons** | `electron-app/assets/` |

## Common Commands

```bash
# Install dependencies
cd electron-app && npm install

# Run in dev mode
npm start

# Build for Windows
npm run build:win

# Build for macOS
npm run build:mac

# Build for Linux
npm run build:linux

# Build for current platform
npm run build
```

## Key Features

✅ Native desktop window (not browser)
✅ Auto-starts Streamlit server
✅ System tray integration
✅ Cross-platform installers
✅ All Streamlit features preserved

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `npm not found` | Install Node.js from https://nodejs.org/ |
| Port 8501 in use | Kill existing Streamlit: `taskkill /F /IM python.exe` |
| Build fails | `rm -rf node_modules && npm install` |
| Icons missing | Run `generate_icons.bat` or use PNG fallback |

## Documentation

- `ELECTRON_SETUP_GUIDE.md` - Complete setup instructions
- `ELECTRON_TESTING.md` - Testing procedures
- `ELECTRON_BUILD_GUIDE.md` - Building & distribution
- `IMPLEMENTATION_COMPLETE.md` - Implementation summary

## Quick Start

```bash
# First time
1. Install Node.js
2. cd electron-app && npm install
3. npm start

# Building installer
1. npm run build
2. Find in dist/
3. Test on clean machine
4. Distribute!
```

## Architecture

```
Electron Desktop App
    ↓
Streamlit Server (auto-started)
    ↓
Your GUI (LLM/gui.py - unchanged)
    ↓
Training Code
    ↓
GPU
```

## What Changed

**Nothing in your Streamlit app!**

All changes are in the new `electron-app/` directory. Your `LLM/gui.py` and training code remain completely untouched.

## Support

Check the detailed guides:
- Setup issues → `ELECTRON_SETUP_GUIDE.md`
- Testing issues → `ELECTRON_TESTING.md`
- Build issues → `ELECTRON_BUILD_GUIDE.md`

