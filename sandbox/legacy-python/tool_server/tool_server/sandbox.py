"""
Sandbox for external tool execution.

Provides restricted execution environment and validation for external tools
to prevent dangerous operations.
"""
from __future__ import annotations

from typing import Tuple, Dict, Any


class ToolSandbox:
    """Sandbox for external tool execution"""
    
    # Allowed built-ins for external tools (safe operations only)
    SAFE_BUILTINS = {
        'abs', 'all', 'any', 'bool', 'dict', 'enumerate',
        'filter', 'float', 'int', 'len', 'list', 'map',
        'max', 'min', 'range', 'reversed', 'set', 'sorted',
        'str', 'sum', 'tuple', 'zip', 'Exception', 'ValueError',
        'TypeError', 'KeyError', 'IndexError', 'AttributeError',
        'isinstance', 'type', 'hasattr', 'getattr', 'setattr',
        'round', 'divmod', 'pow', 'hex', 'oct', 'bin', 'ord', 'chr',
        'ascii', 'repr', 'format',
    }
    
    # Dangerous patterns that should be rejected
    DANGEROUS_PATTERNS = [
        "eval(",
        "exec(",
        "compile(",
        "__import__",
        "open(",  # File access should go through tool context
        "subprocess",
        "os.system",
        "os.popen",
        "os.exec",
        "pickle",
        "marshal",
        "imp.",
        "importlib.import_module",
        "__builtins__",
        "__globals__",
        "__locals__",
        "globals()",
        "locals()",
    ]
    
    @staticmethod
    def create_restricted_globals() -> Dict[str, Any]:
        """
        Create restricted global namespace for external tool execution.
        
        Returns:
            Dictionary with restricted builtins
        """
        restricted = {"__builtins__": {}}
        
        # Add only safe builtins
        import builtins
        for name in ToolSandbox.SAFE_BUILTINS:
            if hasattr(builtins, name):
                restricted["__builtins__"][name] = getattr(builtins, name)
        
        return restricted
    
    @staticmethod
    def validate_tool_code(code: str) -> Tuple[bool, str]:
        """
        Check for dangerous patterns in tool code.
        
        Args:
            code: Source code to validate
        
        Returns:
            (is_safe, error_message)
        """
        if not isinstance(code, str):
            return False, "Code must be a string"
        
        # Normalize whitespace for pattern matching
        normalized = code.replace(" ", "").replace("\t", "").replace("\n", "")
        
        for pattern in ToolSandbox.DANGEROUS_PATTERNS:
            # Check both original and normalized code
            if pattern in code or pattern in normalized:
                return False, f"Dangerous pattern detected: {pattern}"
        
        return True, "OK"
    
    @staticmethod
    def validate_imports(imports: list) -> Tuple[bool, str]:
        """
        Validate that only safe imports are used.
        
        Args:
            imports: List of import statements
        
        Returns:
            (is_safe, error_message)
        """
        # Safe standard library modules (read-only or safe operations)
        safe_modules = {
            'json', 'csv', 'datetime', 'time', 'calendar',
            'math', 'statistics', 'random', 'secrets',
            'string', 'textwrap', 're', 'collections',
            'itertools', 'functools', 'operator', 'pathlib',
            'urllib.parse', 'base64', 'hashlib', 'hmac',
        }
        
        # Dangerous modules
        dangerous_modules = {
            'subprocess', 'os', 'sys', 'shutil', 'pickle',
            'marshal', 'ctypes', 'multiprocessing', 'threading',
            'socket', 'ssl', 'http', 'urllib.request', 'urllib.error',
        }
        
        for imp in imports:
            module_name = imp.split('.')[0].split()[1] if ' ' in imp else imp.split('.')[0]
            
            if module_name in dangerous_modules:
                return False, f"Dangerous module import: {module_name}"
            
            # Allow safe modules
            if module_name in safe_modules:
                continue
            
            # Unknown modules - be conservative
            if module_name not in safe_modules:
                return False, f"Unknown module import: {module_name} (not in safe list)"
        
        return True, "OK"
