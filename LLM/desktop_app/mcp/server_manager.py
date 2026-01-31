"""
MCP Server Manager for installing and managing MCP servers.
"""
from __future__ import annotations

import json
import subprocess
import shutil
from pathlib import Path
from typing import Dict, Any, Optional, Tuple
import platform


class MCPServerManager:
    """Manages installation and lifecycle of MCP servers."""
    
    def __init__(self, servers_dir: Optional[Path] = None):
        if servers_dir is None:
            # Default to LLM/desktop_app/mcp_servers
            base_dir = Path(__file__).parent.parent
            servers_dir = base_dir / "mcp_servers"
        self.servers_dir = Path(servers_dir)
        
        # Windows subprocess flags
        self.subprocess_flags = {}
        if platform.system().lower() == 'windows':
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = subprocess.SW_HIDE
            self.subprocess_flags = {
                'startupinfo': startupinfo,
                'creationflags': subprocess.CREATE_NO_WINDOW
            }
        
        # Create directories with error handling to avoid blocking
        try:
            self.servers_dir.mkdir(parents=True, exist_ok=True)
        except (OSError, PermissionError):
            pass  # Non-critical, operations will fail later if needed
        
        # Create subdirectories with timeout protection
        for subdir in ["npm", "pip", "git", "docker"]:
            try:
                (self.servers_dir / subdir).mkdir(exist_ok=True)
            except (OSError, PermissionError):
                pass  # Non-critical, continue
    
    def install_npm(
        self,
        package_name: str,
        global_install: bool = False
    ) -> Tuple[bool, str, Optional[Path]]:
        """
        Install an npm package (MCP server).
        
        Args:
            package_name: npm package name (e.g., "@modelcontextprotocol/server-filesystem")
            global_install: If True, install globally; if False, install in managed folder
            
        Returns:
            Tuple of (success, message, install_path)
        """
        try:
            if global_install:
                # Global install
                result = subprocess.run(
                    ["npm", "install", "-g", package_name],
                    capture_output=True,
                    text=True,
                    timeout=300,
                    **self.subprocess_flags
                )
                if result.returncode == 0:
                    # Find global install location
                    which_result = subprocess.run(
                        ["npm", "list", "-g", package_name, "--depth=0"],
                        capture_output=True,
                        text=True,
                        **self.subprocess_flags
                    )
                    install_path = None  # Global installs don't have a local path
                    return True, f"Successfully installed {package_name} globally", install_path
                else:
                    return False, f"npm install failed: {result.stderr}", None
            else:
                # Local install in managed folder
                install_dir = self.servers_dir / "npm" / package_name.replace("/", "_")
                install_dir.mkdir(parents=True, exist_ok=True)
                
                # Create package.json if it doesn't exist
                package_json = install_dir / "package.json"
                if not package_json.exists():
                    package_json.write_text(json.dumps({
                        "name": package_name.replace("/", "_"),
                        "version": "1.0.0",
                        "private": True
                    }, indent=2))
                
                result = subprocess.run(
                    ["npm", "install", package_name],
                    cwd=install_dir,
                    capture_output=True,
                    text=True,
                    timeout=300,
                    **self.subprocess_flags
                )
                
                if result.returncode == 0:
                    return True, f"Successfully installed {package_name}", install_dir
                else:
                    return False, f"npm install failed: {result.stderr}", None
                
        except subprocess.TimeoutExpired:
            return False, "Installation timed out after 5 minutes", None
        except FileNotFoundError:
            return False, "npm not found. Please install Node.js and npm.", None
        except Exception as e:
            return False, f"Installation error: {str(e)}", None
    
    def install_pip(
        self,
        package_name: str,
        venv_path: Optional[Path] = None
    ) -> Tuple[bool, str, Optional[Path]]:
        """
        Install a pip package (MCP server) in a virtual environment.
        
        Args:
            package_name: pip package name (e.g., "mcp-server-python")
            venv_path: Path to virtual environment (creates new one if None)
            
        Returns:
            Tuple of (success, message, venv_path)
        """
        try:
            if venv_path is None:
                # Create new venv
                venv_path = self.servers_dir / "pip" / package_name.replace("-", "_")
                venv_path.mkdir(parents=True, exist_ok=True)
            
            venv_path = Path(venv_path)
            
            # Check if venv exists, create if not
            if platform.system() == "Windows":
                python_exe = venv_path / "Scripts" / "python.exe"
                pip_exe = venv_path / "Scripts" / "pip.exe"
            else:
                python_exe = venv_path / "bin" / "python"
                pip_exe = venv_path / "bin" / "pip"
            
            if not python_exe.exists():
                # Create venv
                result = subprocess.run(
                    [shutil.which("python") or shutil.which("python3"), "-m", "venv", str(venv_path)],
                    capture_output=True,
                    text=True,
                    timeout=60,
                    **self.subprocess_flags
                )
                if result.returncode != 0:
                    return False, f"Failed to create virtual environment: {result.stderr}", None
            
            # Install package
            result = subprocess.run(
                [str(pip_exe), "install", package_name],
                capture_output=True,
                text=True,
                timeout=300,
                **self.subprocess_flags
            )
            
            if result.returncode == 0:
                return True, f"Successfully installed {package_name}", venv_path
            else:
                return False, f"pip install failed: {result.stderr}", None
                
        except subprocess.TimeoutExpired:
            return False, "Installation timed out after 5 minutes", None
        except FileNotFoundError:
            return False, "Python not found. Please install Python.", None
        except Exception as e:
            return False, f"Installation error: {str(e)}", None
    
    def install_docker(self, image_name: str) -> Tuple[bool, str, str]:
        """
        Get Docker run command for a Docker image.
        Does not actually run Docker (user must execute manually).
        
        Args:
            image_name: Docker image name
            
        Returns:
            Tuple of (success, message, docker_command)
        """
        # Generate a typical MCP server docker run command
        # User will need to customize port, env vars, etc.
        docker_command = (
            f"docker run -d --name mcp-{image_name.replace('/', '-')} "
            f"-p 8000:8000 "
            f"{image_name}"
        )
        
        message = (
            f"Docker command generated for {image_name}.\n\n"
            f"Command:\n{docker_command}\n\n"
            f"Please customize the port and environment variables as needed, "
            f"then run the command manually."
        )
        
        return True, message, docker_command
    
    def install_git(
        self,
        repo_url: str,
        branch: Optional[str] = None
    ) -> Tuple[bool, str, Optional[Path]]:
        """
        Clone a git repository (MCP server).
        
        Args:
            repo_url: Git repository URL
            branch: Branch or tag to checkout (optional)
            
        Returns:
            Tuple of (success, message, clone_path)
        """
        try:
            # Extract repo name from URL
            repo_name = repo_url.split("/")[-1].replace(".git", "")
            clone_path = self.servers_dir / "git" / repo_name
            clone_path.mkdir(parents=True, exist_ok=True)
            
            # Check if already cloned
            if (clone_path / ".git").exists():
                # Update existing clone
                result = subprocess.run(
                    ["git", "pull"],
                    cwd=clone_path,
                    capture_output=True,
                    text=True,
                    timeout=120,
                    **self.subprocess_flags
                )
                if result.returncode != 0:
                    return False, f"git pull failed: {result.stderr}", None
            else:
                # Clone repository
                cmd = ["git", "clone", repo_url, str(clone_path)]
                if branch:
                    cmd.extend(["-b", branch])
                
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=300,
                    **self.subprocess_flags
                )
                
                if result.returncode != 0:
                    return False, f"git clone failed: {result.stderr}", None
            
            # Checkout specific branch if provided and not already done
            if branch and (clone_path / ".git").exists():
                result = subprocess.run(
                    ["git", "checkout", branch],
                    cwd=clone_path,
                    capture_output=True,
                    text=True,
                    **self.subprocess_flags
                )
                # Non-fatal if branch doesn't exist
            
            return True, f"Successfully cloned {repo_url}", clone_path
            
        except subprocess.TimeoutExpired:
            return False, "Clone timed out after 5 minutes", None
        except FileNotFoundError:
            return False, "git not found. Please install Git.", None
        except Exception as e:
            return False, f"Clone error: {str(e)}", None
    
    def get_server_command(
        self,
        server_id: str,
        install_method: str,
        install_path: Optional[Path]
    ) -> Optional[str]:
        """
        Get the command to run a server based on its installation method.
        
        Args:
            server_id: Server identifier
            install_method: "npm", "pip", "git", or "docker"
            install_path: Path where server is installed
            
        Returns:
            Command string to run the server, or None if not applicable
        """
        if install_method == "npm":
            if install_path:
                # Local install
                if platform.system() == "Windows":
                    node_modules = install_path / "node_modules"
                else:
                    node_modules = install_path / "node_modules"
                # Try to find the server executable
                # This is a simplified version - actual implementation would need
                # to read package.json to find the main entry point
                # Try to find package.json to get the main entry point
                package_json = install_path / "package.json"
                if package_json.exists():
                    try:
                        with open(package_json, 'r') as f:
                            pkg_data = json.load(f)
                            main_script = pkg_data.get("main", "index.js")
                            return f'node "{install_path / main_script}"'
                    except:
                        pass
                # Fallback to common structure
                fallback_path = node_modules / server_id.replace("/", "_") / "index.js"
                return f'node "{fallback_path}"'
            else:
                # Global install
                return f"npx {server_id}"
        
        elif install_method == "pip":
            if install_path:
                if platform.system() == "Windows":
                    python_exe = install_path / "Scripts" / "python.exe"
                else:
                    python_exe = install_path / "bin" / "python"
                # Try common MCP server entry points
                return f'"{python_exe}" -m {server_id.replace("-", "_")}'
            else:
                return f"python -m {server_id.replace('-', '_')}"
        
        elif install_method == "git":
            if install_path:
                # Look for common entry points
                if (install_path / "main.py").exists():
                    return f'python "{install_path / "main.py"}"'
                elif (install_path / "server.py").exists():
                    return f'python "{install_path / "server.py"}"'
                elif (install_path / "index.js").exists():
                    return f'node "{install_path / "index.js"}"'
            return None
        
        elif install_method == "docker":
            return f"docker run {server_id}"
        
        return None
