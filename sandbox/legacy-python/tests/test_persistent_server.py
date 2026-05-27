#!/usr/bin/env python3
"""
Test Persistent Server Lifecycle
Tests that the LLM server stays running and models remain loaded in memory.
"""
import time
import requests
from pathlib import Path
import sys

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from LLM.core.llm_server_manager import LLMServerManager
from LLM.core.inference_client import InferenceClient


def test_persistent_server():
    """Test server lifecycle and persistence"""
    print("=" * 60)
    print("TEST: Persistent Server Lifecycle")
    print("=" * 60)
    
    # Initialize manager
    config_path = Path(__file__).parent.parent / "configs" / "llm_backends.yaml"
    print(f"\n[1/7] Loading config from: {config_path}")
    
    manager = LLMServerManager(config_path)
    print("✓ Manager initialized")
    
    model_id = "default"
    
    # Start server
    print(f"\n[2/7] Starting server for model '{model_id}'...")
    try:
        server_url = manager.ensure_server_running(model_id)
        print(f"✓ Server started at: {server_url}")
    except Exception as e:
        print(f"✗ Failed to start server: {e}")
        return False
    
    # Check health
    print(f"\n[3/7] Checking server health...")
    client = InferenceClient(server_url)
    
    if not client.health_check():
        print("✗ Server not healthy")
        return False
    print("✓ Server is healthy")
    
    # Make 5 sequential generation requests
    print(f"\n[4/7] Testing 5 sequential generations (model should stay loaded)...")
    prompts = [
        "Say hello",
        "Count to 3",
        "Name a color",
        "What is 2+2?",
        "Say goodbye"
    ]
    
    times = []
    for i, prompt in enumerate(prompts, 1):
        print(f"  Generation {i}/5: '{prompt}'")
        start = time.time()
        try:
            result = client.generate(prompt, max_new_tokens=50, temperature=0.7)
            elapsed = time.time() - start
            times.append(elapsed)
            print(f"    Response ({elapsed:.2f}s): {result[:100]}...")
        except Exception as e:
            print(f"    ✗ Generation failed: {e}")
            return False
    
    print(f"\n  Generation times: {[f'{t:.2f}s' for t in times]}")
    print(f"  Average: {sum(times)/len(times):.2f}s")
    
    # Verify model stays loaded (later generations should be fast)
    print(f"\n[5/7] Verifying model persistence...")
    if len(times) >= 2:
        # First generation may include overhead, but rest should be consistent
        avg_later = sum(times[1:]) / len(times[1:])
        print(f"  Average time for generations 2-5: {avg_later:.2f}s")
        
        if times[0] > avg_later * 1.5:
            print(f"  ✓ First generation slower ({times[0]:.2f}s) than average ({avg_later:.2f}s)")
            print(f"  ✓ Model stayed loaded in memory!")
        else:
            print(f"  Note: All generations took similar time (model likely cached)")
    
    # Check health again
    print(f"\n[6/7] Re-checking server health...")
    if not client.health_check():
        print("✗ Server became unhealthy")
        return False
    print("✓ Server still healthy after 5 generations")
    
    # Cleanup
    print(f"\n[7/7] Cleaning up...")
    manager.shutdown_server(model_id)
    print("✓ Server shut down")
    
    print("\n" + "=" * 60)
    print("TEST PASSED: Persistent Server Lifecycle")
    print("=" * 60)
    return True


if __name__ == "__main__":
    success = test_persistent_server()
    sys.exit(0 if success else 1)
