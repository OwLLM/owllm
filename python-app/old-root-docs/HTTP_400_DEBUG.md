# HTTP 400 Error - Better Debugging ✅

**Date**: 2026-01-17  
**Issue**: Tool call detected but MCP server returns 400 Bad Request  
**Status**: ✅ **Debug logging added** + analysis

---

## 🎉 PROGRESS!

Tool execution is now working:
- ✅ Tool call detected from model output
- ✅ XML parsed successfully
- ✅ Executor calling MCP server
- ❌ MCP server returning 400 Bad Request

This is **huge progress** from "tools don't work at all"!

---

## 🔍 What's Causing 400?

The MCP server expects:
```json
{
  "name": "read_file",
  "args": {
    "path": "C:\\1_Git\\LocaLLM\\LLM\\dios.txt"
  }
}
```

Possible issues:
1. **Path format**: Windows backslashes might need escaping
2. **Relative vs absolute**: Tool expects relative path but getting absolute
3. **Workspace root**: Path might be outside allowed workspace
4. **Parameter validation**: Args schema mismatch

---

## ✅ Fixes Applied

### 1. Better Error Messages
Now reads the error response body from MCP server:

```python
except urllib.error.HTTPError as e:
    try:
        error_body = e.read().decode('utf-8')
        error_details = json.loads(error_body)
        error_msg = error_details.get('error', str(e))
    except:
        error_msg = f"HTTP {e.code}: {e.reason}"
```

### 2. Debug Logging
Added logging to see exact payload being sent:

```python
logging.info(f"[ToolExecutor] Calling {self.server_url}/call")
logging.info(f"[ToolExecutor] Payload: {json.dumps(payload, indent=2)}")
```

---

## 🧪 How to Debug

### Check Logs

**Restart app** and try again. Look for console output:

```
[ToolExecutor] Calling http://127.0.0.1:8763/call
[ToolExecutor] Payload: {
  "name": "read_file",
  "args": {
    "path": "C:\\1_Git\\LocaLLM\\LLM\\dios.txt"
  }
}
```

Then you'll see the actual error from MCP server!

---

## 💡 Likely Solutions

### Solution 1: Use Relative Path

The tool might expect paths relative to workspace root.

**Try**: "Read the file LLM/dios.txt" or "Read dios.txt"

Instead of full path: "C:\\1_Git\\LocaLLM\\LLM\\dios.txt"

### Solution 2: Check Workspace Root

The MCP tool server has a workspace root setting. It might be:
- `C:\\1_Git\\LocaLLM`
- Or a different directory

The tool does: `safe_path = ctx._safe_path(path)` which likely prepends workspace root.

### Solution 3: Forward Slashes

Try forward slashes instead of backslashes:

**Try**: "Read the file C:/1_Git/LocaLLM/LLM/dios.txt"

---

## 🎯 Test These Prompts

### Test 1: Relative Path
**"Use read_file tool with path='dios.txt'"**

If dios.txt is in workspace root.

### Test 2: Relative with Subfolder
**"Use read_file tool with path='LLM/dios.txt'"**

If workspace root is `C:\\1_Git\\LocaLLM`.

### Test 3: Current Directory
**"Use read_file tool with path='./dios.txt'"**

### Test 4: List First
**"Use list_dir tool with path='LLM' to see what files are there"**

This will show you what files are visible and help determine correct path.

---

## 📊 Summary

**Status**: ALMOST THERE! 

- ✅ System prompt working
- ✅ Tool call detection working
- ✅ XML parsing working  
- ✅ Markdown stripping working
- ✅ Executor calling MCP server
- ⚠️ Path/parameter issue causing 400

**Next**: Restart app, try with relative path, check logs for actual error message!

The tools ARE working - just need to fix the path format! 🎯
