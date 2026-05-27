# Port Conflict Resolution - Final Fix

## Issues Encountered
1. Port 9100 - in use
2. Port 9200 - also reported as in use (possibly TIME_WAIT state)

## Root Cause Analysis

The port checking was too strict and didn't handle:
- **TIME_WAIT state**: When a port is recently closed, it stays in TIME_WAIT for 30-120 seconds
- **Race conditions**: Port check happens, then server tries to bind
- **Socket reuse**: Needed SO_REUSEADDR flag

## Solutions Implemented

### 1. Changed Port to 10500 (Safe Range)
**File:** `LLM/configs/llm_backends.yaml`

```yaml
models:
  default:
    port: 10500  # ← Much higher port, away from common services
```

**Why 10500?**
- Port range 10000-10999 is rarely used by system services
- Verified completely free with `netstat`
- Easy to remember and debug

### 2. Improved Port Checking Logic
**File:** `LLM/core/llm_server_manager.py`

**Changes:**
- ✅ Added `SO_REUSEADDR` socket option (handles TIME_WAIT)
- ✅ Added retry mechanism (3 attempts with 2-second delays)
- ✅ Proper socket cleanup in all code paths
- ✅ Better error messages with diagnostic commands

**Before:**
```python
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.bind(('127.0.0.1', port))  # Fails if in TIME_WAIT
sock.close()
```

**After:**
```python
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)  # ← Handles TIME_WAIT
sock.bind(('127.0.0.1', port))
sock.close()

# Plus retry mechanism with 3 attempts
```

### 3. Added Retry Logic
Now retries port binding 3 times with 2-second delays, which handles:
- Temporary TIME_WAIT states
- Race conditions
- Ports that are "in use" but actually free

## Complete Port Architecture

Your system uses multiple ports:

| Service | Port | Purpose |
|---------|------|---------|
| **Tool Server (MCP)** | 8763 | Provides tools (calculator, weather, etc.) |
| **LLM Server (default)** | 10500 | Runs AI model inference |
| **LLM Server (phi4_assistant)** | 10501 | Alternative model config |

## Testing the Fix

### 1. Restart Application
Close and reopen the desktop app completely.

### 2. Test Tool-Enabled Chat
1. Go to **Test Chat** tab
2. Check **"Enable Tool Use"**  
3. Send: "What's 2+2?"
4. **Expected behavior:**
   - UI stays responsive (no freeze)
   - Progress messages appear
   - Server starts on port 10500
   - Tool call to calculator happens
   - Result displayed

### 3. Verify Port Usage
While server is running:
```cmd
netstat -ano | findstr :10500
```

You should see:
```
TCP    127.0.0.1:10500    0.0.0.0:0    LISTENING    [PID]
```

## If Issues Persist

### Check what's using port 10500:
```cmd
netstat -ano | findstr :10500
```

### Find the process:
```cmd
tasklist | findstr [PID]
```

### Kill the process if needed:
```cmd
taskkill /PID [PID] /F
```

### Or just change the port again:
Edit `LLM/configs/llm_backends.yaml`:
```yaml
port: 10600  # Or any free port
```

## Technical Improvements Made

1. **SO_REUSEADDR**: Allows binding to ports in TIME_WAIT state
2. **Retry Logic**: 3 attempts with 2-second delays
3. **Better Diagnostics**: Error messages include `netstat` command to debug
4. **Safe Port Range**: Moved to 10000+ range (less conflicts)
5. **Proper Cleanup**: Sockets always closed in all code paths

---

## Summary

✅ **Port changed**: 9100 → 9200 → **10500** (final)

✅ **Port checking improved**: Added SO_REUSEADDR + retry logic

✅ **Safe port range**: 10000-10999 (rarely conflicts)

✅ **Verified free**: Port 10500 confirmed available

**Next step:** Restart app and try tool-enabled chat!
