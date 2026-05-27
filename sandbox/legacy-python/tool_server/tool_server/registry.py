"""
Tool registry for automatic tool discovery and management.
"""
from __future__ import annotations

import json
from dataclasses import asdict
from typing import Any, Dict, List, Optional

from tool_server.spec import ToolSpec


class ToolRegistry:
    """Singleton registry for all tools."""
    
    _instance: Optional[ToolRegistry] = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._tools: Dict[str, ToolSpec] = {}
        return cls._instance
    
    def register(self, spec: ToolSpec) -> None:
        """Register a tool specification."""
        if spec.name in self._tools:
            raise ValueError(f"Tool '{spec.name}' is already registered")
        self._tools[spec.name] = spec
    
    def list_tools(self, enabled_map: Optional[Dict[str, bool]] = None) -> List[Dict[str, Any]]:
        """
        List all tools with their schemas.
        
        Args:
            enabled_map: Optional dict mapping tool names to enabled state.
        
        Returns:
            List of tool dictionaries with name, description, category, danger_level,
            requires_permissions, args_schema_json, icon_key, and enabled status.
        """
        enabled_map = enabled_map or {}
        tools = []
        
        for name, spec in sorted(self._tools.items()):
            # Convert args_schema to JSON string if it's a dict
            args_schema_json = None
            if spec.args_schema:
                if isinstance(spec.args_schema, dict):
                    args_schema_json = json.dumps(spec.args_schema)
                else:
                    args_schema_json = json.dumps(asdict(spec.args_schema) if hasattr(spec.args_schema, '__dict__') else str(spec.args_schema))
            
            tools.append({
                "name": spec.name,
                "description": spec.description,
                "category": spec.category,
                "danger_level": spec.danger_level,
                "requires_permissions": spec.requires_permissions,
                "args_schema_json": args_schema_json,
                "icon_key": spec.icon_key,
                "enabled": enabled_map.get(name, True),  # Default to enabled
            })
        
        return tools
    
    def call_tool(self, name: str, args: Dict[str, Any], context: Any) -> Dict[str, Any]:
        """
        Call a tool with validation and permission checks.
        
        Args:
            name: Tool name
            args: Tool arguments
            context: ToolContext for permission checking
        
        Returns:
            Result dictionary with 'ok' and either 'result' or 'error'
        """
        if name not in self._tools:
            return {"ok": False, "error": f"Unknown tool: {name}"}
        
        spec = self._tools[name]
        
        # Check permissions
        for perm in spec.requires_permissions:
            if perm == "shell" and not getattr(context, "allow_shell", False):
                return {"ok": False, "error": "Tool requires 'allow_shell' permission"}
            if perm == "write" and not getattr(context, "allow_write", False):
                return {"ok": False, "error": "Tool requires 'allow_write' permission"}
            if perm == "git" and not getattr(context, "allow_git", True):  # git defaults to True
                return {"ok": False, "error": "Tool requires 'allow_git' permission"}
            if perm == "network" and not getattr(context, "allow_network", False):
                return {"ok": False, "error": "Tool requires 'allow_network' permission"}
        
        # Basic schema validation (minimal - check required fields)
        if spec.args_schema and isinstance(spec.args_schema, dict):
            required = spec.args_schema.get("required", [])
            for field in required:
                if field not in args:
                    return {"ok": False, "error": f"Missing required argument: {field}"}
        
        # Call the handler
        try:
            raw = spec.handler(context, **args)
            # Normalize handler output so top-level ok/error is reliable for the tool loop
            if isinstance(raw, dict):
                if "ok" in raw and isinstance(raw.get("ok"), bool):
                    if raw["ok"]:
                        return {"ok": True, "result": raw.get("result", raw)}
                    return {"ok": False, "error": raw.get("error", "Tool reported failure")}
                if "error" in raw and raw["error"]:
                    return {"ok": False, "error": str(raw["error"])}
            return {"ok": True, "result": raw}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    
    def get_tool(self, name: str) -> Optional[ToolSpec]:
        """Get a tool specification by name."""
        return self._tools.get(name)
    
    def clear(self) -> None:
        """Clear all registered tools (mainly for testing)."""
        self._tools.clear()
