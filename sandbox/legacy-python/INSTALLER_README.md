# Standalone Installer Components

This directory contains all components for creating standalone installers with auto-detection capabilities.

## Components Overview

### Core Modules

1. **`system_detector.py`** - System detection module
   - Detects Python installations and versions
   - Detects PyTorch and CUDA support
   - Detects GPU hardware
   - Detects Visual C++ Redistributables (Windows)
   - Provides installation recommendations

2. **`smart_installer.py`** - Intelligent installer
   - Uses detection results to make installation decisions
   - Installs missing components automatically
   - Handles PyTorch installation (CPU or CUDA)
   - Installs Visual C++ Redistributables if needed
   - Creates launcher scripts

3. **`launcher.py`** - Application launcher
   - Handles Streamlit server startup
   - Opens browser automatically
   - Checks system requirements
   - Works with both bundled and system Python

4. **`verify_installation.py`** - Post-installation verification
   - Tests all installed components
   - Verifies dependencies
   - Shows detailed status report

5. **`installer_ui.py`** - Optional GUI installer
   - Graphical interface for installation
   - Shows detection results visually
   - Provides installation progress
   - Falls back to console if tkinter unavailable

### Build Configuration

6. **`llm_studio.spec`** - PyInstaller specification
   - Configures executable bundling
   - Includes all dependencies
   - Sets up Streamlit static files
   - Platform-specific settings

7. **`requirements_build.txt`** - Build dependencies
   - PyInstaller
   - Build tools
   - Additional utilities

### Build Scripts

8. **`build_windows_smart.bat`** - Windows build script
   - Installs dependencies
   - Runs PyInstaller
   - Creates NSIS installer

9. **`build_macos_installer.sh`** - macOS build script
   - Creates app bundle
   - Generates DMG installer

10. **`build_linux_installer.sh`** - Linux build script
    - Creates executable
    - Sets up AppDir structure
    - Prepares for AppImage creation

### Installer Scripts

11. **`installer_windows.nsi`** - NSIS installer script
    - Windows installer configuration
    - Component selection
    - Uninstaller creation

## Quick Start

### For Users

1. **Run the installer:**
   ```bash
   python smart_installer.py
   ```

2. **Or use GUI installer:**
   ```bash
   python installer_ui.py
   ```

3. **Verify installation:**
   ```bash
   python verify_installation.py
   ```

4. **Launch application:**
   ```bash
   python launcher.py
   ```

### For Developers

1. **Test system detection:**
   ```bash
   python system_detector.py
   ```

2. **Build installer (Windows):**
   ```cmd
   build_windows_smart.bat
   ```

3. **Build installer (macOS):**
   ```bash
   ./build_macos_installer.sh
   ```

4. **Build installer (Linux):**
   ```bash
   ./build_linux_installer.sh
   ```

## Detection Features

The system detector automatically detects:

- ✅ **Python** - Version, location, pip availability
- ✅ **PyTorch** - Version, CUDA support, device type
- ✅ **CUDA** - Version, GPU count, driver version
- ✅ **Hardware** - CPU cores, RAM, GPU model/memory, disk space
- ✅ **Visual C++** - Installed versions, required DLLs (Windows)

## Installation Recommendations

Based on detection, the installer recommends:

- **Python:** Use existing or install new
- **PyTorch Build:** CPU-only or CUDA (matching detected CUDA version)
- **Visual C++:** Install if missing (Windows)
- **Dependencies:** Install all required packages

## File Structure

```
LLM/
├── system_detector.py          # Detection module
├── smart_installer.py          # Smart installer
├── launcher.py                 # Application launcher
├── verify_installation.py      # Verification script
├── installer_ui.py             # GUI installer (optional)
├── llm_studio.spec             # PyInstaller spec
├── requirements_build.txt       # Build dependencies
├── build_windows_smart.bat     # Windows build script
├── build_macos_installer.sh    # macOS build script
├── build_linux_installer.sh     # Linux build script
├── installer_windows.nsi        # NSIS installer script
├── BUILD.md                     # Build documentation
└── INSTALL.md                   # Installation guide
```

## Testing

Test the detection on your system:
```bash
python system_detector.py
```

Expected output includes:
- Python detection results
- PyTorch status
- CUDA information
- Hardware specifications
- Installation recommendations

## Troubleshooting

See `BUILD.md` for build troubleshooting and `INSTALL.md` for installation troubleshooting.

## Next Steps

1. Test detection on various systems
2. Build installers for your target platforms
3. Test installation on clean VMs
4. Distribute installers to users

