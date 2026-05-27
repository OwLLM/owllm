# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for LLM Fine-tuning Studio
Creates standalone executable with all dependencies bundled
"""

import os
from pathlib import Path

# Get the directory containing this spec file
spec_dir = Path(SPECPATH).parent if 'SPECPATH' in globals() else Path.cwd()

block_cipher = None

# Collect all necessary data files
datas = []

# Add Streamlit static files
try:
    import streamlit
    streamlit_path = Path(streamlit.__file__).parent
    datas.append((str(streamlit_path / 'static'), 'streamlit/static'))
    datas.append((str(streamlit_path / 'runtime'), 'streamlit/runtime'))
except:
    pass

# Add application files
a = Analysis(
    ['launcher.py'],
    pathex=[str(spec_dir)],
    binaries=[],
    datas=datas,
    hiddenimports=[
        'streamlit',
        'streamlit.web.cli',
        'streamlit.runtime.scriptrunner.script_runner',
        'streamlit.runtime.state',
        'streamlit.runtime.caching',
        'streamlit.runtime.metrics_util',
        'streamlit.runtime.legacy_caching',
        'streamlit.runtime.caching.cache_utils',
        'streamlit.runtime.caching.cache_data_api',
        'streamlit.runtime.caching.cache_resource_api',
        'streamlit.runtime.caching.cache_serializer',
        'streamlit.runtime.legacy_caching.hashing',
        'streamlit.components.v1',
        'streamlit.components.v1.components',
        'altair',
        'pandas',
        'numpy',
        'PIL',
        'PIL.Image',
        'torch',
        'torchvision',
        'transformers',
        'peft',
        'accelerate',
        'datasets',
        'huggingface_hub',
        'sentencepiece',
        'tokenizers',
        'bitsandbytes',
        'system_detector',
        'smart_installer',
        'verify_installation',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

# Collect all submodules
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

# Create executable
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='LLM_Studio',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,  # Show console for debugging
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,  # Add icon path here if you have one
)

