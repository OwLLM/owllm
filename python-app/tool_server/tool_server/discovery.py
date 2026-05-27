"""
Automatic tool discovery from tool modules.
"""
from __future__ import annotations

import importlib
import pkgutil
from pathlib import Path


def discover_tools() -> None:
    """
    Discover and import all tools from LLM.tool_server.tools package.
    This will trigger tool registration via decorators.
    Also discovers external tools from external_tools/ directory.
    """
    try:
        # Import the tools package
        tools_package = "tool_server.tools"
        
        try:
            package = importlib.import_module(tools_package)
        except ImportError as e:
            import sys
            sys.stderr.write(f"[tool discovery] Could not import {tools_package}: {e}\n")
            return
        
        # Get the package path
        if not hasattr(package, "__path__"):
            return
        
        package_path = Path(package.__path__[0])

        for finder, name, ispkg in pkgutil.iter_modules([str(package_path)]):
            if not ispkg and not name.startswith("_"):
                try:
                    module_name = f"{tools_package}.{name}"
                    importlib.import_module(module_name)
                except Exception as e:
                    # Log but don't fail - some modules might have optional dependencies
                    import sys
                    sys.stderr.write(f"[tool discovery] Could not import {name}: {e}\n")
        
        # Discover external tools
        try:
            external_dir = Path(__file__).parent / "external_tools"
            if external_dir.exists():
                _discover_external_tools(external_dir)
        except Exception as e:
            import sys
            sys.stderr.write(f"[external tools] Discovery error: {e}\n")
    except Exception as e:
        import sys
        sys.stderr.write(f"[tool discovery] Error during discovery: {e}\n")


def _discover_external_tools(external_dir: Path) -> None:
    """
    Discover tools from external_tools/ subdirectories.
    
    Args:
        external_dir: Path to external_tools directory
    """
    import sys
    
    if not external_dir.exists() or not external_dir.is_dir():
        return
    
    for subdir in external_dir.iterdir():
        if not subdir.is_dir() or subdir.name.startswith("_"):
            continue
        
        # Add subdirectory to path temporarily
        subdir_str = str(subdir)
        if subdir_str not in sys.path:
            sys.path.insert(0, subdir_str)
        
        try:
            # Import all Python files in the subdirectory
            for py_file in subdir.glob("*.py"):
                if py_file.name.startswith("_") or py_file.name == "__init__.py":
                    continue
                
                module_name = py_file.stem
                try:
                    importlib.import_module(module_name)
                except Exception as e:
                    # Log but continue - some modules might have issues
                    import sys
                    sys.stderr.write(f"[external] Failed to load {subdir.name}/{py_file.name}: {e}\n")
        except Exception as e:
            import sys
            sys.stderr.write(f"[external] Error scanning {subdir.name}: {e}\n")
        finally:
            # Remove from path to avoid conflicts
            if subdir_str in sys.path:
                sys.path.remove(subdir_str)
