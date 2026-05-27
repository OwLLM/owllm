#!/usr/bin/env python3
"""
Setup State Management Module
Handles reading and updating the setup state for LLM Fine-tuning Studio
"""

import json
from pathlib import Path
from datetime import datetime
from typing import Dict, Optional


class SetupStateManager:
    """Manages the setup state file"""
    
    def __init__(self, state_file: Optional[Path] = None):
        if state_file is None:
            self.state_file = Path(__file__).parent / ".setup_state.json"
        else:
            self.state_file = Path(state_file)
        
        self.marker_file = self.state_file.parent / ".setup_complete"
    
    def is_setup_complete(self) -> bool:
        """Check if first-time setup has been completed"""
        return self.marker_file.exists() and self.state_file.exists()
    
    def get_state(self) -> Optional[Dict]:
        """Get the current setup state"""
        if not self.state_file.exists():
            return None
        
        try:
            with open(self.state_file, 'r') as f:
                return json.load(f)
        except Exception:
            return None
    
    def save_state(self, state: Dict) -> bool:
        """Save the setup state"""
        try:
            # Update timestamp
            state["last_check"] = datetime.now().isoformat()
            
            # Save state file
            with open(self.state_file, 'w') as f:
                json.dump(state, f, indent=2)
            
            # Create marker file
            if state.get("setup_complete"):
                self.marker_file.touch()
            
            return True
        except Exception as e:
            print(f"Error saving setup state: {e}")
            return False
    
    def update_last_check(self) -> bool:
        """Update the last check timestamp"""
        state = self.get_state()
        if state:
            state["last_check"] = datetime.now().isoformat()
            return self.save_state(state)
        return False
    
    def needs_recheck(self, days: int = 7) -> bool:
        """Check if setup needs to be rechecked (default: weekly)"""
        state = self.get_state()
        if not state:
            return True
        
        last_check = state.get("last_check")
        if not last_check:
            return True
        
        try:
            last_check_dt = datetime.fromisoformat(last_check)
            now = datetime.now()
            delta = now - last_check_dt
            return delta.days >= days
        except:
            return True
    
    def get_hardware_summary(self) -> str:
        """Get a summary of detected hardware"""
        state = self.get_state()
        if not state:
            return "Setup not completed"
        
        hw = state.get("hardware", {})
        lines = []
        
        cpu = hw.get("cpu", "Unknown")
        ram = hw.get("ram_gb", 0)
        gpu = hw.get("gpu", "N/A")
        
        lines.append(f"CPU: {cpu}")
        lines.append(f"RAM: {ram:.0f} GB")
        lines.append(f"GPU: {gpu}")
        
        return " | ".join(lines)
    
    def get_installed_versions(self) -> Dict:
        """Get versions of installed components"""
        state = self.get_state()
        if not state:
            return {}
        
        return state.get("installed_versions", {})
    
    def reset_setup(self) -> bool:
        """Reset setup state (force re-setup)"""
        try:
            # Remove marker file
            if self.marker_file.exists():
                self.marker_file.unlink()
            
            # Remove state file
            if self.state_file.exists():
                self.state_file.unlink()
            
            return True
        except Exception as e:
            print(f"Error resetting setup: {e}")
            return False
    
    def get_selected_profile(self) -> Optional[str]:
        """
        Get the user-selected profile ID (if any).
        
        Returns:
            Profile ID string (e.g., 'ampere_cu121') or None if not set
        """
        state = self.get_state()
        if not state:
            return None
        return state.get("selected_profile_id")
    
    def set_selected_profile(self, profile_id: str) -> bool:
        """
        Persist the user-selected profile ID.
        
        Args:
            profile_id: Profile ID to persist (e.g., 'ampere_cu121')
        
        Returns:
            True if saved successfully
        """
        state = self.get_state() or {}
        state["selected_profile_id"] = profile_id
        return self.save_state(state)
    
    def get_selected_gpu_index(self) -> Optional[int]:
        """
        Get the user-selected GPU index (for multi-GPU systems).
        
        Returns:
            GPU index (0-based) or None if not set
        """
        state = self.get_state()
        if not state:
            return None
        return state.get("selected_gpu_index")
    
    def set_selected_gpu_index(self, gpu_index: int) -> bool:
        """
        Persist the user-selected GPU index.
        
        Args:
            gpu_index: GPU index (0-based)
        
        Returns:
            True if saved successfully
        """
        state = self.get_state() or {}
        state["selected_gpu_index"] = gpu_index
        return self.save_state(state)


# Convenience functions
def is_setup_complete() -> bool:
    """Check if setup is complete"""
    manager = SetupStateManager()
    return manager.is_setup_complete()


def get_setup_state() -> Optional[Dict]:
    """Get the current setup state"""
    manager = SetupStateManager()
    return manager.get_state()


def needs_setup_recheck(days: int = 7) -> bool:
    """Check if setup needs rechecking"""
    manager = SetupStateManager()
    return manager.needs_recheck(days)


if __name__ == "__main__":
    # CLI for checking setup state
    manager = SetupStateManager()
    
    if manager.is_setup_complete():
        print("✓ Setup is complete")
        print()
        print("Hardware Summary:")
        print(manager.get_hardware_summary())
        print()
        print("Installed Versions:")
        versions = manager.get_installed_versions()
        for component, version in versions.items():
            print(f"  {component}: {version}")
        print()
        
        if manager.needs_recheck():
            print("⚠ Setup check recommended (>7 days since last check)")
        else:
            print("✓ Setup recently verified")
    else:
        print("✗ Setup not complete")
        print("Run LAUNCHER.bat to start first-time setup")

