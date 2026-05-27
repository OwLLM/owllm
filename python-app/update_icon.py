#!/usr/bin/env python3
"""
Update icon in launcher.exe using Resource Hacker or direct resource update
"""
import sys
import subprocess
from pathlib import Path

def update_icon_with_rcedit(exe_path, ico_path):
    """Try using rcedit (Node.js tool)"""
    try:
        result = subprocess.run(
            ['rcedit', str(exe_path), '--set-icon', str(ico_path)],
            capture_output=True,
            text=True
        )
        if result.returncode == 0:
            print("SUCCESS: Icon updated using rcedit")
            return True
    except FileNotFoundError:
        pass
    return False

def update_icon_with_python(exe_path, ico_path):
    """Update icon using Python win32api"""
    try:
        import win32api
        import win32con
        import win32gui
        import win32file
        
        # This is complex - we need to use UpdateResource
        # For now, let's try a simpler approach with Resource Hacker CLI
        return False
    except ImportError:
        return False

def main():
    script_dir = Path(__file__).parent
    exe_path = script_dir / "launcher.exe"
    ico_path = script_dir.parent / "icons" / "owl_launcher.ico"
    
    if not exe_path.exists():
        print(f"ERROR: {exe_path} not found!")
        sys.exit(1)
    
    if not ico_path.exists():
        print(f"ERROR: {ico_path} not found!")
        sys.exit(1)
    
    print(f"Updating icon in {exe_path.name}...")
    print(f"Using icon: {ico_path}")
    
    # Try rcedit first (if available)
    if update_icon_with_rcedit(exe_path, ico_path):
        sys.exit(0)
    
    # Try Resource Hacker CLI if available
    try:
        result = subprocess.run(
            ['ResourceHacker.exe', '-open', str(exe_path), '-save', str(exe_path), 
             '-action', 'addoverwrite', '-res', str(ico_path), '-mask', 'ICONGROUP,IDI_ICON1,'],
            capture_output=True,
            text=True,
            cwd=str(script_dir)
        )
        if result.returncode == 0:
            print("SUCCESS: Icon updated using Resource Hacker")
            sys.exit(0)
    except FileNotFoundError:
        pass
    
    print("ERROR: No icon update tool found!")
    print("Options:")
    print("1. Install Resource Hacker: http://www.angusj.com/resourcehacker/")
    print("2. Install rcedit: npm install -g rcedit")
    print("3. Rebuild using build_launcher.bat (which should work)")
    sys.exit(1)

if __name__ == "__main__":
    main()

