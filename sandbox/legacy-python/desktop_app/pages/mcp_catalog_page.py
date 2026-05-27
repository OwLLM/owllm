"""
MCP Catalog page for browsing and installing servers from the registry.
"""
from __future__ import annotations

import json
import urllib.parse
from typing import Dict, Any, List, Optional

from PySide6.QtCore import Qt, QTimer, QThread, Signal
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QLineEdit, QComboBox, QScrollArea, QMessageBox, QFrame,
    QDialog, QProgressDialog
)

from desktop_app.widgets.server_card import ServerCard
from desktop_app.mcp.registry_client import MCPRegistryClient
from desktop_app.mcp.server_manager import MCPServerManager
from desktop_app.mcp.connection_manager import MCPConnectionManager


class FetchServersThread(QThread):
    """Thread for fetching servers from registry without blocking UI."""
    servers_fetched = Signal(list)
    error = Signal(str)
    
    def __init__(self, client: MCPRegistryClient, category: Optional[str] = None,
                 search: Optional[str] = None, sort: str = "popular"):
        super().__init__()
        self.client = client
        self.category = category
        self.search = search
        self.sort = sort
    
    def run(self):
        try:
            servers = self.client.list_servers(
                category=self.category,
                search=self.search,
                sort=self.sort
            )
            self.servers_fetched.emit(servers)
        except Exception as e:
            self.error.emit(str(e))


class InstallServerThread(QThread):
    """Thread for installing a server without blocking UI."""
    progress = Signal(str)
    finished = Signal(bool, str, Optional[str])
    
    def __init__(self, manager: MCPServerManager, server_data: dict):
        super().__init__()
        self.manager = manager
        self.server_data = server_data
    
    def run(self):
        install_method = self.server_data.get("install_method", "").lower()
        package_name = self.server_data.get("package_name") or self.server_data.get("name", "")
        
        self.progress.emit(f"Installing {package_name} via {install_method}...")
        
        try:
            if install_method == "npm":
                success, message, path = self.manager.install_npm(package_name, global_install=False)
                self.finished.emit(success, message, str(path) if path else None)
            elif install_method == "pip":
                success, message, path = self.manager.install_pip(package_name)
                self.finished.emit(success, message, str(path) if path else None)
            elif install_method == "docker":
                success, message, command = self.manager.install_docker(package_name)
                self.finished.emit(success, message, command)
            elif install_method == "git":
                repo_url = self.server_data.get("repo_url") or self.server_data.get("url", "")
                branch = self.server_data.get("branch")
                success, message, path = self.manager.install_git(repo_url, branch)
                self.finished.emit(success, message, str(path) if path else None)
            else:
                self.finished.emit(False, f"Unknown install method: {install_method}", None)
        except Exception as e:
            self.finished.emit(False, f"Installation error: {str(e)}", None)


