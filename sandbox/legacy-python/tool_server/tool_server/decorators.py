"""
Decorators for registering tools.
"""
from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from tool_server.registry import ToolRegistry
from tool_server.spec import ToolSpec


def tool(
    name: str,
    description: str,
    category: str = "General",
    danger_level: str = "safe",
    requires_permissions: List[str] = None,
    icon_key: Optional[str] = None,
    args_schema: Optional[Dict[str, Any]] = None,
):
    """
    Decorator to register a tool.
    
    Args:
        name: Tool name (must be unique)
        description: Tool description
        category: Tool category (e.g., "Filesystem", "Git", "Shell")
        danger_level: "safe", "warning", or "dangerous"
        requires_permissions: List of required permissions (e.g., ["shell", "write"])
        icon_key: Optional icon identifier
        args_schema: JSON Schema dict for arguments (if None, will try to infer from signature)
    
    Example:
        @tool(
            name="list_dir",
            description="List directory contents",
            category="Filesystem",
            args_schema={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"]
            }
        )
        def list_dir_handler(ctx: ToolContext, path: str = ".") -> Dict[str, Any]:
            ...
    """
    if requires_permissions is None:
        requires_permissions = []
    
    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        # If no schema provided, create minimal one from function signature
        if args_schema is None:
            import inspect
            sig = inspect.signature(func)
            properties = {}
            required = []
            
            for param_name, param in sig.parameters.items():
                if param_name == "ctx" or param_name == "context":
                    continue  # Skip context parameter
                
                param_type = param.annotation
                param_default = param.default
                
                # Infer type from annotation
                if param_type == str or param_type == "str":
                    prop_type = "string"
                elif param_type == int or param_type == "int":
                    prop_type = "integer"
                elif param_type == float or param_type == "float":
                    prop_type = "number"
                elif param_type == bool or param_type == "bool":
                    prop_type = "boolean"
                else:
                    prop_type = "string"  # Default to string
                
                properties[param_name] = {"type": prop_type}
                
                if param_default == inspect.Parameter.empty:
                    required.append(param_name)
            
            inferred_schema = {
                "type": "object",
                "properties": properties,
                "required": required
            }
        else:
            inferred_schema = args_schema
        
        spec = ToolSpec(
            name=name,
            description=description,
            handler=func,
            category=category,
            danger_level=danger_level,
            requires_permissions=requires_permissions,
            args_schema=inferred_schema,
            icon_key=icon_key,
        )
        
        registry = ToolRegistry()
        registry.register(spec)
        
        return func
    
    return decorator
