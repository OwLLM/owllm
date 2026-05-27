"""
MCP Registry API client for fetching server listings.
"""
from __future__ import annotations

import json
import urllib.request
import urllib.error
import urllib.parse
from typing import Dict, Any, List, Optional


class MCPRegistryClient:
    """Client for the MCP Registry API."""
    
    BASE_URL = "https://registry.modelcontextprotocol.io"
    
    def __init__(self):
        self._cache: Optional[List[Dict[str, Any]]] = None
    
    def list_servers(
        self,
        category: Optional[str] = None,
        search: Optional[str] = None,
        sort: str = "popular"
    ) -> List[Dict[str, Any]]:
        """
        Fetch list of MCP servers from the registry.
        
        Args:
            category: Filter by category/tag
            search: Search query string
            sort: Sort order ("popular" or "recent")
            
        Returns:
            List of server metadata dictionaries
        """
        try:
            # Build query parameters
            params = []
            if category:
                params.append(f"category={urllib.parse.quote(category)}")
            if search:
                params.append(f"search={urllib.parse.quote(search)}")
            if sort:
                params.append(f"sort={urllib.parse.quote(sort)}")
            
            query_string = "&".join(params)
            url = f"{self.BASE_URL}/servers"
            if query_string:
                url += f"?{query_string}"
            
            req = urllib.request.Request(
                url,
                headers={"Accept": "application/json"},
                method="GET"
            )
            
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.loads(r.read().decode("utf-8"))
            
            # Handle different possible response formats
            if isinstance(data, list):
                return data
            elif isinstance(data, dict):
                # Could be {"servers": [...]} or {"items": [...]} or {"data": [...]}
                return data.get("servers", data.get("items", data.get("data", [])))
            else:
                return []
                
        except urllib.error.HTTPError as e:
            if e.code == 404:
                # Registry endpoint not found - return empty list with helpful message
                raise ConnectionError(f"MCP registry not available at {self.BASE_URL}/servers. The registry API may not be publicly available yet.")
            raise ConnectionError(f"HTTP error {e.code}: {e.reason}")
        except urllib.error.URLError as e:
            raise ConnectionError(f"Failed to connect to MCP registry: {e}")
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid JSON response from registry: {e}")
        except Exception as e:
            raise RuntimeError(f"Error fetching servers: {e}")
    
    def get_server(self, server_id: str) -> Dict[str, Any]:
        """
        Get detailed information about a specific server.
        
        Args:
            server_id: Server identifier (package name, repo URL, etc.)
            
        Returns:
            Server metadata dictionary with detailed information
        """
        try:
            url = f"{self.BASE_URL}/servers/{urllib.parse.quote(server_id)}"
            
            req = urllib.request.Request(
                url,
                headers={"Accept": "application/json"},
                method="GET"
            )
            
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.loads(r.read().decode("utf-8"))
            
            return data if isinstance(data, dict) else {}
            
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise ValueError(f"Server '{server_id}' not found in registry")
            raise ConnectionError(f"HTTP error {e.code}: {e.reason}")
        except urllib.error.URLError as e:
            raise ConnectionError(f"Failed to connect to MCP registry: {e}")
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid JSON response from registry: {e}")
        except Exception as e:
            raise RuntimeError(f"Error fetching server details: {e}")
