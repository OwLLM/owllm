#!/usr/bin/env python3
"""
Post-Clone Setup Script
Run this after cloning the repository to check model status
"""

import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent))

from model_integrity_checker import ModelIntegrityChecker
import logging

logging.basicConfig(level=logging.INFO, format='%(message)s')
logger = logging.getLogger(__name__)


def main():
    """Run post-clone setup checks"""
    print("=" * 70)
    print("  LLM Studio - Post-Clone Setup Check")
    print("=" * 70)
    print()
    
    checker = ModelIntegrityChecker()
    
    # Check all models
    print("Checking model installations...\n")
    all_models = checker.check_all_models()
    
    complete = [m for m in all_models if m.is_complete]
    incomplete = [m for m in all_models if not m.is_complete]
    
    # Display summary
    print(f"Total models found: {len(all_models)}")
    print(f"  Complete:         {len(complete)} (Ready to use)")
    print(f"  Incomplete:       {len(incomplete)} (Need download)")
    print()
    
    if incomplete:
        print("=" * 70)
        print("  INCOMPLETE MODELS DETECTED")
        print("=" * 70)
        print()
        print("The following models are missing weights and need to be downloaded:")
        print()
        
        for model in incomplete:
            print(f"  X {model.model_name}")
            if model.model_id:
                print(f"    Model ID: {model.model_id}")
            print(f"    Missing:  {', '.join(model.missing_files)}")
            print()
        
        print("=" * 70)
        print("  HOW TO FIX")
        print("=" * 70)
        print()
        print("Option 1: Use the GUI (Easiest)")
        print("  1. Run: python -m desktop_app.main")
        print("  2. Go to the Models tab")
        print("  3. Search for and download the missing models")
        print()
        print("Option 2: Use the model integrity checker")
        print("  python model_integrity_checker.py --generate-readme")
        print("  Then follow instructions in MODELS_README.md")
        print()
        print("Option 3: Use huggingface-cli")
        print("  pip install huggingface_hub")
        print("  huggingface-cli download <model-id> --local-dir <target-dir>")
        print()
        print("=" * 70)
        
    else:
        print("=" * 70)
        print("  All models are complete and ready to use!")
        print("=" * 70)
        print()
    
    # Generate detailed README
    print("Generating detailed model status report...")
    checker.create_models_readme()
    print(f"  Report saved to: MODELS_README.md")
    print()
    
    if incomplete:
        return 1  # Exit with error code
    return 0


if __name__ == "__main__":
    sys.exit(main())

