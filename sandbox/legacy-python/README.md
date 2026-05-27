# LLM — Finetune / Train / Validate / Run

This document explains how to set up the environment and run the included scripts to finetune, train, validate, and run the model found in this repository's `LLM` folder.

**Prerequisites**
- Python 3.8+ installed
- Git
- (Optional) CUDA drivers and a suitable GPU for faster training

## 🚨 Important: First Time Setup on a New Machine

**After cloning this repository, you MUST download model weights:**

```bash
cd LLM
python check_models_after_clone.py
```

This will check which models are incomplete and provide download instructions.

**Why?** Model weight files (1-50 GB each) are excluded from Git. You need to download them separately.

**See:** [MODEL_MANAGEMENT_GUIDE.md](../MODEL_MANAGEMENT_GUIDE.md) for detailed instructions.

---

# 🎨 GUI Interface (Recommended)

The easiest way to use this project is through the beautiful web-based GUI.

## Quick Start (Windows)

1. **Install Python** from [python.org](https://www.python.org/downloads/)
   - Download Python 3.8 or higher
   - **Important**: Check "Add Python to PATH" during installation

2. **Run the setup script** (choose one):
   ```cmd
   cd C:\1_GitHome\Local-LLM-Server\LLM
   install_python.bat
   ```
   Or in PowerShell:
   ```powershell
   cd C:\1_GitHome\Local-LLM-Server\LLM
   .\install_python.ps1
   ```

3. **Launch the GUI**:
   ```cmd
   run_gui.bat
   ```
   Or in PowerShell:
   ```powershell
   .\run_gui.ps1
   ```

The GUI will open at `http://localhost:8501` in your browser.

## Quick Launch (After Setup)

Once everything is installed, simply run:

**Windows:**
```cmd
cd C:\1_GitHome\Local-LLM-Server\LLM
start_gui.bat
```

**PowerShell:**
```powershell
cd C:\1_GitHome\Local-LLM-Server\LLM
.\start_gui.ps1
```

## Manual Setup

If you prefer manual setup:

```bash
cd LLM
python -m venv .venv
.venv\Scripts\activate  # Windows
# .venv/bin/activate   # Linux/Mac
pip install -r requirements.txt
streamlit run gui.py
```

# LLM — Quick Usage

Minimal instructions to set up and use the LLM management scripts in this folder.

Setup
-----

Run these inside the `LLM` folder. Change into `LLM`, create and activate a virtual environment, then install the requirements:

```bash
cd LLM
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Example training data (JSONL)
----------------------------

Save one example per line to `train_data.jsonl`:

```jsonl
{"instruction": "Translate the following sentence into French:", "output": "Bonjour le monde"}
```

Manual commands (run inside `LLM`)
---------------

```bash
# Train (manual)
cd LLM
python finetune.py --data-path train_data.jsonl --output-dir ./fine_tuned --epochs 3 --batch-size 1

# Validate (manual)
# Note: replace with your actual adapter name
python validate_prompts.py --adapter-dir ./fine_tuned/gemma-2-2b-it-custom-v1 --base-model unsloth/llama-3.2-3b-instruct-unsloth-bnb-4bit --prompts validation_prompts.jsonl --out validation_results.jsonl

# Run (manual)
# Note: replace with your actual adapter name
python run_adapter.py --adapter-dir ./fine_tuned/gemma-2-2b-it-custom-v1 --prompt "### Instruction:\nSummarize this paragraph.\n\n### Response:\n"
```

Notes
-----

- Adapters are saved as `base_model-task-vN` under your `--output-dir` (e.g. `fine_tuned/gemma-2-2b-it-beauty-v1`).
- W&B is offline by default. To enable online W&B, install `wandb` and run `workflow.py` with `--enable-wandb`.
- Preview cleanup with `bash cleanup_generated.sh` and delete with `bash cleanup_generated.sh --yes`.

Example instruction (short)
--------------------------

```jsonl
{"instruction": "Summarize the following paragraph in one sentence:", "output": "This paragraph explains how to..."}
```

That's it — use `workflow.py` for most tasks; manual commands remain available for custom workflows.
