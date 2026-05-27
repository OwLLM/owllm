# 🚀 QUICK START - Use Your Local LLM in Cursor

## Step 1: Start the Server

### Option A: From Desktop App (Recommended)
1. Open the desktop app
2. Go to **"🖧 Server"** tab
3. Find **"LLM Inference Server"** section
4. Click **"Start LLM Server"**
5. Wait 2-3 minutes for **"Status: Running"**
6. Click **"📋 Copy API URL for Cursor"**

### Option B: Automatic
- Just use **"Enable Tool Use"** in Test Chat tab
- Server starts automatically

---

## Step 2: Configure Cursor

1. **Open Cursor**
2. **Press Ctrl+,** (Settings)
3. **Search**: "API" or "OpenAI"
4. **Configure**:
   ```
   Base URL: http://127.0.0.1:10500/v1
   API Key:  sk-local (or any text)
   Model:    local-llm
   ```
5. **Save**

---

## Step 3: Use It!

- **Press Ctrl+K** for inline editing
- **Press Ctrl+L** for chat
- **Your local LLM responds!**

### Benefits:
- ✅ **Private** - Code stays on your machine
- ✅ **Free** - $0 API costs
- ✅ **Fast** - No network latency
- ✅ **Offline** - No internet needed

---

## Troubleshooting

### Server Won't Start?
- Check if port 10500 is free: `netstat -ano | findstr :10500`
- Look at logs in Server page
- First start takes 2-3 minutes (model loading)

### Cursor Can't Connect?
- Make sure server is running (Status: Running)
- Check URL is exactly: `http://127.0.0.1:10500/v1`
- API key can be anything

### Slow Responses?
- First response is slower (normal)
- Subsequent responses are fast

---

## More Info

- **Full Guide**: See `OPENAI_COMPATIBLE_API.md`
- **Help in App**: Click "📖 How to Use with Cursor/VS Code" button
- **Test API**: `curl http://127.0.0.1:10500/health`

---

## VS Code Users

Same steps, but install **Continue** extension first:
1. Install Continue extension
2. Configure `~/.continue/config.json`:
   ```json
   {
     "models": [{
       "provider": "openai",
       "model": "local-llm",
       "apiBase": "http://127.0.0.1:10500/v1",
       "apiKey": "sk-local"
     }]
   }
   ```

---

**That's it! Start coding with your private, free, local LLM!** 🎉
