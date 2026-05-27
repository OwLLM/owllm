# Markdown Code Block Fix + Debugging Guide

**Date**: 2026-01-17  
**Issue**: Models wrap tool calls in markdown backticks, breaking detection  
**Status**: ✅ **FIXED** + Debug instructions

---

## 🐛 Latest Problem Found

Looking at the screenshot, Gemma output:
```
``tool_call>read_file(path="C:\1_Git\LocaLLM\LLM\dios.txt")</tool_call>
```

**BACKTICKS!** The model wrapped the XML in markdown code blocks, breaking the detector!

---

## ✅ The Fix

Updated XML detector to strip markdown before parsing:

```python
def _detect_xml_calls(self, text: str) -> List[ToolCall]:
    # Remove markdown code blocks first
    cleaned_text = re.sub(r'```[\w]*\n?', '', text)  # Remove ```xml, etc.
    cleaned_text = re.sub(r'`+', '', cleaned_text)   # Remove backticks
    
    # Then parse XML normally
    pattern = r'<tool_call>\s*(\w+)\s*\((.*?)\)\s*</tool_call>'
    ...
```

---

## 🔍 Debugging Checklist

### 1. Is MCP Tool Server Running?

**Check**: Servers tab → "Tool Server (MCP)" should be green/running

**If NOT running**:
- Start it from Servers tab
- Should be on port 8763
- Test: `curl http://127.0.0.1:8763/health`

### 2. Is Tool Call Being Detected?

Add debug logging to see if XML parser works:

```python
# In tool_calling.py, _detect_xml_calls()
calls = []
cleaned_text = re.sub(r'```[\w]*\n?', '', text)
cleaned_text = re.sub(r'`+', '', cleaned_text)

print(f"[DEBUG] Original text: {text[:200]}")
print(f"[DEBUG] Cleaned text: {cleaned_text[:200]}")

pattern = r'<tool_call>\s*(\w+)\s*\((.*?)\)\s*</tool_call>'
matches = list(re.finditer(pattern, cleaned_text, re.DOTALL))
print(f"[DEBUG] Found {len(matches)} tool call(s)")
```

### 3. Is Tool Being Executed?

Check if tool execution happens:

```python
# In inference.py, run_inference_with_tools()
tool_calls = detector.detect(assistant_text)
print(f"[DEBUG] Detected {len(tool_calls)} tool call(s)")

for tool_call in tool_calls:
    print(f"[DEBUG] Executing: {tool_call.name} with {tool_call.arguments}")
    result = executor.execute(tool_call)
    print(f"[DEBUG] Result: success={result.success}, result={result.result}")
```

### 4. Is Result Fed Back to Model?

Check if iteration continues:

```python
# After tool execution
result_text = format_tool_result_for_llm(tool_call, result)
print(f"[DEBUG] Sending result back to model: {result_text[:200]}")
conversation_history += "\n" + result_text
```

---

## 📊 Expected vs Actual

### Expected Flow
```
1. User: "Read dios.txt"
2. Model: <tool_call>read_file(path="...")</tool_call>
3. Detector: "Found 1 tool call"
4. Executor: Calls MCP server
5. MCP: Reads file, returns content
6. System: Feeds result back to model
7. Model: "The file contains: [content]"
8. User: Sees answer ✅
```

### What's Probably Happening
```
1. User: "Read dios.txt"
2. Model: "I can't access files" + <tool_call>...</tool_call>
3. Detector: Can't find tool (backticks blocking)
4. System: Returns model output as-is
5. User: Sees "I can't access files" ❌
```

---

## 🧪 Test Cases

### Test 1: Simple Tool Call
**Prompt**: "Use the read_file tool to read dios.txt"

**Expected Output (from model)**:
```
<tool_call>read_file(path="C:\1_Git\LocaLLM\LLM\dios.txt")</tool_call>
```

**NOT**:
```
I can't access files, but here's the tool call:
```<tool_call>read_file(...)</tool_call>```
```

### Test 2: After Fix
With markdown stripping, even if model adds backticks, it should work.

---

## 🎯 Next Steps

1. **Restart application** (to load updated tool_calling.py)
2. **Verify MCP tool server is running**
3. **Try again**: "Read the file dios.txt in C:\1_Git\LocaLLM\LLM"
4. **Watch for**: 
   - Model output (should have tool_call)
   - Tool detection (should find it even with backticks)
   - Tool execution (should call MCP server)
   - Result feedback (model should see file content)
   - Final answer (should summarize content)

---

## 💡 Alternative: Use Better Prompt

Sometimes being more explicit helps:

**Instead of**: "Read the file dios.txt"

**Try**: "You have a read_file tool available. Use it to read the file C:\1_Git\LocaLLM\LLM\dios.txt and tell me what it contains."

Or even more direct:

**"Call the read_file tool with path='C:\1_Git\LocaLLM\LLM\dios.txt'"**

This forces the model to actually use the tool instead of making excuses.

---

## Summary

**3 Fixes Applied**:
1. ✅ System prompt injection (models know about tools)
2. ✅ XML format detection (handles XML tool calls)
3. ✅ Markdown stripping (handles backtick wrapping)

**Restart the app and try again!**
