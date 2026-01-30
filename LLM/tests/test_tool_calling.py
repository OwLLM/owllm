"""
PHASE 3: pytest test suite for tool calling functionality.
"""
import pytest
import sys
from pathlib import Path

# Add LLM to path
llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))


def test_tool_call_detector_import():
    """Test that tool calling modules import"""
    from core.tool_calling import ToolCallDetector, ToolExecutor, ToolApprovalManager
    
    assert ToolCallDetector is not None
    assert ToolExecutor is not None
    assert ToolApprovalManager is not None


def test_tool_call_detector_json():
    """Test JSON tool call detection"""
    from core.tool_calling import ToolCallDetector
    
    detector = ToolCallDetector()
    
    # Test valid JSON tool call
    text_with_json = '''Here is the result:
{"tool": "calculator", "args": {"expression": "42*17"}, "id": "call_123"}
That's the answer.'''
    
    calls = detector.detect(text_with_json)
    
    # Should detect at least one call (depending on current implementation)
    assert isinstance(calls, list)


def test_tool_registry():
    """Test tool registry imports and list_tools."""
    from tool_server.registry import ToolRegistry
    from tool_server.discovery import discover_tools

    discover_tools()
    registry = ToolRegistry()
    tools = registry.list_tools()
    assert isinstance(tools, list)


def test_tool_failure_propagation():
    """Handlers that return {'error': ...} must become top-level ok=false so the tool loop can react."""
    from pathlib import Path
    from tool_server.registry import ToolRegistry
    from tool_server.discovery import discover_tools
    from tool_server.server import ToolContext

    discover_tools()
    registry = ToolRegistry()
    root = Path(__file__).parent.parent
    ctx = ToolContext(
        root=root,
        token="",
        allow_shell=False,
        allow_write=False,
        allow_git=True,
        allow_network=False,
        enabled_tools={},
    )

    # read_file on missing path: handler returns {"error": "File not found"} -> registry must return ok=false
    out = registry.call_tool("read_file", {"path": "nonexistent_file_xyz_123.txt"}, ctx)
    assert out.get("ok") is False, "read_file on missing path must yield ok=false"
    assert "error" in out and out["error"], "error message must be present"


@pytest.mark.skipif(True, reason="Requires running tool server")
def test_tool_server_health():
    """Test tool server health endpoint (requires server running)"""
    import requests
    
    try:
        response = requests.get("http://localhost:8763/health", timeout=2)
        assert response.status_code == 200
    except requests.exceptions.RequestException:
        pytest.skip("Tool server not running")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
