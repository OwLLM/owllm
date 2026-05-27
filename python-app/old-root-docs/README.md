# 🚀 LLM Fine-tuning Studio - Desktop App

A comprehensive local LLM fine-tuning and inference platform with desktop GUI.

---

## 🚀 **HOW TO RUN THE APP**

**Just double-click:**
```
START.bat
```

**That's it!** First time will take 2-3 minutes to set up. After that, it's instant.

---

## 🚨 **After Cloning on a New PC**

**Model weight files are NOT included in Git due to their large size (1-50 GB each)!**

After cloning this repository, you **MUST** download model weights:

### Quick Check (Windows)
```cmd
check_models.bat
```

### Quick Check (Linux/Mac)
```bash
chmod +x check_models.sh
./check_models.sh
```

This will:
- ✅ Check which models are complete
- ❌ List models that need downloading  
- 📋 Provide exact download instructions

### Need Help?

- **Quick Start:** [QUICK_START_AFTER_CLONE.md](QUICK_START_AFTER_CLONE.md)
- **Detailed Guide:** [MODEL_MANAGEMENT_GUIDE.md](MODEL_MANAGEMENT_GUIDE.md)
- **Solution Summary:** [SOLUTION_SUMMARY.md](SOLUTION_SUMMARY.md)

---

## 📁 Project Structure

### Main Files
- **`start_electron.bat`** - Launch the desktop app (USE THIS)
- **`start_electron.sh`** - Launch on Linux/macOS
- **`LLM/gui.py`** - Your working Streamlit GUI (all features)
- **`LLM/train_basic.py`** - Training script

### Electron Desktop App
- **`electron-app/`** - Desktop app wrapper
  - `main.js` - Electron main process
  - `package.json` - Dependencies
  - `node_modules/` - Installed packages

### Build Installers (Optional)
- **`build_electron.bat`** - Build Windows .exe installer
- **`build_electron.sh`** - Build Linux/macOS installers

### Documentation
- **`ELECTRON_SETUP_GUIDE.md`** - Complete setup guide
- **`ELECTRON_BUILD_GUIDE.md`** - How to build installers
- **`ELECTRON_TESTING.md`** - Testing procedures
- **`QUICK_REFERENCE.md`** - Quick command reference

---

## ✨ Features

Your desktop app includes:
- ✅ Native desktop window (not browser-based)
- ✅ Auto-start Streamlit server
- ✅ Beautiful gradient UI
- ✅ Train models with your GPUs (RTX 4090 + A2000)
- ✅ Download models from Hugging Face
- ✅ Test fine-tuned models
- ✅ Validate performance
- ✅ View training history

---

## 🛠️ Requirements

- **Node.js** - Already installed ✅
- **Python 3.12** - Already installed ✅
- **PyTorch with CUDA** - Already installed ✅

---

## 📝 Notes

- First launch may take a few seconds (starting Streamlit)
- DevTools are disabled by default
- System tray icon requires icon files (optional)

---

## 🎯 What Changed

**Before:** Browser-based Streamlit with manual launch
**Now:** Desktop app with one-click launch

**All your training code and features are preserved!**

