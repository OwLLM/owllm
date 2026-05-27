# External Tools Directory

This directory contains tools imported from external sources (e.g., GitHub repositories).

## How It Works

1. **Import Tools**: Use the "GitHub Import" tab in the app to clone tool repositories
2. **Automatic Discovery**: Tools are automatically discovered on app startup
3. **Sandboxed Execution**: External tools run with restricted permissions for security

## Directory Structure

Each imported repository is cloned into its own subdirectory:

```
external_tools/
├── username_repo_name/     # Cloned from https://github.com/username/repo_name
│   ├── tool1.py           # Tool files with @tool decorator
│   └── tool2.py
└── another_repo/
    └── tools.py
```

## Creating Your Own Tools

To create a tool that can be imported, create a Python file with the `@tool` decorator:

```python
from tool_server.decorators import tool

@tool(
    name="my_custom_tool",
    description="Does something useful",
    category="Custom",
    danger_level="safe",
    args_schema={
        "type": "object",
        "properties": {
            "input": {"type": "string", "description": "Input text"}
        },
        "required": ["input"]
    }
)
def my_custom_tool_handler(ctx, input: str):
    """Tool implementation"""
    return {"result": f"Processed: {input}"}
```

## Security

- External tools are sandboxed and cannot access dangerous operations
- Tools must declare required permissions (shell, write, network, etc.)
- Code is scanned for dangerous patterns before execution

## Updating Tools

To update an imported tool repository:
1. Go to the "GitHub Import" tab
2. Re-import the same repository URL
3. The app will pull the latest changes
