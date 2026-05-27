#!/usr/bin/env python3
"""
Quick Test Script
Runs a simple inference test to verify the persistent server works.
"""
import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from LLM.core.inference import InferenceConfig, run_inference


def main():
    print("=" * 60)
    print("QUICK TEST: Persistent Server Inference")
    print("=" * 60)
    
    print("\nThis will:")
    print("1. Start the LLM server (may take 2-3 minutes first time)")
    print("2. Run a simple generation")
    print("3. Display the result")
    print()
    
    # Simple test
    print("Creating inference config...")
    cfg = InferenceConfig(
        prompt="Say hello in one sentence.",
        model_id="default",
        max_new_tokens=50,
        temperature=0.7
    )
    
    print("Running inference (this may take a while on first run)...")
    print("Please be patient while the model loads...")
    print()
    
    try:
        result = run_inference(cfg)
        print("=" * 60)
        print("SUCCESS!")
        print("=" * 60)
        print(f"\nGenerated text:\n{result}")
        print("\n" + "=" * 60)
        print("Server is now running and ready for more requests!")
        print("Subsequent calls will be much faster (<1s).")
        print("=" * 60)
        return 0
    except Exception as e:
        print("=" * 60)
        print("ERROR!")
        print("=" * 60)
        print(f"\n{e}\n")
        import traceback
        traceback.print_exc()
        print("\n" + "=" * 60)
        print("Troubleshooting:")
        print("1. Check that model path in LLM/configs/llm_backends.yaml is correct")
        print("2. Ensure Python environment has required packages")
        print("3. Check logs above for specific error details")
        print("=" * 60)
        return 1


if __name__ == "__main__":
    sys.exit(main())
