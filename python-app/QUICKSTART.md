# LLM Fine-Tuning Studio - Quick Start

## 🚀 Launch the App

**Just double-click:**
- `launch_gui.bat` (Windows)

The app will automatically:
1. Start the server
2. Open your browser to http://localhost:8501
3. Show the training interface

## 📋 What You Can Do

1. **Configure Training**
   - Select your dataset (JSONL format)
   - Set number of epochs
   - Choose output directory

2. **Start Training**
   - Click "🚀 Start Training"
   - Watch real-time logs
   - Training takes ~20-30 seconds for small datasets

3. **Use Your Model**
   - Trained model saved to `./fine_tuned`
   - Meaningful naming: `base_model-task-vN` (e.g., `gemma-2-2b-it-beauty-v1`)
   - Ready to use for inference

## 🛠️ Manual Launch

If the launcher doesn't work:

```bash
cd C:\1_GitHome\Local-LLM-Server\LLM
.\.venv\Scripts\streamlit.exe run gui_simple.py --server.port 8501
```

Then open http://localhost:8501

## 📝 Training Your Model

1. Prepare your dataset as `train_data.jsonl`:
```json
{"instruction": "Your instruction here", "output": "Expected response"}
{"instruction": "Another instruction", "output": "Another response"}
```

2. Launch the GUI
3. Click "Start Training"
4. Wait for completion (progress shown in real-time)
5. Model saved to `./fine_tuned`

## ⚡ Direct Training (No GUI)

If you prefer command-line:

```bash
cd C:\1_GitHome\Local-LLM-Server\LLM
.\.venv\Scripts\python.exe train_basic.py
```

Edit settings in `train_basic.py` before running.

## 🔧 Troubleshooting

**GUI won't start?**
- Make sure virtual environment is set up: `.\run_gui.bat`
- Check if port 8501 is already in use

**Training fails?**
- Check dataset format (JSONL with "instruction" and "output" fields)
- Ensure you have enough GPU memory (or it will use CPU)
- Check logs in `training_log.txt`

**Need help?**
- Check `training_log.txt` for detailed error messages
- Make sure your dataset file exists and is valid JSON

