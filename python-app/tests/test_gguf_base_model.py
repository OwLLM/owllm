import os
import sys
from pathlib import Path
import pytest

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.llm_backends.run_adapter_backend import _extract_base_model_id_for_gguf

def test_extract_base_model_id_glm_flash(tmp_path):
    """Ensure GLM-4.7-Flash base model extraction works."""
    # Create fake model dir
    model_dir = tmp_path / "DavidAU__GLM-4.7-Flash-Uncensored"
    model_dir.mkdir()
    
    # Write a dummy selected_weights just in case
    (model_dir / ".selected_weights.json").write_text('{"active_variant": "dummy.gguf"}')
    
    res = _extract_base_model_id_for_gguf(model_dir)
    # The folder rule should return DavidAU/GLM-4.7-Flash-Uncensored
    assert res == "DavidAU/GLM-4.7-Flash-Uncensored"
