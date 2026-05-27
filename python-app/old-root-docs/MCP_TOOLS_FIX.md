# Bug Fix: MCP Tools Page Stuck in Refreshing State

## The Actual Issue

**Problem**: The MCP Tools page was stuck in "Refreshing..." state and not showing any content.

**Root Cause**: The `ToolsRefreshWorker` class was missing a `finished` signal. When I added thread cleanup code, I connected:
```python
self._refresh_worker.finished.connect(self._refresh_thread.quit)
```

But the worker class only had `tools_ready` and `error` signals - no `finished` signal! This meant:
1. The worker would complete its work
2. It would emit `tools_ready` or `error` 
3. But it would never emit `finished`
4. So the thread would never quit
5. Button stayed disabled and in "Refreshing..." state
6. Page appeared broken

## The Fix

Added the `finished` signal to `ToolsRefreshWorker` and ensured it's emitted in a `finally` block:

```python
class ToolsRefreshWorker(QObject):
    """Worker object for refreshing tools in background thread."""
    tools_ready = Signal(list)
    error = Signal(str)
    finished = Signal()  # NEW: Added this signal
    
    def refresh(self):
        try:
            tools = self.connection_manager.get_all_tools()
            self.tools_ready.emit(tools)
        except Exception as e:
            self.error.emit(str(e))
        finally:
            self.finished.emit()  # NEW: Always emit finished
```

## Why This Works

Now the signal chain is complete:
1. Thread starts → worker.refresh() called
2. Worker emits `tools_ready` (success) OR `error` (failure)
3. Worker emits `finished` (always, in finally block)
4. `finished` signal triggers thread.quit()
5. Thread quits cleanly
6. Button re-enabled, UI updates properly

## Testing

The fix ensures:
- ✅ MCP Tools page loads content properly
- ✅ Refresh button becomes enabled after refresh completes
- ✅ Works for both success and error cases
- ✅ Thread properly cleaned up
- ✅ No crash on app close

## Files Modified
- `LLM/desktop_app/pages/mcp_tools_page.py` - Added `finished` signal and emit in finally block
