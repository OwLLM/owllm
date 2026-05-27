#!/usr/bin/env python3
"""
Kill Zombie LLM Servers

This script kills all zombie LLM server processes that are holding ports 105xx.
Use this when you get "port already in use" errors.
"""

import subprocess
import re
import sys


def get_zombie_servers():
    """Find all Python processes listening on ports 105xx"""
    # Windows subprocess flags to prevent CMD window flashing
    subprocess_flags = {}
    if sys.platform == 'win32':
        import subprocess
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = subprocess.SW_HIDE
        subprocess_flags = {
            'startupinfo': startupinfo,
            'creationflags': subprocess.CREATE_NO_WINDOW
        }

    try:
        # Get netstat output
        result = subprocess.run(
            ['netstat', '-ano'],
            capture_output=True,
            text=True,
            timeout=10,
            **subprocess_flags
        )
        
        if result.returncode != 0:
            print("Failed to run netstat")
            return []
        
        # Parse for LLM server ports (105xx)
        zombie_pids = set()
        for line in result.stdout.split('\n'):
            if 'LISTENING' in line and '127.0.0.1:105' in line:
                parts = line.split()
                if len(parts) >= 5:
                    pid = parts[-1]
                    if pid.isdigit():
                        zombie_pids.add(pid)
        
        return list(zombie_pids)
    
    except Exception as e:
        print(f"Error finding zombie servers: {e}")
        return []


def kill_processes(pids):
    """Kill processes by PID"""
    if not pids:
        print("No zombie servers found!")
        return True
    
    print(f"Found {len(pids)} zombie LLM server(s): {', '.join(pids)}")
    
    try:
        # Kill all at once
        cmd = ['taskkill', '/F'] + [arg for pid in pids for arg in ['/PID', pid]]
        # Windows subprocess flags to prevent CMD window flashing
        subprocess_flags = {}
        if sys.platform == 'win32':
            import subprocess
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = subprocess.SW_HIDE
            subprocess_flags = {
                'startupinfo': startupinfo,
                'creationflags': subprocess.CREATE_NO_WINDOW
            }
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30, **subprocess_flags)
        
        print(result.stdout)
        
        if result.returncode == 0:
            print("✅ All zombie servers killed successfully!")
            return True
        else:
            print("⚠️ Some processes may not have been killed")
            print(result.stderr)
            return False
    
    except Exception as e:
        print(f"❌ Error killing processes: {e}")
        return False


def main():
    print("=" * 60)
    print("Zombie LLM Server Killer")
    print("=" * 60)
    print()
    
    print("Scanning for zombie LLM servers on ports 105xx...")
    zombie_pids = get_zombie_servers()
    
    if not zombie_pids:
        print("✅ No zombie servers found. All ports are free!")
        return 0
    
    print()
    success = kill_processes(zombie_pids)
    
    print()
    print("=" * 60)
    
    if success:
        print("✅ Done! You can now load your models.")
        print()
        print("Note: If ports are still in TIME_WAIT state, wait 30-60 seconds.")
        return 0
    else:
        print("⚠️ Some issues occurred. You may need to restart your computer.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
