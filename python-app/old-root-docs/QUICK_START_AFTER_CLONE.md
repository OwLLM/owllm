# Quick Start - After Cloning Repository

## First Time Setup

After cloning this repository on a new PC, follow these steps:

### 1. Check Model Status
```bash
cd LLM
python check_models_after_clone.py
```

This will show you which models need to be downloaded.

### 2. Download Missing Models

**Easiest: Use the GUI**
```bash
python -m desktop_app.main
```
- Go to Models tab
- Incomplete models show ⚠️ INCOMPLETE
- Search and download the models you need

**Alternative: Command Line**
```bash
pip install huggingface_hub
huggingface-cli download MODEL_ID --local-dir DESTINATION_FOLDER --local-dir-use-symlinks False
```

### 3. Verify
```bash
python check_models_after_clone.py
```

All models should now be complete! ✓

## For Complete Documentation

See [MODEL_MANAGEMENT_GUIDE.md](MODEL_MANAGEMENT_GUIDE.md) for:
- Detailed explanation of the problem
- All download options
- Troubleshooting
- Best practices

## Why Do I Need This?

When you clone from GitHub, model directories exist but are **empty** - the actual model weight files (1-50 GB each) are excluded from Git because they're too large.

This is normal and expected! The tools above make it easy to download what you need.

