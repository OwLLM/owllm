"""
MCP Connections page for managing installed servers.
"""
from __future__ import annotations

import json
import shlex
from pathlib import Path
from typing import Dict, Any, List, Optional

from PySide6.QtCore import Qt, QTimer, QProcess
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QScrollArea, QMessageBox, QFrame, QDialog, QLineEdit,
    QTextEdit
)

from desktop_app.widgets.connection_card import ConnectionCard
from desktop_app.mcp.connection_manager import MCPConnectionManager
from desktop_app.mcp.server_manager import MCPServerManager
from desktop_app.pages.server_page import ServerPage
from desktop_app.process_utils import apply_create_no_window


class ConfigureServerDialog(QDialog):
    """Dialog for configuring a server (env vars, secrets, URL, auth)."""
    
    def __init__(self, server_data: dict, parent=None):
        super().__init__(parent)
        self.server_data = server_data
        self.config = server_data.get("config", {}).copy()
        self._setup_ui()
    
    def _setup_ui(self):
        """Setup the dialog UI."""
        self.setWindowTitle(f"Configure: {self.server_data.get('name', 'Server')}")
        self.setMinimumSize(500, 400)
        
        layout = QVBoxLayout(self)
        layout.setSpacing(12)
        layout.setContentsMargins(16, 16, 16, 16)
        
        # URL
        url_label = QLabel("Server URL:")
        url_label.setStyleSheet("color: white;")
        layout.addWidget(url_label)
        
        self.url_edit = QLineEdit()
        self.url_edit.setText(self.config.get("url", "http://127.0.0.1:8000"))
        self.url_edit.setPlaceholderText("http://127.0.0.1:8000")
        layout.addWidget(self.url_edit)
        
        # Auth Token
        token_label = QLabel("Auth Token (optional):")
        token_label.setStyleSheet("color: white;")
        layout.addWidget(token_label)
        
        self.token_edit = QLineEdit()
        self.token_edit.setText(self.config.get("auth_token", ""))
        self.token_edit.setEchoMode(QLineEdit.Password)
        self.token_edit.setPlaceholderText("Leave empty if not required")
        layout.addWidget(self.token_edit)
        
        # Env Vars (simple text area for now)
        env_label = QLabel("Environment Variables (JSON format):")
        env_label.setStyleSheet("color: white;")
        layout.addWidget(env_label)
        
        self.env_edit = QTextEdit()
        env_vars = self.config.get("env_vars", {})
        self.env_edit.setPlainText(json.dumps(env_vars, indent=2))
        self.env_edit.setMaximumHeight(150)
        layout.addWidget(self.env_edit)
        
        # Warning about plaintext secrets
        warning_label = QLabel(
            "⚠️ Secrets are stored in plaintext. Use OS credential store if available."
        )
        warning_label.setWordWrap(True)
        warning_label.setStyleSheet("color: #ff9800; font-size: 9pt;")
        layout.addWidget(warning_label)
        
        # Buttons
        btn_layout = QHBoxLayout()
        btn_layout.addStretch()
        
        cancel_btn = QPushButton("Cancel")
        cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(cancel_btn)
        
        save_btn = QPushButton("Save")
        save_btn.setStyleSheet("""
            QPushButton {
                background: rgba(76, 175, 80, 0.8);
                color: white;
                border: none;
                padding: 8px 16px;
                border-radius: 4px;
                font-weight: bold;
            }
            QPushButton:hover {
                background: rgba(76, 175, 80, 1.0);
            }
        """)
        save_btn.clicked.connect(self.accept)
        btn_layout.addWidget(save_btn)
        
        layout.addLayout(btn_layout)
    
    def get_config(self) -> Dict[str, Any]:
        """Get the configuration from the dialog."""
        url = self.url_edit.text().strip()
        # Normalize 0.0.0.0 to 127.0.0.1 for connections
        if "0.0.0.0" in url:
            url = url.replace("0.0.0.0", "127.0.0.1")
        
        config = {
            "url": url,
            "auth_token": self.token_edit.text().strip(),
        }
        
        # Parse env vars JSON
        try:
            env_text = self.env_edit.toPlainText().strip()
            if env_text:
                config["env_vars"] = json.loads(env_text)
            else:
                config["env_vars"] = {}
        except json.JSONDecodeError:
            config["env_vars"] = {}
        
        return config


