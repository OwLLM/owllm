"""
Config manager for tool server settings.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional


class ConfigManager:
    """Manages tool server configuration persistence."""
    
    def __init__(self, config_path: Optional[Path] = None):
        if config_path is None:
            # Default to LLM/desktop_app/config/tool_server.json
            config_path = Path(__file__).parent / "tool_server.json"
        self.config_path = config_path
        # Create config directory with error handling to avoid blocking
        try:
            self.config_path.parent.mkdir(parents=True, exist_ok=True)
        except (OSError, PermissionError):
            pass  # Non-critical, operations will fail later if needed
    
    def load(self) -> Dict[str, Any]:
        """Load configuration from file."""
        default_config = {
            "host": "127.0.0.1",
            # Default tool server port used across the app
            "port": 8763,
            "token": "",
            "workspace_root": str(Path.cwd()),
            "allow_shell": False,
            "allow_write": False,
            "allow_git": True,
            "allow_network": False,
            "require_auth_for_tools_list": False,
            "expose_to_lan": False,
            "enabled_tools": {},
        }
        
        if not self.config_path.exists():
            return default_config
        
        try:
            with open(self.config_path, "r", encoding="utf-8") as f:
                config = json.load(f)
                # Merge with defaults to ensure all keys exist
                for key, value in default_config.items():
                    if key not in config:
                        config[key] = value
                return config
        except (IOError, json.JSONDecodeError, PermissionError):
            # Non-critical - return defaults
            return default_config
    
    def save(self, config: Dict[str, Any]) -> None:
        """Save configuration to file."""
        try:
            with open(self.config_path, "w", encoding="utf-8") as f:
                json.dump(config, f, indent=2, ensure_ascii=False)
        except Exception as e:
            raise IOError(f"Failed to save config: {e}")
    
    def get_config_path(self) -> str:
        """Get the config file path as string."""
        return str(self.config_path)
