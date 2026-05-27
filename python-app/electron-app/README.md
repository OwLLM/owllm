# LLM Fine-tuning Studio - Electron Desktop App

A cross-platform desktop application wrapper for the LLM Fine-tuning Studio Streamlit GUI.

## Features

- ✅ Native desktop application (not browser-based)
- ✅ System tray integration
- ✅ Auto-starts Streamlit server
- ✅ Cross-platform (Windows, macOS, Linux)
- ✅ Installers for all platforms
- ✅ All Streamlit GUI features preserved

## Prerequisites

- Node.js 16+ and npm
- Python 3.8+ with the LLM Studio environment set up
- (Optional) ImageMagick for icon generation

## Installation

1. Install dependencies:
```bash
npm install
```

2. Generate icons (optional):
```bash
cd assets
# Windows:
generate_icons.bat
# Linux/macOS:
chmod +x generate_icons.sh && ./generate_icons.sh
```

## Development

Run the app in development mode:
```bash
npm start
```

This will:
1. Start the Streamlit server
2. Open the Electron window
3. Enable DevTools for debugging

## Building

### Build for Current Platform
```bash
npm run build
```

### Build for Specific Platforms

**Windows:**
```bash
npm run build:win
```

**macOS:**
```bash
npm run build:mac
```

**Linux:**
```bash
npm run build:linux
```

## Build Output

Built applications will be in the `dist/` directory:

### Windows
- `LLM-Studio-Setup-1.0.0.exe` - NSIS Installer
- `LLM-Studio-1.0.0-portable.exe` - Portable executable

### macOS
- `LLM-Studio-1.0.0.dmg` - DMG installer
- `LLM-Studio-1.0.0-mac.zip` - Zipped app bundle

### Linux
- `LLM-Studio-1.0.0.AppImage` - Universal Linux app
- `LLM-Studio-1.0.0.deb` - Debian/Ubuntu package
- `LLM-Studio-1.0.0.rpm` - RedHat/Fedora package

## Project Structure

```
electron-app/
├── main.js          # Electron main process (starts Streamlit, creates window)
├── preload.js       # Security preload script
├── package.json     # Dependencies and build config
├── assets/          # Icons and static assets
│   ├── icon.svg     # Source vector icon
│   ├── icon.png     # Linux icon
│   ├── icon.ico     # Windows icon
│   └── icon.icns    # macOS icon
└── dist/            # Build output (generated)
```

## How It Works

1. **Electron starts** and runs `main.js`
2. **Streamlit server** is spawned as a child process
3. **Window opens** and loads `http://localhost:8501`
4. **User interacts** with the full Streamlit GUI
5. **On close**, window minimizes to system tray
6. **On quit**, Streamlit process is terminated

## Troubleshooting

### Port Already in Use
If port 8501 is already in use, the app will detect it and assume Streamlit is already running.

### Streamlit Fails to Start
Check the console output for Python/Streamlit errors. Ensure:
- Python virtual environment is set up in `../LLM/.venv/`
- All Python dependencies are installed
- `gui.py` exists in `../LLM/`

### Icons Not Showing
Generate icons manually or use placeholder PNG files. Electron can work with PNG icons.

## License

MIT