class MCPCatalogPage(QWidget):
    """Catalog page for browsing and installing MCP servers."""
    
    def __init__(self, parent=None):
        super().__init__(parent)
        # Defer manager initialization to avoid blocking during page creation
        self.registry_client = None
        self.server_manager = None
        self.connection_manager = None
        self.servers: List[Dict[str, Any]] = []
        self.server_cards: Dict[str, ServerCard] = {}
        self._fetch_thread: Optional[FetchServersThread] = None
        self._install_thread: Optional[InstallServerThread] = None
        self._setup_ui()
        # Defer manager creation to avoid blocking
        QTimer.singleShot(100, self._initialize_managers)
    
    def _initialize_managers(self):
        """Initialize managers after UI is set up."""
        self.registry_client = MCPRegistryClient()
        self.server_manager = MCPServerManager()
        self.connection_manager = MCPConnectionManager()
        # Now safe to refresh
        QTimer.singleShot(400, self._refresh_servers)
    
    def closeEvent(self, event):
        """Clean up threads when page/widget is closed."""
        self._cleanup_threads()
        super().closeEvent(event)
    
    def _cleanup_threads(self):
        """Stop and clean up any running threads."""
        # Clean up fetch thread
        if self._fetch_thread is not None:
            try:
                if self._fetch_thread.isRunning():
                    self._fetch_thread.quit()
                    if not self._fetch_thread.wait(500):
                        self._fetch_thread.terminate()
                        self._fetch_thread.wait(500)
            except RuntimeError:
                pass
            except Exception:
                pass
            finally:
                self._fetch_thread = None
        
        # Clean up install thread
        if self._install_thread is not None:
            try:
                if self._install_thread.isRunning():
                    self._install_thread.quit()
                    if not self._install_thread.wait(500):
                        self._install_thread.terminate()
                        self._install_thread.wait(500)
            except RuntimeError:
                pass
            except Exception:
                pass
            finally:
                self._install_thread = None
    
    def _setup_ui(self):
        """Setup the UI."""
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)
        
        # Title
        title = QLabel("📦 MCP Catalog")
        title.setProperty("class", "page_title")
        layout.addWidget(title)
        
        # Top bar: Search + Category + Sort + Refresh
        top_bar = QHBoxLayout()
        top_bar.setSpacing(8)
        
        search_label = QLabel("Search:")
        search_label.setStyleSheet("color: white;")
        top_bar.addWidget(search_label)
        
        self.search_edit = QLineEdit()
        self.search_edit.setPlaceholderText("Search servers...")
        self.search_edit.textChanged.connect(self._filter_servers)
        top_bar.addWidget(self.search_edit, 1)
        
        category_label = QLabel("Category:")
        category_label.setStyleSheet("color: white;")
        top_bar.addWidget(category_label)
        
        self.category_combo = QComboBox()
        self.category_combo.addItem("All Categories")
        self.category_combo.currentTextChanged.connect(self._on_category_changed)
        top_bar.addWidget(self.category_combo)
        
        sort_label = QLabel("Sort:")
        sort_label.setStyleSheet("color: white;")
        top_bar.addWidget(sort_label)
        
        self.sort_combo = QComboBox()
        self.sort_combo.addItems(["Popular", "Recent"])
        self.sort_combo.currentTextChanged.connect(self._on_sort_changed)
        top_bar.addWidget(self.sort_combo)
        
        self.refresh_btn = QPushButton("🔄 Refresh")
        self.refresh_btn.clicked.connect(self._refresh_servers)
        top_bar.addWidget(self.refresh_btn)
        
        layout.addLayout(top_bar)
        
        # Status banner
        self.status_banner = QFrame()
        self.status_banner.setVisible(False)
        self.status_banner.setStyleSheet("""
            QFrame {
                background: rgba(255, 152, 0, 0.2);
                border: 1px solid rgba(255, 152, 0, 0.6);
                border-radius: 6px;
                padding: 8px;
            }
        """)
        banner_layout = QHBoxLayout(self.status_banner)
        banner_layout.setContentsMargins(8, 8, 8, 8)
        
        self.status_label = QLabel()
        self.status_label.setWordWrap(True)
        self.status_label.setStyleSheet("color: #ffcc80; font-size: 10pt;")
        banner_layout.addWidget(self.status_label, 1)
        
        layout.addWidget(self.status_banner)
        
        # Scroll area for server cards
        self.cards_scroll = QScrollArea()
        self.cards_scroll.setWidgetResizable(True)
        self.cards_scroll.setFrameShape(QFrame.NoFrame)
        self.cards_scroll.setStyleSheet("QScrollArea { border: none; background: transparent; }")
        
        self.cards_widget = QWidget()
        self.cards_layout = QVBoxLayout(self.cards_widget)
        self.cards_layout.setSpacing(12)
        self.cards_layout.setContentsMargins(0, 0, 0, 0)
        
        self.cards_scroll.setWidget(self.cards_widget)
        layout.addWidget(self.cards_scroll, 1)
    
    def _show_status(self, message: str):
        """Show status message."""
        self.status_label.setText(message)
        self.status_banner.setVisible(True)
    
    def _hide_status(self):
        """Hide status message."""
        self.status_banner.setVisible(False)
    
    def _show_help_message(self):
        """Show help message about what should appear in the catalog."""
        # This would show example server cards or instructions
        # For now, the error message already explains the situation
        pass
    
    def _refresh_servers(self):
        """Fetch servers from registry."""
        # Prevent rapid clicking
        if not self.refresh_btn.isEnabled():
            return  # Already refreshing
        
        # Ensure managers are initialized
        if self.registry_client is None:
            QTimer.singleShot(100, self._refresh_servers)
            return
        
        try:
            self._hide_status()
            self.refresh_btn.setEnabled(False)
            
            category = self.category_combo.currentText()
            if category == "All Categories":
                category = None
            
            search = self.search_edit.text().strip() or None
            sort = self.sort_combo.currentText().lower()
            
            # Cancel previous fetch if running
            if self._fetch_thread is not None:
                try:
                    if self._fetch_thread.isRunning():
                        self._fetch_thread.quit()
                        if not self._fetch_thread.wait(300):
                            self._fetch_thread.terminate()
                            self._fetch_thread.wait(200)
                except (RuntimeError, Exception):
                    pass
                finally:
                    self._fetch_thread = None
            
            self._fetch_thread = FetchServersThread(
                self.registry_client,
                category=category,
                search=search,
                sort=sort
            )
            self._fetch_thread.servers_fetched.connect(self._on_servers_fetched)
            self._fetch_thread.error.connect(self._on_fetch_error)
            self._fetch_thread.finished.connect(lambda: self.refresh_btn.setEnabled(True))
            self._fetch_thread.finished.connect(self._fetch_thread.deleteLater)
            self._fetch_thread.start()
        except Exception as e:
            self._show_status(f"Error refreshing servers: {str(e)}")
            self.refresh_btn.setEnabled(True)
    
    def _on_servers_fetched(self, servers: List[Dict[str, Any]]):
        """Handle servers fetched from registry."""
        self.servers = servers
        self._update_server_cards()
        self._hide_status()
    
    def _on_fetch_error(self, error: str):
        """Handle fetch error."""
        # Show helpful error message
        error_msg = f"Error fetching servers: {error}"
        if "404" in error or "not available" in error.lower():
            error_msg += "\n\nNote: The MCP registry API may not be publicly available yet. "
            error_msg += "You can manually add servers in the Connections tab by configuring them directly."
        self._show_status(error_msg)
        self.servers = []
        self._update_server_cards()
        
        # Show a helpful message about what should appear
        if not self.servers:
            self._show_help_message()
    
    def _on_category_changed(self):
        """Handle category filter change."""
        self._refresh_servers()
    
    def _on_sort_changed(self):
        """Handle sort change."""
        self._refresh_servers()
    
    def _filter_servers(self):
        """Filter servers by search text."""
        search_text = self.search_edit.text().lower()
        
        for server_id, card in self.server_cards.items():
            server_data = card.server_data
            matches = (
                not search_text or
                search_text in server_data.get("name", "").lower() or
                search_text in server_data.get("description", "").lower() or
                search_text in " ".join(server_data.get("categories", [])).lower()
            )
            card.setVisible(matches)
    
    def _update_server_cards(self):
        """Update the server cards display."""
        # Clear existing cards
        for card in self.server_cards.values():
            card.setParent(None)
        self.server_cards.clear()
        
        # Update category filter
        categories = {"All Categories"}
        for server in self.servers:
            server_cats = server.get("categories", []) or server.get("tags", [])
            categories.update(server_cats)
        
        current_category = self.category_combo.currentText()
        self.category_combo.clear()
        self.category_combo.addItems(sorted(categories))
        if current_category in categories:
            self.category_combo.setCurrentText(current_category)
        
        # Create cards
        for server in self.servers:
            server_id = server.get("id") or server.get("name", "")
            card = ServerCard(server, self)
            card.install_clicked.connect(self._on_install_clicked)
            self.server_cards[server_id] = card
            self.cards_layout.addWidget(card)
        
        self.cards_layout.addStretch()
        self._filter_servers()
    
    def _on_install_clicked(self, server_id: str):
        """Handle install button click."""
        # Ensure managers are initialized
        if self.server_manager is None or self.connection_manager is None:
            QMessageBox.warning(self, "Error", "Managers not initialized. Please wait a moment and try again.")
            return
        
        server_data = next((s for s in self.servers if (s.get("id") or s.get("name", "")) == server_id), None)
        if not server_data:
            QMessageBox.warning(self, "Error", f"Server '{server_id}' not found")
            return
        
        # Show confirmation dialog
        install_method = server_data.get("install_method", "unknown")
        package_name = server_data.get("package_name") or server_data.get("name", "")
        
        msg = (
            f"Install {server_data.get('name', server_id)}?\n\n"
            f"Method: {install_method}\n"
            f"Package: {package_name}\n\n"
            f"This will download and install the server. Continue?"
        )
        
        reply = QMessageBox.question(
            self,
            "Confirm Installation",
            msg,
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No
        )
        
        if reply != QMessageBox.Yes:
            return
        
        # Show progress dialog
        progress = QProgressDialog(f"Installing {package_name}...", "Cancel", 0, 0, self)
        progress.setWindowModality(Qt.WindowModal)
        progress.setCancelButton(None)  # Can't cancel during install
        progress.show()
        
        # Start installation thread
        self._install_thread = InstallServerThread(self.server_manager, server_data)
        self._install_thread.progress.connect(progress.setLabelText)
        
        def on_finished(success: bool, message: str, install_path: Optional[str]):
            progress.close()
            if success:
                # Add to connection manager
                server_name = server_data.get("name", server_id)
                self.connection_manager.add_server(
                    server_id=server_id,
                    install_method=install_method,
                    install_path=install_path,
                    config={"url": "http://127.0.0.1:8000", "name": server_name}  # Default URL
                )
                QMessageBox.information(self, "Installation Complete", message)
                
                # Notify Connections page to refresh
                parent = self.parent()
                while parent:
                    if hasattr(parent, 'get_connections_page'):
                        connections_page = parent.get_connections_page()
                        if connections_page:
                            QTimer.singleShot(100, connections_page._refresh_connections)
                        break
                    elif hasattr(parent, 'connections_page'):
                        QTimer.singleShot(100, parent.connections_page._refresh_connections)
                        break
                    parent = parent.parent() if hasattr(parent, 'parent') else None
            else:
                QMessageBox.warning(self, "Installation Failed", message)
        
        self._install_thread.finished.connect(on_finished)
        self._install_thread.start()
