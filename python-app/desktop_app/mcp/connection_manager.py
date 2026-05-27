"""
MCP Connection Manager for managing connections to multiple MCP servers.
"""
from __future__ import annotations

import json
import urllib.request
import urllib.error
from typing import Dict, Any, List, Optional, Tuple
from pathlib import Path


class MCPConnectionManager:
    """Manages connections to multiple MCP servers and aggregates their tools."""
    
    def __init__(self, config_path: Optional[Path] = None):
        if config_path is None:
            base_dir = Path(__file__).parent.parent
            config_path = base_dir / "config" / "mcp_connections.json"
        self.config_path = Path(config_path)
        
        # Create config directory with error handling to avoid blocking
        try:
            self.config_path.parent.mkdir(parents=True, exist_ok=True)
        except (OSError, PermissionError):
            pass  # Non-critical, operations will fail later if needed
        
        self.connections: Dict[str, Dict[str, Any]] = {}
        self._load_config()
    
    def _load_config(self):
        """Load connection configuration from file."""
        if not self.config_path.exists():
            self.connections = {}
            return
        
        try:
            with open(self.config_path, "r", encoding="utf-8") as f:
                config = json.load(f)
                self.connections = config.get("servers", {})
        except (IOError, json.JSONDecodeError, PermissionError):
            # Non-critical - start with empty config
            self.connections = {}
    
    def _save_config(self):
        """Save connection configuration to file."""
        try:
            config = {"servers": self.connections}
            with open(self.config_path, "w", encoding="utf-8") as f:
                json.dump(config, f, indent=2, ensure_ascii=False)
        except Exception as e:
            raise IOError(f"Failed to save MCP connections config: {e}")
    
    def add_server(
        self,
        server_id: str,
        install_method: str,
        install_path: Optional[str] = None,
        config: Optional[Dict[str, Any]] = None
    ):
        """Add or update a server configuration."""
        if server_id not in self.connections:
            server_name = (config or {}).get("name", server_id)
            self.connections[server_id] = {
                "name": server_name,
                "installed": True,
                "install_method": install_method,
                "install_path": install_path,
                "config": config or {},
                "status": "installed"
            }
        else:
            self.connections[server_id]["install_method"] = install_method
            if install_path:
                self.connections[server_id]["install_path"] = install_path
            if config:
                self.connections[server_id]["config"].update(config)
                if "name" in config:
                    self.connections[server_id]["name"] = config["name"]
        
        self._save_config()
    
    def update_server_status(self, server_id: str, status: str):
        """Update server status."""
        if server_id in self.connections:
            self.connections[server_id]["status"] = status
            self._save_config()
    
    def update_server_config(self, server_id: str, config: Dict[str, Any]):
        """Update server configuration."""
        if server_id in self.connections:
            self.connections[server_id]["config"].update(config)
            self._save_config()
    
    def remove_server(self, server_id: str):
        """Remove a server from configuration."""
        if server_id in self.connections:
            del self.connections[server_id]
            self._save_config()
    
    def get_server(self, server_id: str) -> Optional[Dict[str, Any]]:
        """Get server configuration."""
        return self.connections.get(server_id)
    
    def list_servers(self) -> List[Dict[str, Any]]:
        """List all configured servers."""
        return [
            {**server_data, "server_id": server_id}
            for server_id, server_data in self.connections.items()
        ]
    
    def connect(self, server_id: str) -> Tuple[bool, str, Optional[List[Dict[str, Any]]]]:
        """Connect to an MCP server and fetch its tools."""
        server = self.connections.get(server_id)
        if not server:
            return False, f"Server '{server_id}' not found", None
        
        config = server.get("config", {})
        url = config.get("url", "http://127.0.0.1:8000")
        # Normalize 0.0.0.0 to 127.0.0.1 for connections
        if "0.0.0.0" in url:
            url = url.replace("0.0.0.0", "127.0.0.1")
        auth_token = config.get("auth_token")
        
        try:
            headers = {"Accept": "application/json"}
            if auth_token:
                headers["X-Auth-Token"] = auth_token
            
            req = urllib.request.Request(
                f"{url}/tools",
                headers=headers,
                method="GET"
            )
            
            with urllib.request.urlopen(req, timeout=5) as r:
                data = json.loads(r.read().decode("utf-8"))
            
            tools = data.get("tools", [])
            for tool in tools:
                tool["source_server"] = server_id
                tool["source_server_url"] = url
            
            self.update_server_status(server_id, "connected")
            return True, f"Connected to {server_id}", tools
            
        except urllib.error.HTTPError as e:
            if e.code == 401:
                return False, "Authentication failed. Check your token matches the server token.", None
            elif e.code == 404:
                return False, f"Endpoint not found. Server may not support MCP protocol. (HTTP {e.code})", None
            return False, f"HTTP error {e.code}: {e.reason}", None
        except urllib.error.URLError as e:
            error_msg = str(e)
            if "Connection refused" in error_msg or "No connection could be made" in error_msg:
                return False, f"Connection refused. Is the server running at {url}? Check the port number.", None
            return False, f"Connection failed: {error_msg}", None
        except Exception as e:
            return False, f"Error connecting: {str(e)}", None
    
    def disconnect(self, server_id: str):
        """Disconnect from a server."""
        if server_id in self.connections:
            if self.connections[server_id].get("status") == "connected":
                self.update_server_status(server_id, "running")
    
    def get_all_tools(self) -> List[Dict[str, Any]]:
        """Aggregate tools from all connected servers."""
        all_tools = []
        import sys
        
        # Debug: show what servers we're checking
        connected_servers = [sid for sid, data in self.connections.items() if data.get("status") == "connected"]
        print(f"[MCP] get_all_tools: Checking {len(connected_servers)} connected server(s): {connected_servers}", file=sys.stderr, flush=True)
        
        if not connected_servers:
            print("[MCP] get_all_tools: No servers with 'connected' status found", file=sys.stderr, flush=True)
            # Show all server statuses for debugging
            for server_id, server_data in self.connections.items():
                status = server_data.get("status", "unknown")
                print(f"[MCP] Server '{server_id}': status='{status}'", file=sys.stderr, flush=True)
        
        for server_id, server_data in self.connections.items():
            if server_data.get("status") == "connected":
                config = server_data.get("config", {})
                url = config.get("url", "http://127.0.0.1:8000")
                # Normalize 0.0.0.0 to 127.0.0.1 for connections
                if "0.0.0.0" in url:
                    url = url.replace("0.0.0.0", "127.0.0.1")
                auth_token = config.get("auth_token")
                
                try:
                    print(f"[MCP] Fetching tools from {server_id} at {url}", file=sys.stderr, flush=True)
                    headers = {"Accept": "application/json"}
                    if auth_token:
                        headers["X-Auth-Token"] = auth_token
                    
                    req = urllib.request.Request(
                        f"{url}/tools",
                        headers=headers,
                        method="GET"
                    )
                    
                    with urllib.request.urlopen(req, timeout=5) as r:
                        data = json.loads(r.read().decode("utf-8"))
                    
                    tools = data.get("tools", [])
                    print(f"[MCP] Got {len(tools)} tools from {server_id}", file=sys.stderr, flush=True)
                    for tool in tools:
                        tool["source_server"] = server_id
                        tool["source_server_url"] = url
                    all_tools.extend(tools)
                except urllib.error.URLError as e:
                    # Handle connection refused specifically for local server
                    if "10061" in str(e) or "Connection refused" in str(e):
                        if "127.0.0.1" in url or "localhost" in url:
                            print(f"[MCP] Local server '{server_id}' is not running (Connection Refused). Start it in the 'Server' tab.", file=sys.stderr, flush=True)
                        else:
                            print(f"[MCP] Connection refused for server '{server_id}' at {url}. Is the server running?", file=sys.stderr, flush=True)
                    else:
                        print(f"[MCP] Network error fetching tools from {server_id} at {url}: {e}", file=sys.stderr, flush=True)
                except Exception as e:
                    # Log error but continue with other servers
                    print(f"[MCP] Error fetching tools from {server_id} at {url}: {e}", file=sys.stderr, flush=True)
                    import traceback
                    print(traceback.format_exc(), file=sys.stderr, flush=True)
                    pass
        
        print(f"[MCP] get_all_tools: Returning {len(all_tools)} total tools", file=sys.stderr, flush=True)
        return all_tools
