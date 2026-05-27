"""
Tool specification dataclass.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional


@dataclass
class ToolSpec:
    """Tool specification."""
    name: str
    description: str
    handler: Callable[..., Any]
    category: str = "General"
    danger_level: str = "safe"  # safe, warning, dangerous
    requires_permissions: List[str] = field(default_factory=list)
    args_schema: Optional[Dict[str, Any]] = None
    icon_key: Optional[str] = None
