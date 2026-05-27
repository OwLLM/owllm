"""
Tool implementations package.
Tools are automatically discovered and registered via decorators.
"""
from __future__ import annotations

# Import all tool modules to trigger registration
# This is done automatically by discovery.py, but we can also do it here
# for explicit imports

try:
    from tool_server.tools import filesystem
    from tool_server.tools import git_tools
    from tool_server.tools import shell_tools
except ImportError:
    # Tools might not all be available
    pass
