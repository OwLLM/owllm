# Model Management After Git Clone

## Problem

When you clone this repository on a new machine, you'll notice that some model directories exist but are incomplete - they're missing the actual model weight files (`.safetensors`, `.bin` files). This is intentional because model files are too large for Git (often 1-50 GB each).

## Solution

This project includes an **automatic model integrity checker** that:

1. **Detects incomplete models** - identifies which models need downloading
2. **Provides download instructions** - shows exactly how to get missing models
3. **Integrates with the GUI** - marks incomplete models with warnings
4. **Generates documentation** - creates a comprehensive status report

## Quick Fix Steps

### Step 1: Check Model Status

Run the post-clone check script:

```bash
cd LLM
python check_models_after_clone.py
```

This will show you:
- Which models are complete (ready to use)
- Which models are incomplete (need download)
- Specific instructions for each incomplete model

### Step 2: Download Missing Models

**Option A: Use the GUI (Recommended)**

```bash
cd LLM
python -m desktop_app.main
```

1. Open the **Models** tab
2. Incomplete models will show ⚠️ INCOMPLETE
3. Search for the model in the right panel
4. Click **Download** button

**Option B: Use Command Line**

```bash
# Install HuggingFace CLI (if not installed)
pip install huggingface_hub

# Download a specific model
huggingface-cli download MODEL_ID --local-dir PATH_TO_MODEL --local-dir-use-symlinks False
```

Example:
```bash
huggingface-cli download unsloth/llama-3.2-3b-instruct-unsloth-bnb-4bit \
  --local-dir LLM/models/unsloth__llama-3.2-3b-instruct-unsloth-bnb-4bit \
  --local-dir-use-symlinks False
```

**Option C: Use Python Script**

```python
from huggingface_hub import snapshot_download

snapshot_download(
    repo_id='unsloth/llama-3.2-3b-instruct-unsloth-bnb-4bit',
    local_dir='LLM/models/unsloth__llama-3.2-3b-instruct-unsloth-bnb-4bit',
    local_dir_use_symlinks=False
)
```

### Step 3: Verify Installation

After downloading, run the check script again:

```bash
python check_models_after_clone.py
```

All models should now show as complete! ✓

## Technical Details

### What's Excluded from Git

The `.gitignore` file excludes:
- `*.safetensors` - Model weights (1-50 GB each)
- `*.bin` - PyTorch model weights
- `*.pt`, `*.pth` - PyTorch checkpoint files

### What's Kept in Git

The repository includes:
- `config.json` - Model configuration
- `tokenizer*.json` - Tokenizer files
- `*.md` - Documentation files
- Directory structures - So you know which models should be there

## Model Integrity Checker Tool

The project includes `model_integrity_checker.py` which provides:

```bash
# Check all models
python model_integrity_checker.py

# Check only incomplete models
python model_integrity_checker.py --check-incomplete

# Generate detailed README with download instructions
python model_integrity_checker.py --generate-readme
```

This creates `MODELS_README.md` with:
- Complete list of all models
- Status of each model (complete/incomplete)
- Download instructions for each incomplete model
- Model sizes and IDs

## Integration with Application

The LLM Studio GUI automatically:

1. **Checks models on startup** - Runs integrity check when loading Models tab
2. **Shows warnings** - Displays ⚠️ INCOMPLETE for models missing weights
3. **Logs issues** - Lists incomplete models in the status log
4. **Provides download UI** - Easy search and download from Models tab

## Workflow for New Team Members

When setting up on a new machine:

1. **Clone the repository**
   ```bash
   git clone <repo-url>
   cd Local-LLM-Server/LLM
   ```

2. **Install dependencies**
   ```bash
   pip install -r requirements.txt
   ```

3. **Check model status**
   ```bash
   python check_models_after_clone.py
   ```

4. **Download needed models**
   - Use GUI: `python -m desktop_app.main`
   - Or follow instructions from step 3

5. **Start working**
   - All models complete? You're ready!

## CI/CD Considerations

For automated deployments:

1. **Don't commit model weights** - Always excluded in `.gitignore`
2. **Use post-clone hooks** - Run `check_models_after_clone.py` in your deploy script
3. **Cache models** - In CI/CD, cache the `models/` and `hf_models/` directories
4. **Document requirements** - Keep `MODELS_README.md` updated

## Troubleshooting

**Problem: Models show as incomplete after download**

- Check that files were downloaded to the correct directory
- Verify the model ID matches (use `--` instead of `/` in folder names)
- Example: `unsloth/model` → `unsloth__model`

**Problem: Download fails with authentication error**

- Some models require HuggingFace authentication
- Login: `huggingface-cli login`
- Or set token: `export HUGGING_FACE_HUB_TOKEN=your_token`

**Problem: Out of disk space**

- Models can be 1-50 GB each
- Check available space before downloading
- Consider downloading only models you need
- Use 4-bit quantized models (smaller, marked as `bnb-4bit`)

## Best Practices

1. **Generate README regularly** - Run `python model_integrity_checker.py --generate-readme` after adding/removing models

2. **Check before committing** - Run check script to ensure you're not accidentally committing large files

3. **Document model sources** - Keep notes on where models came from and why they're included

4. **Use model versioning** - Include version/date in model directory names when possible

5. **Clean up unused models** - Remove models you're not using to save disk space

## Files Created by This Solution

- `LLM/model_integrity_checker.py` - Core checker tool
- `LLM/check_models_after_clone.py` - Post-clone check script
- `LLM/MODELS_README.md` - Auto-generated status report (gitignored)
- `LLM/.gitkeep_models` - Ensures models/ directory exists
- `LLM/.gitkeep_hf_models` - Ensures hf_models/ directory exists
- `.gitignore` - Updated to exclude weights but keep configs

## Summary

✅ **Problem Solved:**
- Git no longer contains huge model files
- Directory structures preserved
- Clear instructions for downloading on new machines
- Automated detection of incomplete models
- GUI integration for easy fixing

✅ **Benefits:**
- Faster git operations
- Smaller repository size
- Clear documentation
- Easy onboarding for new team members
- Automated validation

✅ **Tools Provided:**
- `check_models_after_clone.py` - Post-clone validation
- `model_integrity_checker.py` - Detailed model analysis
- GUI integration - Visual warnings and easy downloads
- Auto-generated documentation - Always up-to-date

---

**Need Help?**

Run any of these commands:
```bash
python check_models_after_clone.py          # Quick status check
python model_integrity_checker.py --help    # Detailed options
python -m desktop_app.main                  # Open GUI
```

