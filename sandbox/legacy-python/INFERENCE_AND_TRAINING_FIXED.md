# Inference and Training - Fixed Issues

## What Was Fixed

### 1. **GPU Detection Now Working** ✅
- Fixed background detection thread
- UI now correctly shows: 2 GPUs (RTX A2000 12GB + RTX 4090)
- PyTorch 2.5.1+cu121 with CUDA 12.1 detected properly
- No more "50% freeze" on startup

### 2. **Incomplete Adapter Handling** ✅
- Fixed error when trying to load incomplete adapter checkpoints
- `run_adapter.py` now validates that adapter directories contain actual model weights
- Clear error messages when adapter is incomplete:
  ```
  [ERROR] Adapter directory '...' exists but contains no adapter weights!
  [ERROR] Expected files: adapter_model.safetensors, adapter_model.bin, adapter_config.json
  ```

### 3. **Test Tab Model Selection** ✅
- Now properly loads models from `hf_models/` folder
- Shows base models and complete adapters separately:
  - 📦 = Base model (can run directly)
  - 🎯 = Fine-tuned adapter (requires base model)
- Filters out incomplete adapters automatically
- Clear message when no models available

### 4. **AttributeError Fixed** ✅
- Fixed `'MainWindow' object has no attribute 'batch_size_container'`
- Batch size toggle now works correctly

---

## How to Use

### **Testing Inference (Base Models)**

#### Step 1: Download a Base Model
1. Go to **Download** tab
2. Click on a model card (e.g., "Llama-3.2-1B")
3. Click **Download**
4. Wait for download to complete

#### Step 2: Test the Model
1. Go to **Test** tab
2. Select GPU from dropdown (e.g., "GPU 1: RTX 4090")
3. In Model A dropdown, select your downloaded model (📦 icon)
4. Type a prompt like: `"Hello, how are you?"`
5. Click **📤 Send**
6. Watch the response appear in the chat

### **Training a New Model**

#### Step 1: Prepare Dataset
- Ensure you have a `.jsonl` or `.json` dataset file
- Format should be:
  ```json
  {"instruction": "...", "output": "..."}
  ```
  OR
  ```json
  {"messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
  ```

#### Step 2: Configure Training
1. Go to **Train** tab
2. **Select Base Model** from dropdown (e.g., "meta-llama/Llama-3.2-1B")
3. **Browse** and select your dataset file
4. **Select GPU** (e.g., GPU 1: RTX 4090)
5. Set training parameters:
   - Epochs: 3 (recommended)
   - LoRA R: 16
   - Learning Rate: 2e-4
   - Max Seq Length: 2048

#### Step 3: Start Training
1. Click **🚀 Start Training**
2. Watch logs in the expandable log panel
3. Training will save to `fine_tuned_adapter/Run_YYYYMMDD_HHMMSS/`

#### Step 4: Test Your Fine-tuned Model
1. Once training completes, go to **Test** tab
2. The new adapter will appear in Model A/B dropdown with 🎯 icon
3. Select it and test!

---

## Troubleshooting

### "No models available"
**Solution:** Download a model from the Download tab first.

### "Incomplete adapter checkpoint"
**Problem:** Training didn't finish or failed to save weights.
**Solution:** 
- Check training logs for errors
- Re-run training with lower batch size
- Ensure enough disk space

### Inference shows "Thinking..." forever
**Problem:** Model loading failed or GPU out of memory.
**Solution:**
- Check app.log in LLM/logs/app.log
- Try a smaller model
- Close other GPU applications

### Training fails immediately
**Possible causes:**
1. Dataset format incorrect → Check "View Dataset" in Train tab
2. GPU out of memory → Lower batch size or max sequence length
3. Base model not downloaded → Download from HuggingFace first

---

## Current Status

✅ **Working:**
- GPU detection (2 GPUs detected)
- PyTorch CUDA (2.5.1+cu121)
- UI responsiveness (no freeze)
- Base model inference
- Training process
- Model download

⚠️ **Limitations:**
- Adapter inference requires specifying compatible base model
- Currently hardcoded to use "llama-3.2-3b-instruct-unsloth-bnb-4bit" as base
- Future: Add base model selector for adapter testing

---

## Technical Details

### Inference Command
```bash
python run_adapter.py \
  --base-model "path/to/model" \
  --no-adapter \
  --prompt "Your prompt here" \
  --max-new-tokens 512 \
  --temperature 0.7
```

### Training Command
```bash
python finetune.py \
  --model-name "meta-llama/Llama-3.2-1B" \
  --data-path "train_data.jsonl" \
  --output-dir "./fine_tuned_adapter/Run_..." \
  --epochs 3 \
  --batch-size 2 \
  --learning-rate 2e-4
```

### GPU Selection
Both training and inference respect `CUDA_VISIBLE_DEVICES` environment variable set by the GUI.

---

## Next Steps (Optional Improvements)

1. **Add base model selector for adapters** - Let user choose which base model to use with adapter
2. **Add inference progress indicators** - Show "Loading model..." before "Thinking..."
3. **Add training checkpoints** - Resume from checkpoint if training interrupted
4. **Add validation split** - Show validation loss during training
5. **Add model size estimates** - Show how much VRAM each model needs

