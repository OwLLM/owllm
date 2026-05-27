# Bug Fix: Tool Enable/Disable State Not Working

## The Issue

**Problem**: When clicking "Run Tool", a popup always showed "Tool is disabled" even when the tool's checkbox was enabled.

**Root Cause**: The enable/disable checkbox was saving to the config file but not updating the in-memory `self.tools` list. When checking if a tool was enabled before running it, the code checked the stale data in `self.tools`.

## The Flow

**Before the fix:**
1. User toggles checkbox → `_on_tool_enabled_changed()` called
2. Save to config file ✓
3. But `self.tools[i]["enabled"]` NOT updated ✗
4. User clicks "Run Tool" → `_run_tool()` called
5. Check `tool_data["enabled"]` from `self.tools` → Still has old value!
6. Shows "Tool is disabled" popup incorrectly

**After the fix:**
1. User toggles checkbox → `_on_tool_enabled_changed()` called
2. Update `self.tools[i]["enabled"]` ✓
3. Save to config file ✓
4. User clicks "Run Tool" → `_run_tool()` called
5. Check `tool_data["enabled"]` from `self.tools` → Has current value!
6. Tool runs correctly

## The Fix

Updated `_on_tool_enabled_changed()` to update the in-memory data structure:

```python
def _on_tool_enabled_changed(self, tool_name: str, enabled: bool):
    """Handle tool enabled/disabled state change."""
    # NEW: Update the tool data in self.tools
    for tool in self.tools:
        if tool.get("name") == tool_name:
            tool["enabled"] = enabled
            break
    
    # Save to config (existing code)
    if not self.config_manager: return
    config = self.config_manager.load()
    if "enabled_tools" not in config: config["enabled_tools"] = {}
    config["enabled_tools"][tool_name] = enabled
    self.config_manager.save(config)
```

## Testing

Now:
- ✅ Toggle tool checkbox to disabled → "Run Tool" shows disabled popup
- ✅ Toggle tool checkbox to enabled → Tool runs correctly
- ✅ State persists across app restarts (saved to config)
- ✅ State is checked correctly before running

## File Modified
- `LLM/desktop_app/pages/mcp_tools_page.py` - Updated `_on_tool_enabled_changed()`
