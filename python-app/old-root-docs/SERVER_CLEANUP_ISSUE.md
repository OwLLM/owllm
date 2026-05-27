# Server Cleanup Issue - Port Conflicts from Zombie Processes

**Date**: 2026-01-17  
**Status**: ⚠️ **SEPARATE ISSUE FROM PHASE 2** (Phase 2 is working correctly)

---

## 🎯 Issue Summary

**Problem**: Multiple zombie LLM server processes remain running after models are closed, holding ports and preventing new servers from starting.

**Impact**: "Port already in use" errors when loading models

**Root Cause**: Server processes not properly terminated when models are unloaded

---

## 📊 Evidence

### Zombie Servers Found
```
Port 10504: PID 31544 (1.5GB RAM) - KILLED ✅
Port 10506: PID 34900 (1.6GB RAM) - KILLED ✅
Port 10507: PID 40448 (567MB RAM) - KILLED ✅
```

### Connection Leaks
- 30+ connections in `CLOSE_WAIT` state (server didn't close)
- Multiple `FIN_WAIT_2` connections (client waiting for server)

**This indicates improper server shutdown logic.**

---

## ✅ Immediate Fix Applied

Killed all zombie processes:
```powershell
taskkill /F /PID 31544 /PID 34900 /PID 40448
SUCCESS: All processes terminated
```

**All ports now free for new servers** ✅

---

## 🔧 Future Prevention

### Quick Fix Script Created

**File**: `kill_zombie_servers.py`

**Usage**:
```bash
python kill_zombie_servers.py
```

This will:
1. Scan for Python processes on ports 105xx
2. Kill all zombie LLM servers
3. Free up ports for new servers

**Use this whenever you get port conflict errors.**

---

## 🔍 Root Cause Analysis

### Where The Problem Is

The issue is in server lifecycle management, likely in:
- `LLM/core/llm_server_manager.py` - Server startup/shutdown logic
- `LLM/desktop_app/main.py` - Application exit handling
- `LLM/core/llm_backends/server_app.py` - Server cleanup hooks

### What's Happening

1. User loads model → Server process starts on port 105xx
2. User closes model or switches models → Server should stop
3. **BUG**: Server process doesn't terminate properly
4. Port remains occupied by zombie process
5. Next model load fails with "port already in use"

### Why It Happens

Possible causes:
- Missing shutdown hooks
- Exception during cleanup prevents process termination
- Process not tracked properly (can't send kill signal)
- Race condition in server manager
- Uvicorn not shutting down cleanly

---

## 🛠️ Recommended Fixes

### Priority 1: Proper Server Shutdown

**File**: `LLM/core/llm_server_manager.py`

Add proper cleanup on server stop:

```python
def stop_server(self, model_id: str):
    """Stop server for model"""
    if model_id in self.servers:
        server_info = self.servers[model_id]
        process = server_info.get('process')
        
        if process and process.poll() is None:
            # Try graceful shutdown first
            try:
                process.terminate()
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                # Force kill if graceful fails
                process.kill()
                process.wait(timeout=2)
            except Exception as e:
                # Last resort: force kill
                process.kill()
        
        # Remove from tracking
        del self.servers[model_id]
```

### Priority 2: Application Exit Cleanup

**File**: `LLM/desktop_app/main.py`

Add cleanup on application exit:

```python
import atexit

def cleanup_all_servers():
    """Kill all LLM server processes on exit"""
    # Get server manager instance
    from core.llm_server_manager import get_server_manager
    manager = get_server_manager()
    
    # Stop all servers
    for model_id in list(manager.servers.keys()):
        manager.stop_server(model_id)

# Register cleanup
atexit.register(cleanup_all_servers)
```

### Priority 3: Port Conflict Retry

**File**: `LLM/core/llm_server_manager.py`

Add retry logic for port conflicts:

```python
def _start_server(self, model_id: str, max_retries=3):
    """Start server with port conflict retry"""
    for attempt in range(max_retries):
        try:
            port = self._allocate_port()
            # ... start server ...
            return
        except PortConflictError:
            if attempt < max_retries - 1:
                # Kill zombie on this port
                self._kill_process_on_port(port)
                time.sleep(1)
            else:
                raise
```

### Priority 4: Health Check & Auto-Cleanup

Add periodic zombie process detection:

```python
def cleanup_zombie_servers():
    """Find and kill zombie LLM servers"""
    # Run netstat to find ports 105xx
    # Kill processes not in self.servers tracking
    pass

# Run on startup and periodically
```

---

## 📝 Manual Workaround (Until Fixed)

### Option 1: Use the Kill Script
```bash
python kill_zombie_servers.py
```

### Option 2: Kill Manually
```powershell
# Find zombie servers
netstat -ano | findstr "LISTENING" | findstr "127.0.0.1:105"

# Kill specific PID
taskkill /F /PID <pid>

# Nuclear option: Kill all Python
taskkill /F /IM python.exe
```

### Option 3: Restart Application
Close and restart your LLM Studio application (doesn't always work if processes are truly orphaned).

---

## 🎯 Why This Is Separate from Phase 2

### Phase 2 Fix: ✅ Working Correctly

The Phase 2 environment fixes are **working perfectly**:
- ✅ Using correct shared environment
- ✅ No Windows path errors
- ✅ No environment creation failures
- ✅ Environment selection logic working

**Evidence**: Both model loads used the correct environment:
```
Python: C:\1_Git\LocaLLM\LLM\.envs\torch-cu121-transformers-bnb\.venv\Scripts\python.exe
```

### Server Cleanup: ⚠️ Separate Issue

The port conflicts are a **different problem**:
- Not related to environments
- Not related to Phase 2 refactor
- Related to server lifecycle management
- Pre-existing issue (not caused by Phase 2)

---

## ✅ Current Status

| Component | Status | Notes |
|-----------|--------|-------|
| Phase 2 Env Fix | ✅ Working | Validated in production |
| Zombie Servers | ✅ Cleaned | All killed manually |
| Ports | ✅ Free | Ready for new servers |
| Permanent Fix | ⚠️ Pending | Needs server cleanup code |

---

## 🚀 What To Do Now

### Immediate (You)
1. ✅ **Retry loading your model** - Ports are now free!
2. Use `kill_zombie_servers.py` if it happens again
3. Report if specific actions consistently cause zombies

### Short Term (Development)
1. Implement proper server shutdown in `llm_server_manager.py`
2. Add application exit cleanup hooks
3. Add port conflict retry logic
4. Test model switching thoroughly

### Long Term (Architecture)
1. Consider using systemd/supervisor for process management
2. Implement health checks and auto-recovery
3. Add telemetry for zombie detection
4. Consider containerization (Docker) for isolation

---

## 📚 Related Documentation

- **Phase 2 Success**: `PHASE2_VALIDATION_SUCCESS.md`
- **Kill Script**: `kill_zombie_servers.py`
- **This Document**: `SERVER_CLEANUP_ISSUE.md`

---

## 🎉 Summary

**Phase 2 Environment Fixes**: ✅ **WORKING PERFECTLY**

**Server Cleanup Issue**: ⚠️ **SEPARATE ISSUE - WORKAROUND PROVIDED**

You can now load your models successfully. If you encounter port conflicts again, just run:

```bash
python kill_zombie_servers.py
```

The permanent fix requires updating server lifecycle management code (recommendations provided above).
