"""Tool surface for OWLLM agents.

Public:
    Tool, ToolResult, ToolError       -- contract every tool implements
    ToolRegistry                      -- lookup by name, subset by allowlist
    ApprovalGate                      -- blocks risky tools until user approves
    parse_tool_calls, format_for_prompt
                                      -- XML-tag tool-call protocol
    builtin_registry                  -- read/write/list/shell/http_get
"""
from core.agents.tools.base import (
    ApprovalGate,
    ApprovalDecision,
    ApprovalRequest,
    ArgSpec,
    PendingApproval,
    Tool,
    ToolCall,
    ToolError,
    ToolRegistry,
    ToolResult,
    ToolStat,
    ToolTelemetry,
)
from core.agents.tools.builtin import builtin_registry, get_todos, set_todo_context
from core.agents.tools.mcp_adapter import register_mcp_tools
from core.agents.tools.parser import format_for_prompt, parse_tool_calls
from core.agents.tools.verify import VerifyConfig, find_verify_config, run_verify

__all__ = [
    "ArgSpec",
    "Tool",
    "ToolCall",
    "ToolResult",
    "ToolError",
    "ToolRegistry",
    "ToolStat",
    "ToolTelemetry",
    "ApprovalGate",
    "ApprovalDecision",
    "ApprovalRequest",
    "PendingApproval",
    "builtin_registry",
    "get_todos",
    "set_todo_context",
    "register_mcp_tools",
    "parse_tool_calls",
    "format_for_prompt",
    "VerifyConfig",
    "find_verify_config",
    "run_verify",
]
