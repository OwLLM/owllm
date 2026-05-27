#!/usr/bin/env python3
"""
Standalone pip worker process for LLM Fine-tuning Studio
Runs pip install/uninstall commands without importing target packages
This prevents file locks when installing packages like PyTorch
"""

import sys
import subprocess
import argparse
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description='Run pip commands in isolated process')
    parser.add_argument('--action', required=True, choices=['install', 'uninstall'],
                        help='Action to perform: install or uninstall')
    parser.add_argument('--package', required=True,
                        help='Package name with optional version (e.g., torch, numpy<2, transformers==4.51.3)')
    parser.add_argument('--python', required=True,
                        help='Python executable to use')
    parser.add_argument('--index-url', default='',
                        help='Index URL for pip (e.g., https://download.pytorch.org/whl/cu118)')
    
    # Parse known args, capture unknown args as pip_args
    args, pip_args = parser.parse_known_args()
    
    # Find constraints.txt file (should be in same directory as pip_worker.py)
    constraints_file = Path(__file__).parent / "constraints.txt"
    
    # Build pip command
    if args.action == 'install':
        # Build command: [python, "-m", "pip", "install"] + pip_args + [package]
        cmd = [args.python, "-m", "pip", "install"]
        
        # Add index URL if provided
        if args.index_url:
            cmd.extend(["--index-url", args.index_url])
        
        # Add constraints file if it exists (apply to ALL install commands)
        if constraints_file.exists():
            cmd.extend(["-c", str(constraints_file)])
        
        # Add required flags for ALL installs (hardware/platform-driven architecture)
        cmd.extend(["--no-build-isolation", "--only-binary=:all:"])
        
        # Add pip args (all unknown arguments)
        cmd.extend(pip_args)
        
        # Add package spec (version constraints are already in package string)
        cmd.append(args.package)
        
    elif args.action == 'uninstall':
        cmd = [args.python, "-m", "pip", "uninstall", "-y"] + pip_args + [args.package]
    
    # Run pip command with real-time output streaming
    try:
        # Use Popen to stream output in real-time
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            universal_newlines=True
        )
        
        # Stream output line by line
        output_lines = []
        for line in process.stdout:
            line = line.rstrip()
            if line:
                # Print to stdout (parent process will capture this)
                print(line, flush=True)
                output_lines.append(line)
        
        # Wait for process to complete
        exit_code = process.wait()
        
        # On failure, output error info to stdout (so parent can capture it)
        if exit_code != 0:
            last_lines = output_lines[-200:] if len(output_lines) > 200 else output_lines
            print(f"\n=== ERROR: pip {args.action} failed with exit code {exit_code} ===", flush=True)
            print(f"Command: {' '.join(cmd)}", flush=True)
            if last_lines:
                print(f"Last {len(last_lines)} lines of output:", flush=True)
                for line in last_lines:
                    print(line, flush=True)
            else:
                print("No output captured from pip command.", flush=True)
        
        return exit_code
        
    except Exception as e:
        # Print to stdout so parent can capture it
        error_msg = f"ERROR: Exception running pip command: {str(e)}"
        print(error_msg, flush=True)
        print(f"Command: {' '.join(cmd)}", flush=True)
        import traceback
        print(f"Traceback:\n{traceback.format_exc()}", flush=True)
        return 1


if __name__ == "__main__":
    exit_code = main()
    sys.exit(exit_code)

