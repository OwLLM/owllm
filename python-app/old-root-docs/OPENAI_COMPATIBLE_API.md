# Using Your Local LLM with External Tools

## Overview

Your LLM server now provides an **OpenAI-compatible API** that can be used with:
- **Cursor** IDE
- **VS Code** with Continue extension
- **Open-WebUI**
- **LibreChat**
- **Any tool that supports OpenAI API**

## Quick Start

### 1. Start the LLM Server

The server starts automatically when you use tool-enabled chat, or you can start it manually:

**Configuration (per model in Server page):**
- **Base URL**: `http://127.0.0.1:<port>/v1` (port from `llm_backends.yaml`, shown in Server page)
- **Model Name**: the model ID you selected (e.g. `unsloth_gemma-2-2b-it-bnb-4bit`); or run `GET http://127.0.0.1:<port>/v1/models` to see it

### 2. Configure Your External Tool

Use these settings:
```
Base URL: http://127.0.0.1:<port>/v1
API Key: any-text-works (not validated)
Model: <model_id> (from dropdown or /v1/models)
```

---

## Cursor IDE Setup

### Step 1: Open Cursor Settings
1. Open Cursor
2. Go to **Settings** (Ctrl+,)
3. Search for "**API Key**" or "**Models**"

### Step 2: Add Custom OpenAI Endpoint
1. Find **"OpenAI API Settings"**
2. Set:
   - **Base URL**: `http://127.0.0.1:<port>/v1` (from Server page / Copy API URL)
   - **API Key**: `sk-local` (any string works)
   - **Model**: the model ID you started (e.g. from dropdown; or run `GET .../v1/models`)

### Step 3: Test It
1. Open a file in Cursor
2. Use Cursor's chat (Ctrl+K or Ctrl+L)
3. Your local LLM will respond!

**Note:** Make sure the server is running first!

---

## VS Code with Continue Extension

### Step 1: Install Continue
```bash
ext install Continue.continue
```

### Step 2: Configure Continue
Open `~/.continue/config.json` (or use Continue settings UI):

```json
{
  "models": [
    {
      "title": "Local Phi-4",
      "provider": "openai",
      "model": "local-llm",
      "apiBase": "http://127.0.0.1:10500/v1",
      "apiKey": "sk-local"
    }
  ]
}
```

### Step 3: Use It
- Press **Ctrl+I** for inline editing
- Use Continue sidebar for chat
- Your local model will be used!

---

## API Endpoints

### OpenAI-Compatible Endpoints

#### 1. Chat Completions
```bash
POST http://127.0.0.1:10500/v1/chat/completions
```

**Example:**
```bash
curl -X POST http://127.0.0.1:10500/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "local-llm",
    "messages": [
      {"role": "user", "content": "What is 2+2?"}
    ],
    "temperature": 0.7,
    "max_tokens": 256
  }'
```

**Response:**
```json
{
  "id": "chatcmpl-1234567890",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "local-llm",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "2+2 equals 4."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 5,
    "total_tokens": 15
  }
}
```

#### 2. List Models
```bash
GET http://127.0.0.1:10500/v1/models
```

**Example:**
```bash
curl http://127.0.0.1:10500/v1/models
```

**Response:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "local-llm",
      "object": "model",
      "created": 1234567890,
      "owned_by": "local"
    }
  ]
}
```

### Native API Endpoints

#### 1. Generate (Simpler format)
```bash
POST http://127.0.0.1:10500/generate
```

**Example:**
```bash
curl -X POST http://127.0.0.1:10500/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "What is 2+2?",
    "max_new_tokens": 256,
    "temperature": 0.7
  }'
```

**Response:**
```json
{
  "text": "2+2 equals 4."
}
```

#### 2. Health Check
```bash
GET http://127.0.0.1:10500/health
```

**Example:**
```bash
curl http://127.0.0.1:10500/health
```

**Response:**
```json
{
  "status": "ok",
  "model": "local-llm"
}
```

---

## Configuration

### Change Port

Edit `LLM/configs/llm_backends.yaml`:

```yaml
models:
  default:
    port: 10500  # ← Change this
```

Then update your external tool configuration.

### Change Model Name

Set environment variable in `llm_server_start.py` or config:

```python
os.environ["MODEL_NAME"] = "phi-4-local"
```

### Add System Prompt

Edit `LLM/configs/llm_backends.yaml`:

```yaml
models:
  default:
    system_prompt: "You are a helpful coding assistant."
```

---

## Multiple Models

You can run multiple models simultaneously on different ports:

```yaml
models:
  phi4:
    base_model: "C:/path/to/phi-4"
    port: 10500
    
  llama3:
    base_model: "C:/path/to/llama-3"
    port: 10501
    
  mistral:
    base_model: "C:/path/to/mistral"
    port: 10502
```

Then in Cursor/external tools, use:
- Phi-4: `http://127.0.0.1:10500/v1`
- Llama-3: `http://127.0.0.1:10501/v1`
- Mistral: `http://127.0.0.1:10502/v1`

---

## Troubleshooting

### Server Not Responding

Check if server is running:
```bash
curl http://127.0.0.1:10500/health
```

If not running, start it from the desktop app.

### Connection Refused

1. Verify port in config matches URL
2. Check firewall settings
3. Ensure server fully loaded (takes 2-3 min first time)

### Slow Responses

1. **First response is slow** (normal - model loading)
2. **All responses slow**:
   - Check GPU usage
   - Reduce `max_tokens`
   - Use 4-bit quantization

### Model Not Found

Make sure model path in `llm_backends.yaml` is correct:
```yaml
base_model: "C:/1_GitHome/Local-LLM-Server/LLM/models/unsloth__Phi-4-bnb-4bit"
```

---

## Advanced: Open-WebUI Integration

1. Install Open-WebUI: `pip install open-webui`
2. Run: `open-webui serve`
3. Go to Settings → Connections
4. Add OpenAI API:
   - **Base URL**: `http://127.0.0.1:10500/v1`
   - **API Key**: `anything`
5. Select "local-llm" model

---

## Security Notes

⚠️ **Important:**
- Server binds to `127.0.0.1` (localhost only)
- Not accessible from network (safe)
- No authentication (local use only)
- Don't expose port to internet

To allow network access (advanced):
Edit `llm_server_start.py` and change:
```python
uvicorn.run(app, host="0.0.0.0", port=port)  # ⚠️ Allow network access
```

Then access from other machines: `http://your-ip:10500/v1`

---

## Benefits of OpenAI-Compatible API

✅ **Works with existing tools** - No custom integration needed

✅ **Privacy** - Your code never leaves your machine

✅ **No API costs** - Use your local GPU for free

✅ **Faster** - No network latency to cloud services

✅ **Offline** - Works without internet

✅ **Control** - Full control over model and data

---

## Example: Using in Python

```python
import openai

# Configure to use local server
openai.api_key = "sk-local"
openai.api_base = "http://127.0.0.1:10500/v1"

# Use like normal OpenAI API
response = openai.ChatCompletion.create(
    model="local-llm",
    messages=[
        {"role": "user", "content": "Write a Python function to reverse a string"}
    ],
    temperature=0.7,
    max_tokens=256
)

print(response.choices[0].message.content)
```

---

## Summary

Your local LLM server is now compatible with:
- ✅ Cursor IDE
- ✅ VS Code + Continue
- ✅ Open-WebUI
- ✅ LibreChat
- ✅ Any OpenAI-compatible tool

**Base URL**: `http://127.0.0.1:10500/v1`

**Model**: `local-llm`

**Start coding with privacy and zero API costs!** 🚀
