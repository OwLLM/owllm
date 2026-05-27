# Building Installers - LLM Fine-tuning Studio Electron App

## Prerequisites

Before building installers, ensure:

1. ✅ **Node.js 16+** is installed (`node --version`)
2. ✅ **npm** is available (`npm --version`)
3. ✅ **Dependencies installed** (`cd electron-app && npm install`)
4. ✅ **Python environment** works (`LLM/.venv/` exists)
5. ✅ **Tested locally** (app launches with `start_electron.bat`)

---

## Quick Build

### Windows

```batch
# From project root:
build_electron.bat

# Output: electron-app\dist\
# - LLM-Studio-Setup-1.0.0.exe (Installer)
# - LLM-Studio-1.0.0-portable.exe (Portable)
```

### Linux/macOS

```bash
# Make script executable:
chmod +x build_electron.sh

# Build:
./build_electron.sh

# Output: electron-app/dist/
# - LLM-Studio-1.0.0.AppImage (Linux universal)
# - LLM-Studio-1.0.0.dmg (macOS)
# - LLM-Studio-1.0.0.deb (Debian/Ubuntu)
# - LLM-Studio-1.0.0.rpm (RedHat/Fedora)
```

---

## Manual Build Process

### Step 1: Install Dependencies

```bash
cd electron-app
npm install
```

This installs:
- `electron` (~150MB)
- `electron-builder` (build tools)
- All dependencies

### Step 2: Build for Your Platform

```bash
# Windows only:
npm run build:win

# macOS only:
npm run build:mac

# Linux only:
npm run build:linux

# All platforms (current OS):
npm run build
```

### Step 3: Find Installers

Built installers are in: `electron-app/dist/`

---

## Build Outputs

### Windows (`npm run build:win`)

| File | Type | Size | Description |
|------|------|------|-------------|
| `LLM-Studio-Setup-1.0.0.exe` | NSIS Installer | ~150MB | Standard Windows installer |
| `LLM-Studio-1.0.0-portable.exe` | Portable | ~150MB | No installation required |

**Features:**
- ✅ Start Menu shortcut
- ✅ Desktop shortcut
- ✅ Uninstaller
- ✅ Auto-updater ready
- ✅ Code signing ready (needs certificate)

### macOS (`npm run build:mac`)

| File | Type | Size | Description |
|------|------|------|-------------|
| `LLM-Studio-1.0.0.dmg` | DMG Image | ~150MB | Standard macOS installer |
| `LLM-Studio-1.0.0-mac.zip` | ZIP Archive | ~120MB | App bundle only |

**Features:**
- ✅ Universal binary (Intel + Apple Silicon)
- ✅ Drag-to-Applications UI
- ✅ Code signing ready (needs certificate)
- ✅ Notarization ready

**Requirements:**
- Must build on macOS (cross-compilation not reliable)
- Xcode Command Line Tools

### Linux (`npm run build:linux`)

| File | Type | Size | Description |
|------|------|------|-------------|
| `LLM-Studio-1.0.0.AppImage` | AppImage | ~150MB | Universal Linux app |
| `LLM-Studio-1.0.0.deb` | Debian Package | ~120MB | Ubuntu/Debian |
| `LLM-Studio-1.0.0.rpm` | RPM Package | ~120MB | RedHat/Fedora/CentOS |

**Features:**
- ✅ No installation required (AppImage)
- ✅ Package manager integration (.deb/.rpm)
- ✅ Desktop integration
- ✅ Auto-updater ready

**Requirements:**
- `fakeroot` for .deb: `sudo apt-get install fakeroot`
- `rpm` for .rpm: `sudo apt-get install rpm`

---

## Build Configuration

Build settings are in `electron-app/package.json` under the `"build"` key:

```json
{
  "build": {
    "appId": "com.llm.finetuning.studio",
    "productName": "LLM Fine-tuning Studio",
    "directories": {
      "output": "dist"
    },
    "win": {
      "target": ["nsis", "portable"],
      "icon": "assets/icon.ico"
    },
    "mac": {
      "target": ["dmg", "zip"],
      "icon": "assets/icon.icns",
      "category": "public.app-category.developer-tools"
    },
    "linux": {
      "target": ["AppImage", "deb", "rpm"],
      "icon": "assets/icon.png",
      "category": "Development"
    }
  }
}
```

---

## Customization

### Change App Name

Edit `electron-app/package.json`:
```json
{
  "name": "your-app-name",
  "productName": "Your App Display Name",
  "version": "1.0.0"
}
```

### Change App ID

Edit `electron-app/package.json`:
```json
{
  "build": {
    "appId": "com.yourcompany.yourapp"
  }
}
```

### Add Description

Edit `electron-app/package.json`:
```json
{
  "description": "Your app description here"
}
```

### Change Icon

