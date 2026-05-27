# 🚀 LLM Fine-tuning Studio - START HERE

## ⚡ QUICK START (Works on ANY Windows PC)

**Just double-click:**
```
START.bat
```

That's it! The launcher will:
1. ✅ Check if Python is installed
2. ✅ Create a virtual environment (first time only)
3. ✅ Install required GUI libraries (first time only)  
4. ✅ Launch the application
5. ✅ Show helpful errors if anything goes wrong

**No admin rights needed. No PowerShell policy changes needed.**

---

## 🎯 What Each Launcher Does

| File | Description | When to Use |
|------|-------------|-------------|
| **`START.bat`** ⭐ | **RECOMMENDED** - Foolproof launcher | Always use this |
| `START.py` | Python launcher (called by START.bat) | If you want to customize |
| `SIMPLE_START.bat` | Alternative batch-only launcher | If Python launcher fails |
| `LLM/Launcher3.exe` | Compiled C++ launcher | Advanced users |

---

## 📋 Requirements

- **Windows 10/11**
- **Python 3.8 or higher**
  - Download from: https://www.python.org/downloads/
  - ⚠️ **IMPORTANT:** Check "Add Python to PATH" during installation!

That's all! Everything else installs automatically.

---

## 🔧 First-Time Setup (Automatic)

When you run `START.bat` for the first time:

```
[1/3] Creating virtual environment...     (~30 seconds)
[2/3] Upgrading pip...                    (~10 seconds)
[3/3] Installing GUI library (PySide6)... (~60 seconds)

✓ SETUP COMPLETE!
```

**This only happens once.** Future launches are instant.

---

## 🚨 Troubleshooting

### "Python not found"
**Problem:** Python isn't installed or not in PATH

**Solution:**
1. Install Python from https://www.python.org/downloads/
2. During installation, check ☑️ "Add Python to PATH"
3. Restart your terminal/command prompt
4. Run `START.bat` again

### "Could not install PySide6"
**Problem:** No internet connection or firewall blocking

**Solution:**
1. Check your internet connection
2. Temporarily disable antivirus/firewall
3. Try running as Administrator (right-click START.bat → Run as Administrator)

### "Application crashed or failed to start"
**Problem:** Corrupted installation or missing dependencies

**Solution:**
1. Delete the `LLM\.venv` folder
2. Delete the `LLM\.setup_complete` file
3. Run `START.bat` again (will redo setup)

### GUI window doesn't appear
**Problem:** Window might be hidden or minimized

**Solution:**
1. Check your taskbar for a Python/LLM Studio window
2. Press `Alt+Tab` to see all windows
3. Check Task Manager → processes named "python.exe" or "pythonw.exe"
4. If process is running but no window, kill it and restart

### Still stuck?
1. Run `SIMPLE_START.bat` to see detailed error messages
2. Check logs in `LLM\logs\app.log`
3. Try deleting `.venv` and `.setup_complete` and starting over

---

## 💡 For Developers

### Project Structure
```
Local-LLM-Server/
├── START.bat              ⭐ Main launcher (USE THIS)
├── START.py               Python launcher logic
├── SIMPLE_START.bat       Alternative batch launcher
├── LLM/
│   ├── desktop_app/
│   │   └── main.py        Main GUI application
│   ├── .venv/             Virtual environment (auto-created)
│   ├── .setup_complete    Marker file (auto-created)
│   ├── Launcher3.exe      Compiled C++ launcher
│   └── logs/              Application logs
└── README_START.md        This file
```

### The Launcher System

**Why multiple launchers?**
- Different PCs have different quirks (PowerShell policies, execution restrictions, etc.)
- Multiple options ensure SOMETHING works on EVERY PC
- START.bat + START.py is the most reliable combination

**How it works:**
1. `START.bat` calls `START.py` with Python
2. `START.py` checks for virtual environment
3. If missing, creates venv and installs PySide6
4. Launches `desktop_app.main` in the venv
5. Shows helpful error dialogs if anything fails

**No external dependencies:**
- Uses only Python standard library
- PySide6 is installed into isolated venv
- Doesn't touch system Python
- Completely portable

### Customizing the Launcher

Edit `START.py` to customize:
- Change welcome messages
- Add pre-launch checks
- Install additional packages
- Modify error handling

The launcher is designed to be **simple**, **reliable**, and **work everywhere**.

---

## ✨ Features

Once the app launches, you get:

- 🤖 **Fine-tune LLMs** using your own data
- 💬 **Chat with models** (base or fine-tuned)
- 📥 **Download models** from Hugging Face
- 🎯 **Hardware detection** (auto-detects CUDA GPUs)
- 📊 **Training history** and metrics
- 🔧 **Easy configuration** - no command line needed

---

## 🎓 After Launch

### First-Time Users
1. The app will detect your hardware (GPUs, RAM, etc.)
2. Go to the "Models" tab to download a base model
3. Go to the "Training" tab to fine-tune with your data
4. Go to the "Chat" tab to test your models

### Training Your First Model
1. Prepare training data (JSONL format)
2. Select a base model
3. Configure hyperparameters (or use defaults)
4. Click "Start Training"
5. Monitor progress in real-time

### Need Models?
Models are downloaded from Hugging Face.
Run `check_models.bat` to see which models you have.
See [MODEL_MANAGEMENT_GUIDE.md](MODEL_MANAGEMENT_GUIDE.md) for details.

---

## 🤝 Distribution

To share with others:
1. Commit `START.bat`, `START.py`, and `SIMPLE_START.bat`
2. **Don't commit** `.venv/` or `.setup_complete`
3. Others just double-click `START.bat` on their PC

The launcher handles all setup automatically!

---

## 📝 Technical Notes

- **Virtual Environment:** Isolated from system Python, prevents conflicts
- **PySide6:** Qt-based GUI framework, professional desktop UI
- **Windows-Only:** Currently Windows-specific (Linux/Mac support possible)
- **No Admin Rights:** Everything installs in user directory
- **Portable:** Can run from USB drive or any location

---

**Made with ❤️ for hassle-free LLM fine-tuning**

🚀 **Now go double-click `START.bat` and start training!**

