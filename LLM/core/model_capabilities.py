"""
Model capabilities detection for function calling support.

Auto-detects if a model has native function calling support or needs prompting.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Optional


def detect_function_calling_support(model_path: str) -> Dict[str, any]:
    """
    Detect if model supports function calling.
    
    Args:
        model_path: Path to model directory or HuggingFace model ID
        
    Returns:
        {
            "native_support": bool,
            "method": "native" | "prompted" | "none",
            "system_prompt_template": str
        }
    """
    # Check if it's a local path
    path = Path(model_path)
    if path.exists() and path.is_dir():
        # Try to read config.json
        config_file = path / "config.json"
        if config_file.exists():
            try:
                with open(config_file, 'r', encoding='utf-8') as f:
                    config = json.load(f)
                    model_type = config.get("model_type", "").lower()
                    architectures = config.get("architectures", [])
                    
                    # Check for known function calling architectures
                    if _has_native_function_calling(model_type, architectures):
                        return {
                            "native_support": True,
                            "method": "native",
                            "system_prompt_template": get_native_system_prompt()
                        }
            except:
                pass
    
    # Check by model name/ID
    model_name = model_path.lower()
    if _is_function_calling_model(model_name):
        return {
            "native_support": True,
            "method": "native",
            "system_prompt_template": get_native_system_prompt()
        }
    
    # Default: use prompt engineering
    return {
        "native_support": False,
        "method": "prompted",
        "system_prompt_template": get_prompted_system_prompt()
    }


def _has_native_function_calling(model_type: str, architectures: list) -> bool:
    """Check if model architecture supports native function calling"""
    # Known architectures with function calling
    function_calling_indicators = [
        "llama",  # Llama 3.1+ has function calling
        "mistral",  # Mistral has function calling
        "qwen",  # Qwen models support tools
        "phi",  # Phi-3 has function calling
    ]
    
    for indicator in function_calling_indicators:
        if indicator in model_type:
            return True
        for arch in architectures:
            if indicator in arch.lower():
                return True
    
    return False


def _is_function_calling_model(model_name: str) -> bool:
    """Check model name for function calling indicators"""
    function_calling_keywords = [
        "function",
        "tool",
        "hermes",  # Hermes models are fine-tuned for function calling
        "functionary",
    ]
    
    # Version indicators (Llama 3.1+, Mistral 7B v3+, etc.)
    version_indicators = [
        "3.1", "3.2", "3.3",  # Llama versions with function calling
        "v0.3", "v3",  # Mistral versions
    ]
    
    for keyword in function_calling_keywords:
        if keyword in model_name:
            return True
    
    for version in version_indicators:
        if version in model_name and "llama" in model_name:
            return True
    
    return False


def get_native_system_prompt() -> str:
    """System prompt for models with native function calling support"""
    return """You are a helpful AI assistant with access to tools. When you need to use a tool to help answer the user's question, you can call it using the proper function calling format."""


def get_prompted_system_prompt() -> str:
    """System prompt for models without native function calling (using prompt engineering)"""
    return """You are a helpful AI assistant with access to tools. When you need to use a tool, respond with the following XML format:

<tool_call>tool_name(arg1="value1", arg2="value2")</tool_call>

IMPORTANT - File Paths:
- All paths must be RELATIVE to the workspace root
- Use forward slashes: LLM/file.txt (not LLM\\file.txt)
- Do NOT use absolute paths like C:\\ or /home/
- Examples: "README.md", "docs/guide.md", "path/to/file.txt"

IMPORTANT - When to use tools:
- Only call a tool if the user explicitly asks you to, or if it is clearly necessary to answer the question.
- Never call tools for greetings, small talk, or generic chat messages (e.g., "Hello", "Hi", "Thanks"). Reply with normal text only.
- If the user did not ask for a concrete file/system action, do not call any tool.

Available tools:
- read_file(path: str) - Read a text file
  Example: <tool_call>read_file(path="README.md")</tool_call>
  Example: <tool_call>read_file(path="docs/guide.md")</tool_call>

- write_file(path: str, content: str) - Write to a file
  Example: <tool_call>write_file(path="output.txt", content="Hello")</tool_call>
  Example: <tool_call>write_file(path="LLM/results.txt", content="Data")</tool_call>

- list_dir(path: str) - List directory contents (default: ".")
  Example: <tool_call>list_dir(path=".")</tool_call>
  Example: <tool_call>list_dir(path="LLM")</tool_call>

- run_shell(command: str) - Execute a shell command
  Example: <tool_call>run_shell(command="dir")</tool_call>
  Example: <tool_call>run_shell(command="ls -la")</tool_call>

- git_status() - Get git repository status
  Example: <tool_call>git_status()</tool_call>

After calling a tool, you will receive the result. Use it to formulate your answer. Only call tools when necessary."""


def get_tool_system_prompt(model_path: str) -> str:
    """
    Get appropriate system prompt for tool use based on model capabilities.
    
    Args:
        model_path: Path to model or model ID
        
    Returns:
        System prompt string
    """
    capabilities = detect_function_calling_support(model_path)
    return capabilities["system_prompt_template"]


def get_available_tools_description() -> str:
    """Get formatted description of available tools"""
    return """Available Tools:

1. read_file(path: str)
   - Reads the contents of a text file
   - Returns: File content as string

2. write_file(path: str, content: str)
   - Writes content to a file
   - Creates parent directories if needed
   - Returns: Success message

3. list_dir(path: str = ".")
   - Lists files and directories
   - Default path is current directory
   - Returns: List of files and folders

4. run_shell(command: str)
   - Executes a shell command
   - Returns: Command output (stdout/stderr)
   - ⚠️ Requires shell permission

5. git_status()
   - Gets git repository status
   - Returns: Git status in porcelain format
   - Requires git permission
"""
