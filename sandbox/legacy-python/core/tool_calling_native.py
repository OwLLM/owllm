"""
Native tool executor that executes tools directly without HTTP overhead.

This executor bypasses the HTTP tool server and calls tools directly
through the ToolRegistry, providing faster execution and eliminating
port conflicts.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional, Dict, Any

from core.tool_calling import ToolCall, ToolResult


class NativeToolExecutor:
    """Execute tools directly without HTTP overhead"""
    
    def __init__(self, workspace_root: Path, config: dict):
        """
        Args:
            workspace_root: Root directory for tool execution (workspace root)
            config: Tool server configuration dict with permissions and enabled tools
        """
        self.workspace_root = Path(workspace_root).resolve()
        self.config = config
        self.registry = None  # Lazy init to avoid import overhead
    
    def _ensure_registry(self):
        """Lazy initialization of tool registry and discovery"""
        if self.registry is None:
            from tool_server.registry import ToolRegistry
            from tool_server.discovery import discover_tools
            
            # Discover all tools (built-in + external)
            discover_tools()
            self.registry = ToolRegistry()
    
    def execute(self, tool_call: ToolCall, timeout: int = 30) -> ToolResult:
        """
        Execute a tool call directly through the registry.
        
        Args:
            tool_call: Tool call to execute
            timeout: Timeout in seconds (not used in native mode, kept for interface compatibility)
            
        Returns:
            ToolResult with success status and result/error
        """
        self._ensure_registry()
        
        # Create minimal ToolContext matching HTTP server's context
        from tool_server.server import ToolContext
        
        ctx = ToolContext(
            root=self.workspace_root,
            token="",  # Not needed for native execution
            allow_shell=self.config.get("allow_shell", False),
            allow_write=self.config.get("allow_write", False),
            allow_git=self.config.get("allow_git", True),
            allow_network=self.config.get("allow_network", False),
            require_token_for_openai=False,
            backend="mock",  # Not used for tool execution
            model_path="",
            backend_url="",
            enabled_tools=self.config.get("enabled_tools", {}),
            require_auth_for_tools_list=False,
        )
        
        # Call tool directly through registry
        try:
            result_dict = self.registry.call_tool(
                tool_call.name,
                tool_call.arguments,
                ctx
            )
            
            if result_dict.get("ok"):
                return ToolResult(
                    success=True,
                    result=result_dict.get("result")
                )
            else:
                return ToolResult(
                    success=False,
                    result=None,
                    error=result_dict.get("error", "Unknown error")
                )
        except Exception as e:
            return ToolResult(
                success=False,
                result=None,
                error=f"Native execution error: {str(e)}"
            )