class MCPConnectionsPage(QWidget):
    """Connections page for managing installed MCP servers."""
    
    def __init__(self, parent=None):
        super().__init__(parent)
        # Defer manager initialization to avoid blocking during page creation
        self.connection_manager = None
        self.server_manager = None
        self.connection_cards: Dict[str, ConnectionCard] = {}
        self.server_processes: Dict[str, QProcess] = {}  # server_id -> QProcess
        self._setup_ui()
        # Defer manager creation to avoid blocking
        QTimer.singleShot(100, self._initialize_managers)
    
    def _initialize_managers(self):
        """Initialize managers after UI is set up."""
        self.connection_manager = MCPConnectionManager()
        self.server_manager = MCPServerManager()
        # Now safe to refresh
        QTimer.singleShot(400, self._refresh_connections)
    
    def _setup_ui(self):
        """Setup the UI."""
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)
        
        # Header with title and buttons
        header_layout = QHBoxLayout()
        title = QLabel("🔌 MCP Connections")
        title.setProperty("class", "page_title")
        header_layout.addWidget(title)
        header_layout.addStretch()
        
        # Connect to Local Server button
        self.connect_local_btn = QPushButton("🔗 Connect to Local Server")
        self.connect_local_btn.setStyleSheet("""
            QPushButton {
                background: rgba(102, 126, 234, 0.8);
                color: white;
                border: none;
                padding: 8px 16px;
                border-radius: 4px;
                font-weight: bold;
            }
            QPushButton:hover {
                background: rgba(102, 126, 234, 1.0);
            }
        """)
        self.connect_local_btn.clicked.connect(self._connect_to_local_server)
        header_layout.addWidget(self.connect_local_btn)
        
        # Refresh button
        self.refresh_btn = QPushButton("🔄 Refresh")
        self.refresh_btn.clicked.connect(self._refresh_connections)
        header_layout.addWidget(self.refresh_btn)
        
        layout.addLayout(header_layout)
        
        # Info text
        info_label = QLabel(
            "Manage installed MCP servers. Configure, start, and connect to servers to use their tools."
        )
        info_label.setWordWrap(True)
        info_label.setStyleSheet("color: #888; font-size: 10pt;")
        layout.addWidget(info_label)
        
        # Scroll area for connection cards
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
    
    def _refresh_connections(self):
        """Refresh the list of installed servers."""
        # Ensure managers are initialized
        if self.connection_manager is None:
            QTimer.singleShot(100, self._refresh_connections)
            return
        
        servers = self.connection_manager.list_servers()
        self._update_connection_cards(servers)
    
    def _update_connection_cards(self, servers: List[Dict[str, Any]]):
        """Update the connection cards display."""
        # Clear existing cards
        for card in self.connection_cards.values():
            card.setParent(None)
        self.connection_cards.clear()
        
        # Create cards
        for server in servers:
            server_id = server.get("server_id", "")
            card = ConnectionCard(server, self)
            card.configure_clicked.connect(self._on_configure_clicked)
            card.start_clicked.connect(self._on_start_clicked)
            card.stop_clicked.connect(self._on_stop_clicked)
            card.connect_clicked.connect(self._on_connect_clicked)
            card.disconnect_clicked.connect(self._on_disconnect_clicked)
            self.connection_cards[server_id] = card
            self.cards_layout.addWidget(card)
        
        if not servers:
            no_servers_label = QLabel("No servers installed. Go to Catalog to install servers.")
            no_servers_label.setAlignment(Qt.AlignCenter)
            no_servers_label.setStyleSheet("color: #888; font-size: 11pt; padding: 40px;")
            self.cards_layout.addWidget(no_servers_label)
        
        self.cards_layout.addStretch()
    
    def _on_configure_clicked(self, server_id: str):
        """Handle configure button click."""
        if self.connection_manager is None:
            QMessageBox.warning(self, "Error", "Connection manager not initialized. Please wait a moment and try again.")
            return
        try:
            server = self.connection_manager.get_server(server_id)
            if not server:
                QMessageBox.warning(self, "Error", f"Server '{server_id}' not found")
                return
            
            dialog = ConfigureServerDialog(server, self)
            if dialog.exec() == QDialog.Accepted:
                config = dialog.get_config()
                self.connection_manager.update_server_config(server_id, config)
                self.connection_manager.update_server_status(server_id, "configured")
                self._refresh_connections()
        except Exception as e:
            QMessageBox.warning(self, "Error", f"Failed to configure server: {str(e)}")
    
    def _on_start_clicked(self, server_id: str):
        """Handle start button click."""
        # Prevent rapid clicking
        if server_id in self.connection_cards:
            card = self.connection_cards[server_id]
            if not card.start_btn.isEnabled():
                return  # Already processing
            card.start_btn.setEnabled(False)
        
        if self.connection_manager is None or self.server_manager is None:
            if server_id in self.connection_cards:
                self.connection_cards[server_id].start_btn.setEnabled(True)
            QMessageBox.warning(self, "Error", "Managers not initialized. Please wait a moment and try again.")
            return
        try:
            server = self.connection_manager.get_server(server_id)
            if not server:
                QMessageBox.warning(self, "Error", f"Server '{server_id}' not found")
                return
            
            # Get server command
            install_method = server.get("install_method", "")
            
            # Local servers are managed from Server page, not here
            if install_method == "local":
                QMessageBox.information(
                    self,
                    "Local Server",
                    "The local tool server is managed from the Server tab.\n\n"
                    "Please start/stop it there, then use Connect here to connect to it."
                )
                if server_id in self.connection_cards:
                    self.connection_cards[server_id].start_btn.setEnabled(True)
                return
            
            install_path_str = server.get("install_path")
            install_path = Path(install_path_str) if install_path_str else None
            
            command = self.server_manager.get_server_command(
                server_id, install_method, install_path
            )
            
            if not command:
                QMessageBox.warning(
                    self,
                    "Cannot Start",
                    f"Cannot determine start command for {server_id}.\n"
                    f"Install method: {install_method}"
                )
                if server_id in self.connection_cards:
                    self.connection_cards[server_id].start_btn.setEnabled(True)
                return
            
            # Create QProcess
            process = QProcess(self)
            process.setProcessChannelMode(QProcess.MergedChannels)
            
            # Set environment variables
            env_vars = server.get("config", {}).get("env_vars", {})
            env = process.processEnvironment()
            for key, value in env_vars.items():
                env.insert(key, str(value))
            process.setProcessEnvironment(env)
            
            # Connect signals
            def on_ready_read():
                output = process.readAllStandardOutput().data().decode("utf-8", errors="replace")
                if server_id in self.connection_cards:
                    self.connection_cards[server_id].append_log(output)
            
            def on_finished(exit_code, exit_status):
                if server_id in self.connection_cards:
                    self.connection_cards[server_id].append_log(f"\n[Process finished with code {exit_code}]")
                if server_id in self.server_processes:
                    del self.server_processes[server_id]
                self.connection_manager.update_server_status(server_id, "stopped")
                if server_id in self.connection_cards:
                    self.connection_cards[server_id].update_server_data(
                        self.connection_manager.get_server(server_id) or {}
                    )
            
            process.readyReadStandardOutput.connect(on_ready_read)
            process.finished.connect(on_finished)
            
            # Start process
            # Parse command (handle paths with spaces)
            parts = shlex.split(command)
            if not parts:
                QMessageBox.warning(self, "Error", "Invalid command")
                return
            
            program = parts[0]
            args = parts[1:] if len(parts) > 1 else []
            
            if install_path and install_path.exists():
                process.setWorkingDirectory(str(install_path))
            
            apply_create_no_window(process)
            process.start(program, args)
            
            if process.waitForStarted(3000):
                self.server_processes[server_id] = process
                self.connection_manager.update_server_status(server_id, "running")
                if server_id in self.connection_cards:
                    self.connection_cards[server_id].update_server_data(
                        self.connection_manager.get_server(server_id) or {}
                    )
                QMessageBox.information(self, "Server Started", f"Server '{server_id}' started successfully")
            else:
                QMessageBox.warning(self, "Start Failed", f"Failed to start server: {process.errorString()}")
                if server_id in self.connection_cards:
                    self.connection_cards[server_id].start_btn.setEnabled(True)
        except Exception as e:
            QMessageBox.warning(self, "Error", f"Failed to start server: {str(e)}")
            if server_id in self.connection_cards:
                self.connection_cards[server_id].start_btn.setEnabled(True)
    
    def _on_stop_clicked(self, server_id: str):
        """Handle stop button click."""
        # Prevent rapid clicking
        if server_id in self.connection_cards:
            card = self.connection_cards[server_id]
            if not card.stop_btn.isEnabled():
                return  # Already processing
            card.stop_btn.setEnabled(False)
        
        if self.connection_manager is None:
            if server_id in self.connection_cards:
                self.connection_cards[server_id].stop_btn.setEnabled(True)
            QMessageBox.warning(self, "Error", "Connection manager not initialized. Please wait a moment and try again.")
            return
        try:
            if server_id not in self.server_processes:
                if server_id in self.connection_cards:
                    self.connection_cards[server_id].stop_btn.setEnabled(True)
                QMessageBox.warning(self, "Error", f"Server '{server_id}' is not running")
                return
            
            process = self.server_processes[server_id]
            process.terminate()
            
            if not process.waitForFinished(3000):
                process.kill()
                process.waitForFinished(1000)
            
            del self.server_processes[server_id]
            self.connection_manager.update_server_status(server_id, "stopped")
            if server_id in self.connection_cards:
                self.connection_cards[server_id].update_server_data(
                    self.connection_manager.get_server(server_id) or {}
                )
                self.connection_cards[server_id].stop_btn.setEnabled(True)
        except Exception as e:
            QMessageBox.warning(self, "Error", f"Failed to stop server: {str(e)}")
            if server_id in self.connection_cards:
                self.connection_cards[server_id].stop_btn.setEnabled(True)
    
    def _on_connect_clicked(self, server_id: str):
        """Handle connect button click."""
        # Prevent rapid clicking
        if server_id in self.connection_cards:
            card = self.connection_cards[server_id]
            if not card.connect_btn.isEnabled():
                return  # Already processing
            card.connect_btn.setEnabled(False)
        
        if self.connection_manager is None:
            if server_id in self.connection_cards:
                self.connection_cards[server_id].connect_btn.setEnabled(True)
            QMessageBox.warning(self, "Error", "Connection manager not initialized. Please wait a moment and try again.")
            return
        try:
            success, message, tools = self.connection_manager.connect(server_id)
            
            if success:
                tool_count = len(tools) if tools else 0
                if tool_count > 0:
                    QMessageBox.information(
                        self, 
                        "Connected", 
                        f"{message}\n\nFound {tool_count} tool(s). Check the Tools tab to use them."
                    )
                else:
                    QMessageBox.warning(
                        self,
                        "Connected (No Tools)",
                        f"{message}\n\nNo tools found. The server may not have any tools available, or tools may need to be enabled in the server configuration."
                    )
                if server_id in self.connection_cards:
                    self.connection_cards[server_id].update_server_data(
                        self.connection_manager.get_server(server_id) or {}
                    )
                    self.connection_cards[server_id].connect_btn.setEnabled(True)
                # Notify Tools page to refresh via parent MCPPage
                parent = self.parent()
                while parent:
                    if hasattr(parent, 'get_tools_page'):
                        tools_page = parent.get_tools_page()
                        if tools_page:
                            QTimer.singleShot(100, tools_page._refresh_tools)
                        break
                    elif hasattr(parent, 'tools_page'):
                        QTimer.singleShot(100, parent.tools_page._refresh_tools)
                        break
                    parent = parent.parent() if hasattr(parent, 'parent') else None
            else:
                if server_id in self.connection_cards:
                    self.connection_cards[server_id].connect_btn.setEnabled(True)
                QMessageBox.warning(self, "Connection Failed", message)
        except Exception as e:
            QMessageBox.warning(self, "Error", f"Failed to connect: {str(e)}")
            if server_id in self.connection_cards:
                self.connection_cards[server_id].connect_btn.setEnabled(True)
    
    def _on_disconnect_clicked(self, server_id: str):
        """Handle disconnect button click."""
        # Prevent rapid clicking
        if server_id in self.connection_cards:
            card = self.connection_cards[server_id]
            if not card.disconnect_btn.isEnabled():
                return  # Already processing
            card.disconnect_btn.setEnabled(False)
        
        if self.connection_manager is None:
            if server_id in self.connection_cards:
                self.connection_cards[server_id].disconnect_btn.setEnabled(True)
            return
        try:
            self.connection_manager.disconnect(server_id)
            if server_id in self.connection_cards:
                self.connection_cards[server_id].update_server_data(
                    self.connection_manager.get_server(server_id) or {}
                )
                self.connection_cards[server_id].disconnect_btn.setEnabled(True)
            # Notify Tools page to refresh via parent MCPPage
            parent = self.parent()
            while parent:
                if hasattr(parent, 'get_tools_page'):
                    tools_page = parent.get_tools_page()
                    if tools_page:
                        QTimer.singleShot(100, tools_page._refresh_tools)
                    break
                elif hasattr(parent, 'tools_page'):
                    QTimer.singleShot(100, parent.tools_page._refresh_tools)
                    break
                parent = parent.parent() if hasattr(parent, 'parent') else None
        except Exception as e:
            QMessageBox.warning(self, "Error", f"Failed to disconnect: {str(e)}")
            if server_id in self.connection_cards:
                self.connection_cards[server_id].disconnect_btn.setEnabled(True)
    
    def _connect_to_local_server(self):
        """Auto-connect to the local tool server from Server page."""
        # Find ServerPage in parent hierarchy
        # MCPConnectionsPage -> MCPPage -> QTabWidget (sub_tabs) -> MCPPage -> QTabWidget (main tabs) -> MainWindow
        server_page = None
        
        # Method 1: Find the main QTabWidget that contains both MCPPage and ServerPage
        # Start from MCPPage (our parent)
        mcp_page = self.parent()  # MCPPage
        if mcp_page:
            # MCPPage's parent should be the main QTabWidget
            main_tabs = mcp_page.parent()  # QTabWidget (main tabs)
            if main_tabs:
                # ServerPage is at index 5 in the main tabs
                if main_tabs.count() > 5:
                    widget = main_tabs.widget(5)
                    if isinstance(widget, ServerPage):
                        server_page = widget
        
        # Method 2: Traverse up to find MainWindow (has 'tabs' attribute)
        if not server_page:
            parent = self.parent()  # MCPPage
            main_window = None
            while parent:
                if hasattr(parent, 'tabs'):
                    main_window = parent
                    break
                parent = parent.parent() if hasattr(parent, 'parent') else None
            
            if main_window and hasattr(main_window, 'tabs'):
                tabs = main_window.tabs
                # Find ServerPage tab (index 5)
                if tabs.count() > 5:
                    widget = tabs.widget(5)
                    if isinstance(widget, ServerPage):
                        server_page = widget
        
        # Method 3: Fallback - search through QApplication for MainWindow
        if not server_page:
            from PySide6.QtWidgets import QApplication
            app = QApplication.instance()
            if app:
                for widget in app.allWidgets():
                    if hasattr(widget, 'tabs') and hasattr(widget, 'server_btn'):
                        tabs = widget.tabs
                        if tabs.count() > 5:
                            w = tabs.widget(5)
                            if isinstance(w, ServerPage):
                                server_page = w
                                break
        
        # If we couldn't find ServerPage widget, try reading from config file directly
        server_info = None
        if server_page:
            server_info = server_page.get_server_connection_info()
        else:
            # Fallback: Read server config directly from file
            try:
                from desktop_app.config.config_manager import ConfigManager
                config_mgr = ConfigManager()
                config = config_mgr.load()
                
                # Check if server appears to be running by checking if port is configured
                port = config.get("port", 8765)
                host = config.get("host", "127.0.0.1")
                token = config.get("token", "CHANGE_ME")
                
                # Normalize host for connection
                if host == "0.0.0.0":
                    host = "127.0.0.1"
                
                server_info = {
                    "url": f"http://{host}:{port}",
                    "token": token,
                    "name": "Local Tool Server"
                }
                
                # Verify server is actually running by checking health endpoint
                import urllib.request
                try:
                    health_url = f"http://{host}:{port}/health"
                    with urllib.request.urlopen(health_url, timeout=2) as r:
                        # Server is running
                        pass
                except Exception:
                    # Server might not be running, but continue anyway - connection will fail with better error
                    QMessageBox.warning(
                        self,
                        "Server Not Running",
                        f"Server appears to not be running at {server_info['url']}.\n\n"
                        "Please start the server in the Server tab first."
                    )
                    return
            except Exception as e:
                QMessageBox.warning(
                    self, 
                    "Error", 
                    f"Could not find Server page or read server config: {str(e)}\n\n"
                    "Please ensure the server is running in the Server tab."
                )
                return
        
        if not server_info:
            QMessageBox.warning(self, "Error", "Could not determine server connection info. Please start the server in the Server tab first.")
            return
        
        # Check if already connected
        server_id = "local_tool_server"
        if self.connection_manager and server_id in self.connection_manager.connections:
            # Update existing connection
            reply = QMessageBox.question(
                self,
                "Already Configured",
                "Local server is already configured. Update with current server settings?",
                QMessageBox.Yes | QMessageBox.No,
                QMessageBox.No
            )
            if reply == QMessageBox.No:
                return
        elif server_id in self.connection_cards:
            QMessageBox.information(self, "Already Connected", "Local server is already configured. Use Configure to update settings.")
            return
        
        # Add server to connection manager
        if self.connection_manager is None:
            QMessageBox.warning(self, "Error", "Connection manager not initialized. Please wait a moment and try again.")
            return
        
        self.connection_manager.add_server(
            server_id=server_id,
            install_method="local",
            install_path=None,
            config={
                "url": server_info["url"],
                "auth_token": server_info["token"],
                "name": server_info["name"]
            }
        )
        
        # Refresh connections list
        self._refresh_connections()
        
        # Auto-connect after a short delay to ensure UI is updated
        QTimer.singleShot(500, lambda: self._on_connect_clicked(server_id))
