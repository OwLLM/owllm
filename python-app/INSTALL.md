# Installation Guide for LLM Fine-tuning Studio

This guide explains how to install and use LLM Fine-tuning Studio on Windows, macOS, and Linux.

## System Requirements

### Minimum Requirements
- **OS:** Windows 10+, macOS 10.14+, or Linux (Ubuntu 18.04+)
- **RAM:** 8 GB (16 GB recommended)
- **Disk Space:** 5 GB free space
- **Python:** 3.8 or higher (if not bundled)

### Recommended Requirements
- **RAM:** 16 GB or more
- **GPU:** NVIDIA GPU with CUDA support (optional, for faster training)
- **Disk Space:** 20 GB+ (for models and datasets)

## Installation Methods

### Method 1: Using Installer (Recommended)

#### Windows

1. **Download** `LLM_Studio_Installer.exe`

2. **Run the installer:**
   - Double-click the installer
   - Follow the installation wizard
   - The installer will:
     - Detect your system components (Python, CUDA, Visual C++)
     - Install missing dependencies
     - Create shortcuts

3. **Launch the application:**
   - From Start Menu: `LLM Fine-tuning Studio`
   - Or double-click desktop shortcut

#### macOS

1. **Download** `LLM_Studio.dmg`

2. **Mount and install:**
   - Double-click the DMG file
   - Drag `LLM Fine-tuning Studio.app` to Applications folder
   - Open Applications folder and double-click the app
   - If Gatekeeper blocks it, right-click and select "Open"

3. **Launch the application:**
   - From Applications folder
   - Or use Spotlight search

#### Linux

1. **Download** `LLM_Studio-x86_64.AppImage`

2. **Make executable:**
   ```bash
   chmod +x LLM_Studio-x86_64.AppImage
   ```

3. **Run:**
   ```bash
   ./LLM_Studio-x86_64.AppImage
   ```

### Method 2: Manual Installation

If you prefer manual installation or the installer doesn't work:

#### Prerequisites

1. **Install Python 3.8+**
   - Windows: https://www.python.org/downloads/
   - macOS: `brew install python3` or download from python.org
   - Linux: `sudo apt-get install python3 python3-pip` (Debian/Ubuntu)

2. **Install Visual C++ Redistributables (Windows only)**
   - Download from: https://aka.ms/vs/17/release/vc_redist.x64.exe
   - Run the installer

#### Installation Steps

1. **Clone or download the repository:**
   ```bash
   git clone <repository-url>
   cd Local-LLM-Server/LLM
   ```

2. **Run the smart installer:**
   ```bash
   python smart_installer.py
   ```

   The installer will:
   - Detect your system
   - Install Python dependencies
   - Install PyTorch (CPU or CUDA based on detection)
   - Create launcher scripts

3. **Verify installation:**
   ```bash
   python verify_installation.py
   ```

4. **Launch the application:**
   ```bash
   python launcher.py
   ```

   Or use platform-specific launchers:
   - Windows: `launch_gui.bat`
   - Linux/macOS: `./launch_gui.sh`

## Post-Installation

### First Launch

1. **The application will:**
   - Open in your default web browser
   - Run at `http://localhost:8501`
   - Show system information in the sidebar

2. **Check system status:**
   - Look at the sidebar for:
     - Python version
     - PyTorch version and CUDA support
     - GPU information (if available)
     - System memory

### Verifying Installation

Run the verification script:
```bash
python verify_installation.py
```

This will check:
- Python installation
- PyTorch installation
- CUDA availability (if applicable)
- Required dependencies
- Application files

## Troubleshooting

### Application Won't Start

**Problem:** "Python not found"
**Solution:** 
- Install Python 3.8+ from python.org
- Make sure Python is added to PATH
- Restart your terminal/command prompt

**Problem:** "Streamlit not found"
**Solution:**
```bash
pip install streamlit
```

**Problem:** "Port 8501 already in use"
**Solution:**
- Close other Streamlit applications
- Or change port in `.streamlit/config.toml`

### GPU Not Detected

**Problem:** GPU not showing in system info
**Solution:**
1. Check NVIDIA drivers are installed
2. Verify CUDA is installed: `nvidia-smi`
3. Install CUDA-enabled PyTorch:
   ```bash
   pip install torch --index-url https://download.pytorch.org/whl/cu121
   ```

### Visual C++ Errors (Windows)

**Problem:** DLL errors when running
**Solution:**
1. Install Visual C++ Redistributables:
   - Download: https://aka.ms/vs/17/release/vc_redist.x64.exe
   - Run installer
   - Restart computer

### PyTorch Installation Issues

**Problem:** PyTorch installation fails
**Solution:**
- For CPU-only: `pip install torch`
- For CUDA 12.1: `pip install torch --index-url https://download.pytorch.org/whl/cu121`
- For CUDA 11.8: `pip install torch --index-url https://download.pytorch.org/whl/cu118`

### Model Download Fails

**Problem:** Can't download models from Hugging Face
**Solution:**
1. Check internet connection
2. Verify Hugging Face Hub is installed: `pip install huggingface_hub`
3. Check firewall settings
4. Try downloading manually from Hugging Face website

## Uninstallation

### Windows

1. **Using Control Panel:**
   - Open "Programs and Features"
   - Find "LLM Fine-tuning Studio"
   - Click "Uninstall"

2. **Using Start Menu:**
   - Find "LLM Fine-tuning Studio" folder
   - Click "Uninstall"

### macOS

1. **Delete the app:**
   - Open Applications folder
   - Drag `LLM Fine-tuning Studio.app` to Trash
   - Empty Trash

### Linux

1. **Delete files:**
   ```bash
   rm -rf ~/.local/share/llm-studio
   rm ~/.local/bin/LLM_Studio  # if installed to PATH
   ```

## Getting Help

If you encounter issues:

1. **Check system requirements** - Make sure your system meets minimum requirements
2. **Run verification:** `python verify_installation.py`
3. **Check logs** - Look for error messages in the console
4. **Review documentation** - Check BUILD.md for build-specific issues

## Next Steps

After installation:

1. **Download a model** - Use the "Download Models" page
2. **Prepare your dataset** - Create JSONL format training data
3. **Start training** - Use the "Train Model" page
4. **Test your model** - Use the "Test Model" page

Enjoy fine-tuning your LLMs!

