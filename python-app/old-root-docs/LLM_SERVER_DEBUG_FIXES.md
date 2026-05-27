# LLM Server Debug Fixes - Applied

## Problems Fixed

### 1. Silent Failures
**Before:** Server could fail silently with no error shown
**After:** All errors are captured and displayed with full details

### 2. Missing Error Details
**Before:** Generic error messages like "Failed to start"
**After:** Full tracebacks, server output, exit codes, and diagnostic info

### 3. Import Path Issues
**Before:** Import path might not work if PYTHONPATH not set
**After:** App root added to Python path explicitly

### 4. No Output Visibility
**Before:** Couldn't see what server was doing during startup
**After:** Server output captured and shown in error messages

---

## Changes Made

### 1. Enhanced Error Handling (`llm_server_manager.py`)

**Added:**
- Detailed logging of Python executable, script paths, working directory
- Process output capture (stdout/stderr combined)
- Better error messages with:
  - Exit code
  - Port number
  - Python executable path
  - Script path
  - Last 20 lines of server output

**Example error now shows:**
```
Server process for 'default' died during startup.
Exit code: 1
Port: 10500
Python: C:\...\python.exe
Script: C:\...\llm_server_start.py

Server output:
ERROR: Failed to load config: ...
Traceback: ...
```

### 2. Improved Server Startup Script (`llm_server_start.py`)

**Added:**
- Explicit PYTHONPATH setup
- Better error handling with tracebacks
- More verbose logging
- Check for CalledProcessError

**Now shows:**
- Launch command
- Working directory
- Python path
- Full traceback on errors

### 3. Better UI Error Display (`server_page.py`)

**Added:**
- Full traceback capture
- Multi-line error logging
- Detailed error dialog with expandable details
- Better visual error indicators

**Now shows:**
- Full error in log (line by line)
- Expandable error dialog
- Clear visual status (● Error in red)

### 4. Debug Documentation

**Created:**
- `LLM_DEBUG_GUIDE.md` - Complete debugging guide
- Step-by-step troubleshooting
- Common issues and solutions
- Manual testing procedures

---

## How to Debug Now

### Step 1: Try Starting Server
1. Go to **Server** tab
2. Click **"▶ Start"** in LLM Server section
3. Watch the log for `[LLM]` messages

### Step 2: Check Error Message
If it fails, you'll see:
- **Status:** `● Error` (red)
- **Log:** Full error with traceback
- **Dialog:** Expandable error details

### Step 3: Common Issues to Check

#### "Model not found"
- Check `base_model` path in `llm_backends.yaml`
- Verify model directory exists

#### "Port in use"
- Check: `netstat -ano | findstr :10500`
- Change port in config or kill process

#### "Failed to launch"
- Check Python executable exists
- Check script path is correct
- Check working directory permissions

#### "Server died during startup"
- Check server output in error message
- Look for import errors
- Check environment has dependencies

#### "Timeout - not healthy"
- Model loading takes 2-3 minutes (normal)
- Check if process is running: `tasklist | findstr python`
- Check server output for loading progress

### Step 4: Manual Test
Run from command line:
```bash
cd C:\1_GitHome\Local-LLM-Server\LLM
python scripts\llm_server_start.py default
```

This will show exactly what's happening.

---

## What You'll See Now

### On Success:
```
[LLM] Starting server (may take 2-3 minutes)...
[LLM] Server ready at http://127.0.0.1:10500
[LLM] OpenAI API: http://127.0.0.1:10500/v1
Status: ● Running (green)
```

### On Failure:
```
[LLM] ❌ Error starting server:
[LLM]   Server process for 'default' died during startup.
[LLM]   Exit code: 1
[LLM]   Port: 10500
[LLM]   Python: C:\...\python.exe
[LLM]   Script: C:\...\llm_server_start.py
[LLM]   
[LLM]   Server output:
[LLM]   ERROR: Model path not found: ...
[LLM]   Traceback: ...
Status: ● Error (red)
```

Plus an error dialog with full details (click "Show Details" to expand).

---

## Next Steps

1. **Restart the app** to load the fixes
2. **Try starting the server** from Server tab
3. **Check the error message** if it fails
4. **Follow the debug guide** (`LLM_DEBUG_GUIDE.md`) for specific issues
5. **Test manually** if needed to see full output

---

## Summary

✅ **Better error messages** - Full details, tracebacks, output
✅ **Improved logging** - See exactly what's happening
✅ **Debug guide** - Step-by-step troubleshooting
✅ **Manual testing** - Can test server startup directly
✅ **UI improvements** - Clear error display with details

**The server should now give you clear error messages if something goes wrong!**
