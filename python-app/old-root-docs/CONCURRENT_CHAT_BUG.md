# Concurrent Chat Issue - Root Cause Found! 🎯

**Date**: 2026-01-17  
**Status**: 🔴 **CRITICAL BUG IDENTIFIED**

---

## 🎯 User's Insight: CORRECT!

**User Said**: "Maybe it is because 2 chats are responding at the same time?"

**Analysis**: ✅ **EXACTLY RIGHT!**

This explains:
- Multiple zombie servers (3 different ones)
- Port conflicts even on "free" ports
- Why it happens during concurrent operations

---

## 🐛 Root Cause: NO THREAD SAFETY

### Code Analysis

**File**: `LLM/core/llm_server_manager.py`

#### Problem 1: Unprotected Global State (Line 50)
```python
self.running_servers: Dict[str, subprocess.Popen] = {}
```

**Issue**: No locks, no synchronization. When 2 threads access this:
```
Thread 1: Check if server exists → NOT FOUND
Thread 2: Check if server exists → NOT FOUND
Thread 1: Start server on port 10507
Thread 2: Start server on port 10507 → PORT CONFLICT!
```

#### Problem 2: Global Manager Without Locks (Lines 531-546)
```python
_global_manager: Optional[LLMServerManager] = None

def get_global_server_manager() -> LLMServerManager:
    global _global_manager
    if _global_manager is None:  # ← RACE CONDITION
        _global_manager = LLMServerManager(config_path)
    return _global_manager
```

**Issue**: Classic race condition - multiple threads can create multiple managers!

#### Problem 3: StateStore Synchronization (Line 43)
```python
self.state_store = get_state_store()
```

The StateStore uses SQLite, which has some thread safety, but the server manager doesn't coordinate with it properly.

---

## 💥 What Happens With 2 Concurrent Chats

### Scenario: User Has 2 Chat Windows Open

```
Time  | Chat 1                          | Chat 2
------+---------------------------------+--------------------------------
T1    | Load Phi-4                      | Load Nemotron
T2    | Check port 10504 → FREE         | Check port 10506 → FREE
T3    | Allocate port 10504             | Allocate port 10506
T4    | Start server PID 31544          | Start server PID 34900
T5    | Store in running_servers        | Store in running_servers
T6    | Both servers running ✅         | Both servers running ✅
------|--------------------------------|--------------------------------
T7    | Chat completes, no cleanup      | Chat completes, no cleanup
T8    | Server 31544 becomes zombie     | Server 34900 becomes zombie
------|--------------------------------|--------------------------------
T9    | Load Phi-4 again                | Load another model
T10   | Check port 10504 → IN USE! ❌   | Check port 10506 → IN USE! ❌
T11   | Try port 10507                  | Try port 10507
T12   | BOTH try to start on 10507      | PORT CONFLICT!
T13   | Race condition!                 | Both fail!
```

### Why Cleanup Fails

1. **Thread 1** finishes inference → Doesn't stop server (no cleanup hook)
2. **Thread 2** finishes inference → Doesn't stop server (no cleanup hook)
3. Both servers keep running (zombies)
4. `running_servers` dict goes out of scope → Process tracking lost
5. New requests can't detect existing servers properly

---

## 🛠️ The Fix: Add Thread Safety

### Fix 1: Add Threading Lock (CRITICAL)

```python
import threading

class LLMServerManager:
    def __init__(self, config_path: Path):
        # ... existing code ...
        
        # ADD: Thread safety lock
        self._server_lock = threading.RLock()
        
        # Track running server processes
        self.running_servers: Dict[str, subprocess.Popen] = {}
```

### Fix 2: Protect All Server Operations

```python
def ensure_server_running(self, model_id: str, log_callback=None) -> str:
    """Ensure server is running with thread safety"""
    with self._server_lock:  # ← ADD THIS
        # Existing implementation...
        pass

def _start_server(self, model_id: str, log_callback=None):
    """Start server with lock protection"""
    with self._server_lock:  # ← ADD THIS
        # Check if already starting
        server_state = self.state_store.get_server(model_id)
        if server_state and server_state['status'] == 'STARTING':
            raise RuntimeError(f"Server {model_id} already starting")
        
        # Mark as STARTING in StateStore (atomic)
        self.state_store.upsert_server(
            model_id=model_id,
            status='STARTING'
        )
        
        # Existing implementation...
        pass

def shutdown_server(self, model_id: str):
    """Shutdown with lock protection"""
    with self._server_lock:  # ← ADD THIS
        # Existing implementation...
        pass
```

### Fix 3: Use StateStore for Process Tracking

Instead of `self.running_servers` dict, use StateStore:

```python
def _start_server(self, model_id: str, log_callback=None):
    with self._server_lock:
        # ... start process ...
        
        # Store process info in StateStore (shared across threads)
        self.state_store.upsert_server(
            model_id=model_id,
            port=port,
            pid=process.pid,  # ← Store PID
            status='RUNNING'
        )
        
        # Keep local reference too
        self.running_servers[model_id] = process
```

