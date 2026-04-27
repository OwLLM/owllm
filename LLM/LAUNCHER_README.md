# 🚀 Professional Windows Launcher System

This directory contains a professional Windows launcher system that provides a clean, no-console startup experience for the LLM Fine-tuning Studio.

## 📁 Launcher Files

### Primary Entry Points
- **`launcher.exe`** - Native Windows GUI stub (recommended double-click target)
  - Embedded icon (via `launcher.rc`)
  - No console window; starts **`launcher_worker.exe`** next to it with `CREATE_NO_WINDOW` so the full bootstrap runs under a hidden inherited console (reduces CMD flashes from child tools)
- **`launcher_worker.exe`** - Console worker (not for direct double-click)
  - Contains the full venv / health-check / `python -m desktop_app.main` logic
  - Shipped next to `launcher.exe`; rebuilt by `build_launcher.bat`

- **`LAUNCHER.bat`** - Batch script launcher (alternative)
  - Shows brief console then closes
  - Same routing as `launcher.exe`
  - Useful for scripting/automation

- **`LAUNCHER_DEBUG.bat`** - Debug mode launcher
  - Keeps console open
  - Shows verbose output
  - Useful for troubleshooting

### Supporting Files
- **`launcher.cpp`** - C++ source code for native launcher
- **`launcher.rc`** - Windows resource file (icon + version info)
- **`rocket.ico`** - Custom rocket icon (multi-resolution)
- **`build_launcher.bat`** - Compilation script
- **`create_launcher_shortcut.ps1`** - Creates desktop shortcut
- **`create_rocket_ico.py`** - Generates the rocket icon

## 🔧 How It Works

### Startup Flow

```
User double-clicks launcher.exe
  ↓
launcher.exe starts launcher_worker.exe (hidden console)
  ↓
Check if .setup_complete exists
  ↓
NO → Run first_run_setup.py
      ↓
      Setup wizard detects hardware & installs dependencies
      ↓
      On success: creates .setup_complete marker
      ↓
YES → Skip setup
  ↓
Launch desktop_app.main
  ↓
Logs captured to logs/app.log
  ↓
On error: Opens Notepad with log file
```

### Key Features

1. **No Lingering Console**
   - Uses `pythonw.exe` (GUI mode Python) for the PySide6 app
   - `launcher.exe` stays resident until you close the app (it waits on `launcher_worker.exe`, which waits on Python)
   - Professional Windows application behavior

2. **Automatic Setup Routing**
   - Detects `.setup_complete` marker
   - First run → setup wizard
   - Subsequent runs → main app

3. **Error Handling**
   - All output redirected to log files
   - Non-zero exit → opens log in Notepad
   - Clear error messages

4. **Cross-PC Portability**
   - Icon embedded in .exe
   - Static linking (no external DLLs)
   - Relative paths only

## 📝 Usage

### For End Users

**Option 1: Use the shortcut (easiest)**
1. Run `create_launcher_shortcut.ps1` (first time only)
2. Double-click "Launch LLM Studio.lnk"
3. App starts, no console window

**Option 2: Use the executable directly**
- Just double-click `launcher.exe`

**Option 3: Use the batch script**
- Double-click `LAUNCHER.bat`
- Brief console flash, then closes

### For Developers

**Building the launcher:**
```batch
# One-time setup: Install MinGW-w64
# Download from https://winlibs.com/

# Compile the launcher
build_launcher.bat

# Test it
launcher.exe
```

**Debugging issues:**
```batch
# Use debug mode to see console output
LAUNCHER_DEBUG.bat

# Or check the logs
notepad logs\app.log
notepad logs\setup.log
```

**Modifying the launcher:**
1. Edit `launcher.cpp`
2. Run `build_launcher.bat`
3. Commit the new `launcher.exe` **and** `launcher_worker.exe`

## 📂 Directory Structure

```
LLM/
├── launcher.exe              # GUI stub (double-click this)
├── launcher_worker.exe       # Full bootstrap + app launch (hidden)
├── launcher.cpp              # C++ source
├── launcher.rc               # Resource file
├── rocket.ico                # Custom icon
├── LAUNCHER.bat              # Batch launcher
├── LAUNCHER_DEBUG.bat        # Debug launcher
├── build_launcher.bat        # Build script
├── create_launcher_shortcut.ps1
├── create_rocket_ico.py
├── first_run_setup.py        # Setup wizard
├── desktop_app/
│   └── main.py               # Main GUI app
└── logs/
    ├── setup.log             # First-run setup logs
    └── app.log               # Application logs
```

## 🐛 Troubleshooting

### Launcher doesn't start
1. Run `LAUNCHER_DEBUG.bat` to see errors
2. Check if Python venv exists: `.venv\Scripts\pythonw.exe`
3. Check logs: `logs\app.log`

### Icon doesn't show
- The icon is embedded in `launcher.exe`
- Shortcut should automatically use it
- If not, right-click shortcut → Properties → Change Icon → Browse to `launcher.exe`

### Console window stays open
- Make sure you're using `launcher.exe`, not `LAUNCHER.bat`
- Batch launcher has a brief flash, but should close
- Use `LAUNCHER_DEBUG.bat` if you want console to stay open

### Setup fails
1. Check `logs\setup.log` for details
2. Common issues:
   - No internet connection
   - Antivirus blocking downloads
   - Disk space
3. Delete `.setup_complete` to retry setup

### PySide6 DLL errors
The launcher automatically detects and repairs PySide6 corruption:
- **Auto-repair**: If PySide6 import fails, launcher runs repair automatically
- **Version requirement**: ALL PySide6 packages must be at version 6.8.1:
  - `PySide6==6.8.1`
  - `PySide6-Essentials==6.8.1`
  - `PySide6-Addons==6.8.1`
  - `shiboken6==6.8.1`
- **Why**: Version mismatches cause "procedure could not be found" errors
- **Repair logs**: Check `logs\auto_repair.log` and `logs\app.log` for details

## 🔄 For Distribution

When distributing to other PCs:
1. **Include** `launcher.exe` in the repo
2. **Don't include** `.setup_complete` marker
3. **Don't include** `.venv` directory
4. **Don't include** `logs/*.log` files

Users just need to:
1. Clone/extract the repo
2. Double-click `launcher.exe`
3. Wait for first-run setup
4. Done!

## 📜 Technical Details

### Compilation
- **Compiler**: MinGW-w64 (GCC for Windows)
- **Flags**: `-O2 -s -mwindows -static -static-libgcc -static-libstdc++`
- **Libraries**: `shlwapi.lib` (for file operations)
- **Icon**: Embedded via `windres` (Windows Resource Compiler)

### Static Linking
The launcher is fully statically linked, meaning:
- ✅ No external DLL dependencies (except Windows system DLLs)
- ✅ Works on any Windows PC
- ✅ No need to distribute MinGW runtime
- ✅ Single ~350KB executable

### Process Management
- Uses `CreateProcessW` for launching Python
- Redirects stdout/stderr to log files via `STARTUPINFO.hStdOutput`
- Waits for child process with `WaitForSingleObject`
- Checks exit code with `GetExitCodeProcess`

## 🎯 Design Goals

1. **Professional UX** - No lingering console windows
2. **Self-Installing** - First-run setup wizard
3. **Cross-PC Reliable** - Static linking, embedded icon
4. **Developer-Friendly** - Debug mode, logs, clear errors
5. **Minimal Dependencies** - Single .exe + Python venv

---

**Made with ❤️ for the LLM Fine-tuning Studio**

