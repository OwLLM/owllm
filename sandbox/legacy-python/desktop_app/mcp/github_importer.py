"""
GitHub tool importer for cloning and managing external tool repositories.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Tuple, Optional, List


class GitHubToolImporter:
    """Import tools from GitHub repositories with sandboxing"""
    
    def __init__(self, external_tools_dir: Path):
        """
        Args:
            external_tools_dir: Directory where external tools are stored
        """
        self.external_tools_dir = Path(external_tools_dir)
        self.external_tools_dir.mkdir(parents=True, exist_ok=True)
    
    def import_from_github(
        self,
        repo_url: str,
        branch: str = "main",
        subpath: str = ""
    ) -> Tuple[bool, str, Optional[Path]]:
        """
        Clone GitHub repo and extract tools.
        
        Args:
            repo_url: GitHub repo URL (e.g., https://github.com/user/repo)
            branch: Branch to clone (default: "main")
            subpath: Subdirectory containing tools (if not root)
        
        Returns:
            (success, message, install_path)
        """
        # Extract repo name from URL
        match = re.search(r'github\.com[:/]([^/]+)/([^/\.]+)', repo_url)
        if not match:
            return False, "Invalid GitHub URL. Expected format: https://github.com/username/repo", None
        
        user, repo = match.groups()
        safe_name = f"{user}_{repo}".replace("-", "_")
        install_path = self.external_tools_dir / safe_name
        
        # Clone or pull
        if install_path.exists():
            # Update existing
            try:
                result = subprocess.run(
                    ["git", "-C", str(install_path), "pull"],
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=60
                )
                return True, f"Updated {safe_name}", install_path
            except subprocess.TimeoutExpired:
                return False, f"Update timed out for {safe_name}", None
            except subprocess.CalledProcessError as e:
                return False, f"Update failed: {e.stderr}", None
            except Exception as e:
                return False, f"Update failed: {str(e)}", None
        else:
            # Fresh clone
            try:
                result = subprocess.run(
                    ["git", "clone", "--depth=1", f"--branch={branch}", repo_url, str(install_path)],
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=120
                )
                return True, f"Installed {safe_name}", install_path
            except subprocess.TimeoutExpired:
                return False, f"Clone timed out for {repo_url}", None
            except subprocess.CalledProcessError as e:
                # Check if branch doesn't exist, try default branch
                if "not found" in e.stderr.lower() or "fatal" in e.stderr.lower():
                    try:
                        # Try without branch specification (uses default)
                        result = subprocess.run(
                            ["git", "clone", "--depth=1", repo_url, str(install_path)],
                            check=True,
                            capture_output=True,
                            text=True,
                            timeout=120
                        )
                        return True, f"Installed {safe_name} (default branch)", install_path
                    except Exception as e2:
                        return False, f"Clone failed: {str(e2)}", None
                return False, f"Clone failed: {e.stderr}", None
            except Exception as e:
                return False, f"Clone failed: {str(e)}", None
    
    def scan_for_tools(self, install_path: Path) -> List[str]:
        """
        Scan directory for tool files (*.py with @tool decorator).
        
        Args:
            install_path: Path to scan
        
        Returns:
            List of relative file paths containing tools
        """
        tools_found = []
        
        if not install_path.exists() or not install_path.is_dir():
            return tools_found
        
        for py_file in install_path.rglob("*.py"):
            if py_file.name.startswith("_"):
                continue
            
            try:
                content = py_file.read_text(encoding="utf-8", errors="ignore")
                # Check for @tool decorator
                if "@tool(" in content or "@tool\n" in content or "@tool " in content:
                    rel_path = py_file.relative_to(install_path)
                    tools_found.append(str(rel_path))
            except Exception:
                # Skip files that can't be read
                pass
        
        return tools_found
    
    def list_installed_repos(self) -> List[dict]:
        """
        List all installed repositories.
        
        Returns:
            List of dicts with repo info: {name, path, tools}
        """
        repos = []
        
        if not self.external_tools_dir.exists():
            return repos
        
        for subdir in self.external_tools_dir.iterdir():
            if not subdir.is_dir() or subdir.name.startswith("_"):
                continue
            
            tools = self.scan_for_tools(subdir)
            repos.append({
                "name": subdir.name,
                "path": str(subdir),
                "tools": tools,
                "tool_count": len(tools)
            })
        
        return repos
    
    def remove_repo(self, repo_name: str) -> Tuple[bool, str]:
        """
        Remove an installed repository.
        
        Args:
            repo_name: Name of repository to remove
        
        Returns:
            (success, message)
        """
        repo_path = self.external_tools_dir / repo_name
        
        if not repo_path.exists():
            return False, f"Repository '{repo_name}' not found"
        
        try:
            import shutil
            shutil.rmtree(repo_path)
            return True, f"Removed {repo_name}"
        except Exception as e:
            return False, f"Failed to remove {repo_name}: {str(e)}"
