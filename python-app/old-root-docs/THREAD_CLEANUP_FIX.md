# Thread Cleanup Fix for MCP Page Crash

## Problem
The application was crashing with the error "QThread: Destroyed while thread is still running" when:
- Navigating between tabs in the MCP page
- Starting the server and playing around with the MCP page
- Closing the application

## Root Cause
Multiple QThreads were being created in the MCP pages (specifically `MCPToolsPage` and `MCPCatalogPage`) but were not being properly stopped and cleaned up when:
1. New threads were created while old ones were still running
2. The user closed the application while threads were still running

## Solution
Implemented strategic thread cleanup across multiple files:

### 1. MCPToolsPage (`LLM/desktop_app/pages/mcp_tools_page.py`)
- Added `_cleanup_threads()` method to safely stop and clean up threads
- Added `closeEvent()` to clean up when widget is closed
- Modified `_refresh_tools()` to clean up old threads before creating new ones
- Properly connected worker `finished` signal to thread `quit` slot

### 2. MCPCatalogPage (`LLM/desktop_app/pages/mcp_catalog_page.py`)
- Added `_cleanup_threads()` method for both fetch and install threads
- Added `closeEvent()` for proper cleanup on widget close
- Modified `_refresh_servers()` to properly clean up old threads
- Added `deleteLater()` connection to ensure thread cleanup

### 3. MCPPage Container (`LLM/desktop_app/pages/mcp_page.py`)
- Added `closeEvent()` to clean up all sub-pages
- Propagates cleanup calls to all created sub-pages

### 4. Main Application (`LLM/desktop_app/main.py`)
- Enhanced `closeEvent()` to clean up all page threads before closing
- Added `_cleanup_all_pages()` helper function
- Ensures MCP page and all its sub-pages are cleaned up on app close

## Thread Cleanup Strategy

The cleanup follows a graceful shutdown pattern:

1. **Check if thread exists and is valid** (handle C++ object deletion)
2. **Request graceful quit** (`thread.quit()`)
3. **Wait briefly** (500ms) for clean shutdown
4. **Forceful terminate** if still running
5. **Wait again** (500ms) after terminate
6. **Set references to None** to allow garbage collection

This approach ensures:
- Threads have a chance to finish gracefully
- UI remains responsive (short waits)
- Resources are properly released
- No hanging threads remain

**Important Design Decision**: We do NOT cleanup on `hideEvent()` because:
- `hideEvent()` is called during normal tab switching operations
- Cleaning up threads during tab switches would interrupt legitimate operations
- It would cause pages to appear empty when you navigate back
- Thread cleanup only happens when:
  1. Starting a new operation (old thread cleaned up first)
  2. Widget is actually being destroyed (`closeEvent()`)
  3. Application is shutting down

## Testing Instructions

1. **Start the application**
   ```bash
   python START.py
   ```

2. **Test MCP Page Navigation**
   - Navigate to the MCP page
   - Switch between Catalog, Connections, and Tools tabs multiple times
   - Content should load and remain visible
   - Verify no crash occurs

3. **Test Server with MCP Page**
   - Start the tool server from the Server page
   - Navigate to MCP page and interact with it
   - Click Refresh in the Tools tab
   - Switch between tabs while refresh is running
   - Switch to other main tabs and back to MCP
   - Content should remain visible
   - Verify no crash occurs

4. **Test Application Close**
   - Start the server
   - Navigate to MCP page
   - Click Refresh in Tools tab
   - While refresh is running, close the application
   - Should see debug output:
     ```
     [DEBUG] closeEvent triggered - shutting down...
     [DEBUG] Cleaning up all page threads...
     [DEBUG] Server stopped (or timed out) - cleaning up and closing window...
     ```
   - Application should close cleanly without errors

5. **Test Rapid Interactions**
   - Navigate to MCP Tools page
   - Click Refresh multiple times rapidly
   - Switch to Catalog tab
   - Click Refresh multiple times rapidly
   - Close the application
   - Verify no crash and clean shutdown

## Expected Behavior

**Before Fix:**
```
QThread: Destroyed while thread is still running
=== APP CLOSED ===
```

**After Fix:**
```
[DEBUG] closeEvent triggered - shutting down...
[DEBUG] Requesting server stop and waiting for completion...
[DEBUG] Cleaning up all page threads...
[DEBUG] Server stopped (or timed out) - cleaning up and closing window...
=== APP CLOSED ===
```

No thread destruction errors should occur.

## Technical Details

### Thread Lifecycle
- Threads are created on-demand when needed (lazy initialization)
- Threads are cleaned up when:
  - A new operation starts (old thread cleaned up first)
  - Widget is closed (`closeEvent()`)
  - Application is shutting down

### Safety Measures
- RuntimeError handling for deleted C++ objects
- Generic exception handling to prevent cleanup failures
- Finally blocks to ensure references are cleared
- Short wait times to keep UI responsive

### Memory Management
- Threads are properly deleted using `deleteLater()`
- Worker objects are moved to threads and cleaned up with threads
- Signal connections are properly managed
- References are set to None after cleanup

## Files Modified

1. `LLM/desktop_app/pages/mcp_tools_page.py`
2. `LLM/desktop_app/pages/mcp_catalog_page.py`
3. `LLM/desktop_app/pages/mcp_page.py`
4. `LLM/desktop_app/main.py`

## Notes

- The server page already had proper thread cleanup implemented
- The fix uses a consistent cleanup pattern across all pages
- The solution is defensive and handles edge cases (C++ object deletion, exceptions)
- No functional changes - only cleanup and stability improvements
- `hideEvent()` was initially added but removed because it was too aggressive and interfered with normal navigation
