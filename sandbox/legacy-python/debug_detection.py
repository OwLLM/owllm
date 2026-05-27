"""
Debug script - Check what's actually in system_info
"""
import sys
import os
sys.path.insert(0, r"C:\1_GitHome\Local-LLM-Server\LLM")
os.chdir(r"C:\1_GitHome\Local-LLM-Server\LLM")

from system_detector import SystemDetector
import json

print("="*60)
print("SYSTEM DETECTION TEST")
print("="*60)

detector = SystemDetector()

print("\n1. Python Detection:")
python_info = detector.detect_python()
print(json.dumps(python_info, indent=2))

print("\n2. CUDA Detection:")
cuda_info = detector.detect_cuda()
print(json.dumps(cuda_info, indent=2))

print("\n3. PyTorch Detection:")
pytorch_info = detector.detect_pytorch()
print(json.dumps(pytorch_info, indent=2))

print("\n" + "="*60)
print("SUMMARY:")
print(f"Python: {'✓' if python_info.get('found') else '✗'}")
print(f"CUDA: {'✓' if cuda_info.get('found') else '✗'}")
print(f"GPUs: {len(cuda_info.get('gpus', []))}")
for i, gpu in enumerate(cuda_info.get('gpus', [])):
    print(f"  GPU {i}: {gpu.get('name')} - {gpu.get('memory')}")
print(f"PyTorch: {'✓' if pytorch_info.get('found') else '✗'}")
print(f"PyTorch CUDA: {'✓' if pytorch_info.get('cuda_available') else '✗'}")
print("="*60)