Then check StateStore first:

```python
def ensure_server_running(self, model_id: str, log_callback=None) -> str:
    with self._server_lock:
        # Check StateStore for existing server (shared state)
        server_state = self.state_store.get_server(model_id)
        
        if server_state and server_state.get('pid'):
            # Check if process is actually alive
            if self._is_process_alive(server_state['pid']):
                # Reuse existing server
                return f"http://127.0.0.1:{server_state['port']}"
        
        # Start new server
        self._start_server(model_id, log_callback)
```

### Fix 4: Singleton Manager with Lock

```python
import threading

_global_manager: Optional[LLMServerManager] = None
_manager_lock = threading.Lock()

def get_global_server_manager() -> LLMServerManager:
    """Thread-safe global manager"""
    global _global_manager
    
    if _global_manager is None:
        with _manager_lock:  # ← Double-checked locking
            if _global_manager is None:
                from core.inference import get_app_root
                config_path = get_app_root() / "configs" / "llm_backends.yaml"
                _global_manager = LLMServerManager(config_path)
    
    return _global_manager
```

---

## 🚀 Quick Workaround (Until Fixed)

### Option 1: Single Chat at a Time
- Only use ONE chat window at a time
- Wait for first chat to complete before starting another
- Close models when done

### Option 2: Use Cleanup Script
```bash
# Before starting multiple chats
python kill_zombie_servers.py
```

### Option 3: Restart Between Chats
- Use one chat
- Close application
- Reopen for next chat

---

## 📊 Testing Strategy

### Test 1: Concurrent Model Loads
```python
import threading

def load_model_1():
    # Load Phi-4
    pass

def load_model_2():
    # Load Nemotron
    pass

# Start both simultaneously
t1 = threading.Thread(target=load_model_1)
t2 = threading.Thread(target=load_model_2)
t1.start()
t2.start()
t1.join()
t2.join()

# Should NOT have port conflicts
# Should NOT have duplicate servers
```

### Test 2: Rapid Sequential Loads
```python
for i in range(5):
    load_model("phi-4")
    # Should reuse same server
    # Should NOT create 5 servers
```

### Test 3: Concurrent Inference
```python
import concurrent.futures

with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
    futures = [executor.submit(run_inference, prompt) for _ in range(10)]
    results = [f.result() for f in futures]

# Should all succeed
# Should use same server
# Should NOT create multiple servers
```

---

## 🎯 Implementation Priority

### Priority 1: Thread Safety (CRITICAL) 🔴
- Add `threading.RLock()` to server manager
- Protect all server operations with lock
- Fix global manager singleton

**Effort**: 2 hours  
**Impact**: Prevents ALL race conditions

### Priority 2: StateStore Process Tracking (HIGH) 🟠
- Store PID in StateStore
- Check process alive before reuse
- Share state across threads

**Effort**: 3 hours  
**Impact**: Proper multi-thread coordination

### Priority 3: Cleanup Hooks (HIGH) 🟠
- Add proper server shutdown
- Cleanup on chat completion
- Cleanup on application exit

**Effort**: 2 hours  
**Impact**: No more zombies

### Priority 4: Better Port Management (MEDIUM) 🟡
- Port conflict retry with backoff
- Detect and kill zombies on ports
- Dynamic port allocation

**Effort**: 2 hours  
**Impact**: Resilience to conflicts

---

## 📝 Code Changes Required

### Files to Modify

1. **`LLM/core/llm_server_manager.py`** (PRIMARY)
   - Add `_server_lock = threading.RLock()`
   - Wrap all methods with `with self._server_lock:`
   - Add PID tracking in StateStore
   - Add `_is_process_alive()` method

2. **`LLM/core/state_store.py`** (MINOR)
   - Add `pid` column to servers table (if not exists)
   - Add `upsert_server()` support for PID

3. **`LLM/core/inference.py`** (MINOR)
   - Add cleanup after inference completes
   - Consider server pooling vs per-request

4. **`LLM/desktop_app/main.py`** (MINOR)
   - Add `atexit` cleanup hook
   - Shutdown all servers on exit

---

## ✅ Summary

**User's Insight**: ✅ **100% CORRECT**

The issue IS concurrent chats causing:
- Race conditions in server manager
- No coordination between threads
- Process tracking corruption
- Zombie accumulation

**Root Causes**:
1. 🔴 No thread synchronization (locks)
2. 🔴 Memory-only process tracking
3. 🔴 No cleanup hooks
4. 🔴 Race condition in global manager

**Solutions**:
1. Add `threading.RLock()` to all server operations
2. Use StateStore for shared process tracking
3. Implement proper cleanup hooks
4. Fix singleton manager pattern

**Workaround**:
- Use only ONE chat at a time
- Run `kill_zombie_servers.py` before starting
- Restart app between heavy usage

This is a **production-critical bug** that needs fixing for multi-threaded/multi-chat scenarios!
