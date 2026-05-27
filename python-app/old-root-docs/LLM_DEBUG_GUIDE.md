# LLM Server Debug Guide

## Quick Debug Steps

### 1. Check Server Logs in UI
- Go to **Server** tab
- Look at the **Server Log** section
- Look for `[LLM]` prefixed messages
- Check for error messages

### 2. Check Configuration
Verify `LLM/configs/llm_backends.yaml` exists and has correct model path:

```yaml
models:
  default:
    base_model: "C:/1_GitHome/Local-LLM-Server/LLM/models/unsloth__Phi-4-bnb-4bit"
    port: 10500
    model_type: "instruct"
    use_4bit: true
```

### 3. Check Model Path
Verify the model actually exists:
```bash
dir "C:\1_GitHome\Local-LLM-Server\LLM\models\unsloth__Phi-4-bnb-4bit"
```

### 4. Test Server Startup Manually

Run this from the `LLM` directory:

```bash
cd C:\1_GitHome\Local-LLM-Server\LLM
python scripts\llm_server_start.py default
```

**Expected output:**
```
Starting LLM server for model: default
Port: 10500
Base model: C:/1_GitHome/Local-LLM-Server/LLM/models/unsloth__Phi-4-bnb-4bit
Model type: instruct
4-bit quantization: true
--------------------------------------------------
Launching uvicorn with: ...
INFO:     Started server process
INFO:     Waiting for application startup.
INFO:     Loading model: ...
INFO:     Model loaded successfully!
INFO:     Application startup complete.
INFO:     Uvicorn running on http://127.0.0.1:10500
```

**If you see errors:**
- Note the exact error message
- Check if model path is correct
- Check if Python environment has required packages

### 5. Check Python Environment

The server runs in an isolated environment. Check if it exists:

```bash
dir "C:\1_GitHome\Local-LLM-Server\LLM\environments"
```

You should see a folder for your model.

### 6. Check Port Availability

```bash
netstat -ano | findstr :10500
```

If something is using the port, either:
- Stop that process
- Change port in `llm_backends.yaml`

### 7. Check Process Output

When starting from UI, errors are captured. Look for:
- `[LLM] Starting server...`
- `[LLM] Error: ...` (if it fails)
- Full traceback in error message

### 8. Common Issues

#### Issue: "Model not found"
**Solution:** Check `base_model` path in config is correct and model exists

#### Issue: "Port in use"
**Solution:** 
- Change port in config
- Or kill process using port: `taskkill /PID <pid> /F`

#### Issue: "Failed to launch server process"
**Solution:**
- Check Python executable exists
- Check launcher script exists: `LLM/scripts/llm_server_start.py`
- Check working directory permissions

#### Issue: "Server died during startup"
**Solution:**
- Check server output in error message
- Verify model can be loaded (test manually)
- Check environment has all dependencies

#### Issue: "Timeout - server not healthy"
**Solution:**
- Model loading takes 2-3 minutes (normal)
- Check if process is actually running: `tasklist | findstr python`
- Increase timeout in code if needed (default: 180s)

### 9. Enable Verbose Logging

Edit `LLM/core/llm_server_manager.py` and change:

```python
logger.setLevel(logging.DEBUG)  # Add this
```

### 10. Test Health Endpoint Manually

Once server is running:
```bash
curl http://127.0.0.1:10500/health
```

Should return: `{"status": "ok", "model": "local-llm"}`

---

## Debug Checklist

- [ ] Config file exists and is valid YAML
- [ ] Model path exists and is accessible
- [ ] Port 10500 is free
- [ ] Python environment exists (or can be created)
- [ ] All dependencies installed in environment
- [ ] Server script exists: `LLM/scripts/llm_server_start.py`
- [ ] Can run server manually from command line
- [ ] Health endpoint responds when server is running

---

## Getting Help

If server still won't start:

1. **Copy the full error message** from Server Log
2. **Check if manual startup works** (step 4)
3. **Note the exact error** from manual startup
4. **Check model path** is correct
5. **Verify environment** exists and has packages

The error message should now include:
- Exit code (if process died)
- Full server output (last 20 lines)
- Port number
- Python executable path
- Script path

This should help identify the exact issue!
