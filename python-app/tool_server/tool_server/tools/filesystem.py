"""
Filesystem tools.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

from tool_server.decorators import tool


@tool(
    name="list_dir",
    description="List files and folders in a directory",
    category="Filesystem",
    danger_level="safe",
    icon_key="folder",
    args_schema={
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Directory path (relative to workspace root)",
                "default": "."
            }
        },
        "required": []
    }
)
def list_dir_handler(ctx: Any, path: str = ".") -> Dict[str, Any]:
    """List directory contents."""
    # Use context's safe_path method to ensure path is jailed
    safe_path = ctx._safe_path(path)
    
    if not safe_path.exists():
        return {"error": "Path not found"}
    
    if not safe_path.is_dir():
        return {"error": "Path is not a directory"}
    
    items = []
    for child in sorted(safe_path.iterdir(), key=lambda x: x.name.lower()):
        items.append({
            "name": child.name,
            "type": "dir" if child.is_dir() else "file",
            "size": child.stat().st_size if child.is_file() else None,
        })
    
    return {"items": items}


@tool(
    name="read_file",
    description="Read a text file (UTF-8, best effort)",
    category="Filesystem",
    danger_level="safe",
    icon_key="file",
    args_schema={
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "File path (relative to workspace root)"
            }
        },
        "required": ["path"]
    }
)
def read_file_handler(ctx: Any, path: str) -> Dict[str, Any]:
    """Read file contents."""
    safe_path = ctx._safe_path(path)
    
    if not safe_path.exists() or not safe_path.is_file():
        return {
            "error": f"File not found (looked in: {safe_path})"
        }
    
    data = safe_path.read_bytes()
    try:
        content = data.decode("utf-8")
    except UnicodeDecodeError:
        content = data.decode("utf-8", "replace")
    
    return {"content": content, "size": len(data)}


@tool(
    name="write_file",
    description="Write text content to a file (creates parent directories)",
    category="Filesystem",
    danger_level="warning",
    requires_permissions=["write"],
    icon_key="file-edit",
    args_schema={
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "File path (relative to workspace root)"
            },
            "content": {
                "type": "string",
                "description": "File content to write"
            }
        },
        "required": ["path", "content"]
    }
)
def write_file_handler(ctx: Any, path: str, content: str) -> Dict[str, Any]:
    """Write file contents."""
    safe_path = ctx._safe_path(path)
    safe_path.parent.mkdir(parents=True, exist_ok=True)
    safe_path.write_text(content, encoding="utf-8")
    return {"written": str(path), "size": len(content.encode("utf-8"))}