Replace icon files in `electron-app/assets/`:
- `icon.ico` (Windows)
- `icon.icns` (macOS)
- `icon.png` (Linux)

Use the provided `generate_icons.bat` or `generate_icons.sh` scripts.

---

## Advanced Features

### Code Signing (Windows)

Requires a code signing certificate:

1. Get certificate (e.g., from Sectigo, DigiCert)
2. Edit `package.json`:
```json
{
  "build": {
    "win": {
      "certificateFile": "path/to/cert.pfx",
      "certificatePassword": "your-password",
      "signingHashAlgorithms": ["sha256"]
    }
  }
}
```

### Code Signing (macOS)

Requires Apple Developer account:

1. Install certificate in Keychain
2. Edit `package.json`:
```json
{
  "build": {
    "mac": {
      "identity": "Developer ID Application: Your Name (TEAM_ID)",
      "hardenedRuntime": true,
      "entitlements": "build/entitlements.mac.plist"
    }
  }
}
```

### Auto-Updates

Add `electron-updater`:

```bash
npm install electron-updater
```

Configure update server in `main.js`:
```javascript
const { autoUpdater } = require('electron-updater');
autoUpdater.checkForUpdatesAndNotify();
```

---

## Troubleshooting

### Build fails: "Cannot find module"
```bash
cd electron-app
rm -rf node_modules
npm install
npm run build
```

### Build fails: "ENOENT: no such file or directory"
- Check that all required files exist
- Verify `../LLM/` directory exists
- Check `assets/` directory has at least one icon file

### Windows build fails: "icon.ico not found"
- Generate icon: `cd assets && generate_icons.bat`
- Or use PNG: Edit `package.json` to use `icon.png` instead

### macOS build fails: "Must be on macOS"
- macOS apps can only be built on macOS
- Use a Mac or macOS VM for building

### Linux build fails: "fakeroot not found"
```bash
sudo apt-get install fakeroot rpm
```

### Build is too large (>200MB)
- Normal for Electron apps (includes Chromium + Node.js)
- Can compress with UPX (not recommended, may trigger antivirus)
- Consider electron-packager instead of electron-builder

### Build succeeds but app won't start
- Test locally first: `npm start`
- Check Python environment is included
- Verify `extraResources` in package.json

---

## Distribution

### Windows

**Option 1: Direct Download**
- Upload `LLM-Studio-Setup-1.0.0.exe` to your website
- Users download and run installer

**Option 2: Microsoft Store**
- Convert to .appx package
- Submit to Microsoft Partner Center

**Option 3: Chocolatey**
- Create Chocolatey package
- Publish to chocolatey.org

### macOS

**Option 1: Direct Download**
- Upload `.dmg` file to website
- Users download and drag to Applications

**Option 2: Mac App Store**
- Requires Apple Developer account ($99/year)
- Notarize and submit via App Store Connect

**Option 3: Homebrew Cask**
- Create cask formula
- Submit PR to homebrew-cask

### Linux

**Option 1: Direct Download**
- Upload `.AppImage` (universal, no installation)

**Option 2: Package Repositories**
- Debian/Ubuntu: Create PPA
- Arch: Create AUR package
- Fedora: Create Copr repository

**Option 3: Snap Store**
- Convert to snap package
- Publish to snapcraft.io

**Option 4: Flathub**
- Create Flatpak manifest
- Submit to flathub.org

---

## CI/CD Integration

### GitHub Actions

Create `.github/workflows/build.yml`:

```yaml
name: Build Electron App

on:
  push:
    tags:
      - 'v*'

jobs:
  build:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [windows-latest, macos-latest, ubuntu-latest]
    
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 18
      
      - name: Install dependencies
        run: |
          cd electron-app
          npm install
      
      - name: Build
        run: |
          cd electron-app
          npm run build
      
      - name: Upload artifacts
        uses: actions/upload-artifact@v3
        with:
          name: installers-${{ matrix.os }}
          path: electron-app/dist/*
```

---

## Summary

### To Build Installers:

1. **Install Node.js** from https://nodejs.org/
2. **Install dependencies**: `cd electron-app && npm install`
3. **Build**: Run `build_electron.bat` (Windows) or `build_electron.sh` (Linux/macOS)
4. **Find installers**: Check `electron-app/dist/` directory
5. **Test installer**: Run on a clean machine
6. **Distribute**: Upload to website or app store

### Installer Checklist:

- [ ] Node.js installed
- [ ] Dependencies installed (`npm install`)
- [ ] App tested locally (`npm start`)
- [ ] Icons generated (or using PNG fallback)
- [ ] Build succeeds without errors
- [ ] Installer file(s) created in `dist/`
- [ ] Installer tested on clean machine
- [ ] App launches from installed location
- [ ] All features work after installation
- [ ] Uninstaller works (Windows)

You're ready to build professional installers for your LLM Fine-tuning Studio! 🚀

