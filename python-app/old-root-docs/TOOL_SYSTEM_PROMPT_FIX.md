# Tool System Prompt Fix ✅

**Date**: 2026-01-17  
**Issue**: Models weren't aware they had file reading tools available  
**Status**: ✅ **FIXED**

---

## 🐛 The Problem

Your models (Phi-4 and Nemotron) were **NOT receiving the system prompt** that tells them:
1. They have tools available
2. What tools they can use (read_file, write_file, etc.)
3. How to call those tools (XML format)

### What Was Happening

```python
# Line 6884 in main.py
def _run_tool_chat_inference_a(self, model_path: str, prompt: str, system_prompt: str = ""):
    # ...
    self.tool_chat_worker_a = ToolInferenceWorker(prompt, model_id, "model_a", system_prompt)
```

**Problem**: `system_prompt=""` (empty by default!)

So models received:
- ❌ NO system prompt
- ❌ NO tool instructions
- ❌ NO available tools list
- ❌ NO format examples

**Result**: Models had no idea they could read files!

---

## ✅ The Fix

Added automatic injection of tool system prompt:

```python
# FIX: Auto-inject tool system prompt if not provided
if not system_prompt:
    from core.model_capabilities import get_prompted_system_prompt
    system_prompt = get_prompted_system_prompt()
```

### What Models Will Now Receive

```
You are a helpful AI assistant with access to tools. When you need to use a tool, respond with the following XML format:

<tool_call>tool_name(arg1="value1", arg2="value2")</tool_call>

Available tools:
- read_file(path: str) - Read the contents of a text file
  Example: <tool_call>read_file(path="README.md")</tool_call>

- write_file(path: str, content: str) - Write content to a file
  Example: <tool_call>write_file(path="output.txt", content="Hello World")</tool_call>

- list_dir(path: str) - List files and directories
  Example: <tool_call>list_dir(path=".")</tool_call>

- run_shell(command: str) - Execute a shell command
  Example: <tool_call>run_shell(command="ls -la")</tool_call>

- git_status() - Get git repository status
  Example: <tool_call>git_status()</tool_call>

After calling a tool, you will receive the result in this format:
<tool_result tool="tool_name">
result content here
</tool_result>

Use the tool results to formulate your final answer to the user.
```

---

## 📝 Files Modified

**File**: `LLM/desktop_app/main.py`

**Functions Fixed** (6 total):
1. `_run_tool_chat_inference_a()` - Lines ~6884-6900
2. `_run_tool_chat_inference_b()` - Lines ~6917-6933
3. `_run_tool_chat_inference_c()` - Lines ~6950-6966
4. `_run_inference_a_with_tools()` - Lines ~7566-7589
5. `_run_inference_b_with_tools()` - Lines ~7902-7920
6. `_run_inference_c_with_tools()` - Lines ~8160-8180

**Change Applied to Each**:
```python
# Added these 3 lines before creating ToolInferenceWorker
if not system_prompt:
    from core.model_capabilities import get_prompted_system_prompt
    system_prompt = get_prompted_system_prompt()
```

---

## 🧪 How to Test

### Test 1: File Reading
**Prompt**: "Read the file dios.txt in C:\1_Git\LocaLLM\LLM"

**Expected Before**: 
- Model 1: Hallucinated code
- Model 2: "I can't access files"

**Expected After**:
```xml
<tool_call>read_file(path="C:\1_Git\LocaLLM\LLM\dios.txt")</tool_call>
```
Then the system executes the tool and returns the file content!

### Test 2: List Directory
**Prompt**: "List files in the current directory"

**Expected**:
```xml
<tool_call>list_dir(path=".")</tool_call>
```

### Test 3: Write File
**Prompt**: "Create a file called test.txt with content 'Hello World'"

**Expected**:
```xml
<tool_call>write_file(path="test.txt", content="Hello World")</tool_call>
```

---

## 🎯 What Will Happen Now

### Scenario: User Asks to Read a File

```
1. User: "Read the file dios.txt in C:\1_Git\LocaLLM\LLM"

2. System: Sends to model WITH system prompt about tools

3. Model: "I'll read that file for you."
   <tool_call>read_file(path="C:\1_Git\LocaLLM\LLM\dios.txt")</tool_call>

4. System: Detects tool call, executes read_file tool

5. Tool: Reads file, returns content

6. System: Sends result back to model
   <tool_result tool="read_file">
   [file content here]
   </tool_result>

7. Model: "The file contains: [summarizes content]"

8. User: Sees the answer! ✅
```

---

## 📊 Complete Fix Summary

| Issue | Status | Solution |
|-------|--------|----------|
| Phase 2 Env | ✅ Fixed | Windows paths + fallback |
| Thread Safety | ✅ Fixed | RLock() concurrency |
| Zombie Servers | ✅ Fixed | Manual cleanup |
| CMD Windows | ✅ Fixed | CREATE_NO_WINDOW |
| Pipe Blocking | ✅ Fixed | DEVNULL output |
| **Tool System Prompt** | ✅ **FIXED** | **Auto-inject instructions** |

---

## 🎉 Result

Your models will now:
- ✅ **Know they have tools**
- ✅ **Know how to call them** (XML format)
- ✅ **See available tools** (read_file, write_file, etc.)
- ✅ **Use tools when asked**

**Try asking again**: "Read the file dios.txt in C:\1_Git\LocaLLM\LLM"

Both Phi-4 and Nemotron should now respond with:
```xml
<tool_call>read_file(path="C:\1_Git\LocaLLM\LLM\dios.txt")</tool_call>
```

And the system will execute it and show you the file content! 🎯
