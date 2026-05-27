# Building Standalone Installers for LLM Fine-tuning Studio

This guide explains how to build standalone installers for Windows, macOS, and Linux.

## Prerequisites

### All Platforms
- Python 3.8 or higher
- pip (usually comes with Python)
- Git (to clone the repository)

### Windows
- NSIS (Nullsoft Scriptable Install System) - Download from https://nsis.sourceforge.io/
  - Add NSIS to your PATH or install to default location
- Visual Studio Build Tools (optional, for compiling Python extensions)

### macOS
- Xcode Command Line Tools: `xcode-select --install`
- hdiutil (comes with macOS, for creating DMG files)

### Linux
- Build essentials: `sudo apt-get install build-essential` (Debian/Ubuntu)
- appimagetool (for AppImage): Download from https://github.com/AppImage/AppImageKit/releases

## Building for Windows

1. **Install NSIS** (if not already installed)
   - Download from https://nsis.sourceforge.io/
   - Install and add to PATH

2. **Open Command Prompt or PowerShell** in the `LLM` directory

3. **Run the build script:**
   ```cmd
   build_windows_smart.bat
   ```

4. **The build process will:**
   - Install build dependencies (PyInstaller)
   - Install application dependencies
   - Run system detection test
   - Build executable with PyInstaller
   - Copy application files
   - Create NSIS installer (if NSIS is available)

5. **Output files:**
   - `dist\LLM_Studio.exe` - Standalone executable
   - `dist\LLM_Studio_Installer.exe` - Windows installer (if NSIS was available)

## Building for macOS

1. **Open Terminal** in the `LLM` directory

2. **Make scripts executable:**
   ```bash
   chmod +x build_macos_installer.sh
   ```

3. **Run the build script:**
   ```bash
   ./build_macos_installer.sh
   ```

4. **The build process will:**
   - Install build dependencies
   - Install application dependencies
   - Run system detection test
   - Build executable with PyInstaller
   - Create macOS app bundle
   - Create DMG installer

5. **Output files:**
   - `dist/LLM_Studio.app` - macOS application bundle
   - `dist/LLM_Studio.dmg` - DMG installer

## Building for Linux

1. **Open Terminal** in the `LLM` directory

2. **Make scripts executable:**
   ```bash
   chmod +x build_linux_installer.sh
   ```

3. **Run the build script:**
   ```bash
   ./build_linux_installer.sh
   ```

4. **The build process will:**
   - Install build dependencies
   - Install application dependencies
   - Run system detection test
   - Build executable with PyInstaller
   - Create AppDir structure

5. **Create AppImage (optional):**
   ```bash
   wget https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage
   chmod +x appimagetool-x86_64.AppImage
   ./appimagetool-x86_64.AppImage dist/LLM_Studio.AppDir
   ```

6. **Output files:**
   - `dist/LLM_Studio` - Linux executable
   - `dist/LLM_Studio.AppDir` - AppDir structure
   - `dist/LLM_Studio-x86_64.AppImage` - AppImage (after running appimagetool)

## Manual Build Process

If you prefer to build manually:

### 1. Install Build Dependencies
```bash
pip install -r requirements_build.txt
```

### 2. Install Application Dependencies
```bash
pip install -r requirements.txt
```

### 3. Test System Detection
```bash
python system_detector.py
```

### 4. Build with PyInstaller
```bash
pyinstaller --clean llm_studio.spec
```

### 5. Create Installer (Platform-specific)

**Windows (NSIS):**
```cmd
makensis installer_windows.nsi
```

**macOS (DMG):**
```bash
# Create app bundle manually, then:
hdiutil create -volname "LLM Fine-tuning Studio" -srcfolder dist/LLM_Studio.app -ov -format UDZO dist/LLM_Studio.dmg
```

**Linux (AppImage):**
```bash
# Use appimagetool as shown above
```

## Troubleshooting

### PyInstaller Issues

**Problem:** "ModuleNotFoundError" during build
**Solution:** Add missing modules to `hiddenimports` in `llm_studio.spec`

**Problem:** Large executable size
**Solution:** This is normal due to PyTorch and dependencies. Consider using CPU-only PyTorch for smaller builds.

**Problem:** Streamlit static files not found
**Solution:** Ensure `datas` section in `llm_studio.spec` includes Streamlit static files

### NSIS Issues (Windows)

**Problem:** "makensis: command not found"
**Solution:** Install NSIS and add to PATH, or use full path to makensis.exe

**Problem:** Installer doesn't run detection
**Solution:** Check NSIS script syntax and ensure Python detection code is correct

### macOS Issues

**Problem:** "hdiutil: command not found"
**Solution:** hdiutil comes with macOS. If missing, reinstall macOS command line tools

**Problem:** App won't run (Gatekeeper)
**Solution:** Right-click app, select "Open", then confirm. Or disable Gatekeeper temporarily for testing.

### Linux Issues

**Problem:** "Permission denied" when running executable
**Solution:** `chmod +x dist/LLM_Studio`

**Problem:** Missing shared libraries
**Solution:** Install system dependencies or use AppImage format which bundles everything

## Testing the Build

After building, test the installer:

1. **Test on clean system** (VM recommended)
2. **Run system detection:**
   ```bash
   python system_detector.py
   ```
3. **Verify installation:**
   ```bash
   python verify_installation.py
   ```
4. **Launch application:**
   ```bash
   python launcher.py
   # or
   ./launch_gui.sh  # Linux/macOS
   # or
   launch_gui.bat    # Windows
   ```

## File Sizes

Expected file sizes:
- **Windows executable:** ~500MB - 1GB (depending on PyTorch version)
- **macOS app bundle:** ~500MB - 1GB
- **Linux executable:** ~500MB - 1GB
- **Installers:** Slightly larger due to compression

## Next Steps

- Test on multiple systems
- Create code-signed installers (for distribution)
- Set up CI/CD for automated builds
- Create update mechanism

