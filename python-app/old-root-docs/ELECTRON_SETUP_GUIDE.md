# LLM Fine-tuning Studio - Electron Desktop App Setup Guide

## Quick Start

### Windows

1. **Install Node.js** (if not already installed):
   - Download from: https://nodejs.org/ (LTS version recommended)
   - Run the installer and follow the prompts
   - Verify installation: `node --version` and `npm --version`

2. **Install Dependencies**:
   ```batch
   cd electron-app
   npm install
   ```

3. **Run in Development Mode**:
   ```batch
   # From project root:
   start_electron.bat
   
   # Or from electron-app directory:
   npm start
   ```

4. **Build Installer**:
   ```batch
   # From project root:
   build_electron.bat
   
   # Installer will be in: electron-app\dist\
   ```

### Linux/macOS

1. **Install Node.js** (if not already installed):
   ```bash
   # Ubuntu/Debian:
   curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
   sudo apt-get install -y nodejs
   
   # macOS (using Homebrew):
   brew install node
   
   # Verify:
   node --version
   npm --version
   ```

2. **Install Dependencies**:
   ```bash
   cd electron-app
   npm install
   ```

3. **Make Scripts Executable**:
   ```bash
   chmod +x ../start_electron.sh
   chmod +x ../build_electron.sh
   chmod +x assets/generate_icons.sh
   ```

4. **Run in Development Mode**:
   ```bash
   # From project root:
   ./start_electron.sh
   
   # Or from electron-app directory:
   npm start
   ```

5. **Build Installer**:
   ```bash
   # From project root:
   ./build_electron.sh
   
   # Installer will be in: electron-app/dist/
   ```

---

## What You Get

### Before (Original Streamlit)
- ❌ Browser-based (tabs, address bar, browser UI)
- ❌ Requires manual server start
- ❌ No installer
- ❌ Can accidentally close tab

### After (Electron Desktop App)
- ✅ Native desktop app window
- ✅ Auto-starts Streamlit server
- ✅ Professional installers (.exe, .dmg, .AppImage, .deb, .rpm)
- ✅ System tray integration (minimize to tray)
- ✅ Clean, native experience
- ✅ **ALL YOUR STREAMLIT FEATURES PRESERVED**

---

## Architecture

```
┌─────────────────────────────────────┐
│   Electron Desktop App Window      │
│                                     │
│  ┌───────────────────────────────┐ │
│  │                               │ │
│  │   Your Streamlit GUI          │ │
│  │   (ALL features intact)       │ │
│  │                               │ │
│  │   - Train Models              │ │
│  │   - Download Models           │ │
│  │   - Test Models               │ │
│  │   - View Training History     │ │
│  │   - Everything you built!     │ │
│  │                               │ │
│  └───────────────────────────────┘ │
│                                     │
└─────────────────────────────────────┘
         ↕ (localhost:8501)
┌─────────────────────────────────────┐
│   Streamlit Server                  │
│   (Auto-started by Electron)        │
└─────────────────────────────────────┘
         ↕
┌─────────────────────────────────────┐
│   Your Training Code                │
│   (LLM/train_basic.py, etc.)        │
└─────────────────────────────────────┘
         ↕
┌─────────────────────────────────────┐
│   GPU Training                      │
└─────────────────────────────────────┘
```

---

## File Structure

```
Local-LLM-Server/
├── LLM/                          # Your existing Streamlit app (UNCHANGED)
│   ├── gui.py                    # Your working GUI
│   ├── train_basic.py            # Training logic
│   ├── .venv/                    # Python environment
│   └── ...
│
├── electron-app/                 # NEW: Electron wrapper
│   ├── main.js                   # Main process (starts Streamlit)
│   ├── preload.js                # Security layer
│   ├── package.json              # Dependencies & build config
│   ├── assets/                   # Icons
│   │   ├── icon.svg              # Source icon
│   │   ├── icon.png              # Linux icon
│   │   ├── icon.ico              # Windows icon
│   │   └── icon.icns             # macOS icon
│   ├── node_modules/             # (after npm install)
│   └── dist/                     # (build output)
│
├── start_electron.bat            # Quick start (Windows)
├── start_electron.sh             # Quick start (Linux/macOS)
├── build_electron.bat            # Build installer (Windows)
└── build_electron.sh             # Build installer (Linux/macOS)
```

---

## Troubleshooting

### "npm is not recognized"
- Node.js is not installed or not in PATH
- Install Node.js from https://nodejs.org/
- Restart your terminal after installation

### "Cannot find module 'electron'"
- Dependencies not installed
- Run: `cd electron-app && npm install`

### Port 8501 already in use
- Another Streamlit instance is running
- Kill it: `taskkill /F /IM python.exe` (Windows) or `pkill -f streamlit` (Linux/macOS)
- Or: The Electron app will detect and use the existing server

### Streamlit doesn't start
- Check Python virtual environment exists: `LLM/.venv/`
- Activate venv and install dependencies: `pip install streamlit`
- Check console output for Python errors

### Icons not showing
- Generate icons: `cd electron-app/assets && ./generate_icons.sh`
- Or: Use placeholder PNG files (Electron can work with PNG)

### Build fails
- Ensure all dependencies are installed: `npm install`
- Check disk space (builds can be large)
- On Linux: Install `fakeroot` and `rpm` if building .deb/.rpm

---

## Development Workflow

1. **Make changes to Streamlit GUI**:
   ```bash
   # Edit LLM/gui.py as usual
   # Test: streamlit run LLM/gui.py
   ```

2. **Test in Electron**:
   ```bash
   # Run Electron app
   ./start_electron.bat  # Windows
   ./start_electron.sh   # Linux/macOS
   ```

3. **Build new installer**:
   ```bash
   # Build for your platform
   ./build_electron.bat  # Windows
   ./build_electron.sh   # Linux/macOS
   ```

4. **Distribute**:
   - Share the installer from `electron-app/dist/`
   - Users just run the installer, no Python/Streamlit setup needed

---

## Advanced Configuration

### Change Streamlit Port

Edit `electron-app/main.js`:
```javascript
const STREAMLIT_PORT = 8501;  // Change this
```

### Disable System Tray

Edit `electron-app/main.js`:
```javascript
// Comment out:
// createTray();
```

### Enable Auto-Updates

Add `electron-updater` to `package.json`:
```bash
npm install electron-updater
```

Then configure in `main.js` (see Electron docs).

---

## What Makes This Better Than Streamlit Alone

| Feature | Streamlit (Browser) | Electron Desktop App |
|---------|---------------------|----------------------|
| **Looks Like a Real App** | ❌ Browser UI visible | ✅ Native window |
| **Auto-Start Server** | ❌ Manual | ✅ Automatic |
| **System Tray** | ❌ No | ✅ Yes |
| **Installer** | ❌ No | ✅ Yes (.exe, .dmg, etc.) |
| **Distribution** | ❌ Users install Python | ✅ Just run installer |
| **Professional** | ❌ Dev tool feel | ✅ Professional app |
| **Features** | ✅ All features | ✅ All features (preserved) |

---

## Next Steps

1. **Install Node.js** if you haven't already
2. **Run `start_electron.bat`** to test locally
3. **Run `build_electron.bat`** to create installer
4. **Share the installer** with users
5. **Profit!** 🎉

You now have a professional desktop application while keeping all your hard work on the Streamlit GUI!

