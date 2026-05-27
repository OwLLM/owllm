# GUI Setup Guide

## Prerequisites

You need Python installed to run the GUI. Here's how to get started:

### Option 1: Install Python (Recommended)

1. **Download Python** from [python.org](https://www.python.org/downloads/)
   - Download Python 3.8 or higher
   - **Important**: Check "Add Python to PATH" during installation

2. **Verify installation**:
   ```powershell
   python --version
   ```

3. **Install dependencies**:
   ```powershell
   cd C:\1_GitHome\Local-LLM-Server\LLM
   pip install -r requirements.txt
   ```

4. **Run the GUI**:
   ```powershell
   streamlit run gui.py
   ```

### Option 2: Use Virtual Environment (If you have Python elsewhere)

If you have Python installed but it's not in PATH:

1. **Create a virtual environment**:
   ```powershell
   cd C:\1_GitHome\Local-LLM-Server\LLM
   C:\Path\To\Your\python.exe -m venv .venv
   ```

2. **Activate the virtual environment**:
   ```powershell
   .venv\Scripts\Activate.ps1
   ```

3. **Install dependencies**:
   ```powershell
   pip install -r requirements.txt
   ```

4. **Run the GUI**:
   ```powershell
   streamlit run gui.py
   ```

### Option 3: Use Conda (If you have Anaconda/Miniconda)

```powershell
cd C:\1_GitHome\Local-LLM-Server\LLM
conda create -n llm-gui python=3.10
conda activate llm-gui
pip install -r requirements.txt
streamlit run gui.py
```

## Quick Install Script

Save this as `setup_and_run.ps1` and run it (after installing Python):

```powershell
# Navigate to project
Set-Location C:\1_GitHome\Local-LLM-Server\LLM

# Create virtual environment if it doesn't exist
if (!(Test-Path .venv)) {
    Write-Host "Creating virtual environment..."
    python -m venv .venv
}

# Activate virtual environment
Write-Host "Activating virtual environment..."
.venv\Scripts\Activate.ps1

# Install dependencies
Write-Host "Installing dependencies..."
pip install -r requirements.txt

# Run Streamlit
Write-Host "Starting GUI..."
streamlit run gui.py
```

## Troubleshooting

### "Python was not found"
- Install Python from python.org
- Make sure to check "Add Python to PATH" during installation
- Or use full path: `C:\Path\To\python.exe`

### "streamlit: command not found"
```powershell
pip install streamlit pandas
```

### GPU not detected
- Make sure you have CUDA installed if you have an NVIDIA GPU
- Install PyTorch with CUDA support: https://pytorch.org/get-started/locally/

### Port already in use
```powershell
streamlit run gui.py --server.port 8502
```

## Features

Once running, the GUI provides:
- 🎯 **Train Models**: Select base models and upload datasets
- 🧪 **Test Models**: Interactive chat interface
- ✅ **Validate**: Run validation tests
- 📊 **History**: View trained models and logs
- 💻 **GPU Auto-detection**: Automatically uses GPU if available

## Access the GUI

After running, open your browser to:
- **http://localhost:8501**

The browser should open automatically when Streamlit starts.

