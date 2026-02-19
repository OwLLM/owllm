"""
Server page for managing the tool server.
"""
from __future__ import annotations

import json
import secrets
import socket
from pathlib import Path
from typing import Optional

from PySide6.QtCore import QThread, Signal, Qt, QUrl, QTimer
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QLineEdit,
    QCheckBox, QTextEdit, QFileDialog, QGroupBox, QFrame, QMessageBox, QApplication,
    QGridLayout, QRadioButton, QComboBox, QListWidget, QListWidgetItem, QButtonGroup
)
from PySide6.QtGui import QDesktopServices, QClipboard

from tool_server.server import Server, ToolContext
from desktop_app.config.config_manager import ConfigManager


class ServerThread(QThread):
    """Thread for running the server without blocking UI"""
    log_output = Signal(str)
    server_started = Signal(str)  # host:port
    server_stopped = Signal()
    error = Signal(str)

    def __init__(self, host: str, port: int, ctx: ToolContext):
        super().__init__()
        self.host = host
        self.port = port
        self.ctx = ctx
        self.server: Optional[Server] = None
        self._running = False

    def run(self):
        try:
            self._running = True
            self.server = Server(self.host, self.port, self.ctx)
            self.log_output.emit(f"[server] root={self.ctx.root}")
            self.log_output.emit(f"[server] listening http://{self.host}:{self.port}")
            self.server_started.emit(f"{self.host}:{self.port}")
            self.server.serve_forever()
        except Exception as e:
            if self._running:
                self.error.emit(str(e))
        finally:
            self._running = False
            self.server_stopped.emit()

    def stop(self):
        self._running = False
        if self.server:
            try:
                self.server.shutdown()
                self.server.server_close()
            except Exception:
                pass


class ServerPage(QWidget):
    """Server management page"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.server_thread: Optional[ServerThread] = None
        self.config_manager = None  # Defer initialization
        self._server_address = ""
        self._loading_config = False
        self._setup_ui()
        # Defer config loading to avoid blocking during page creation
        QTimer.singleShot(100, self._initialize_config)
    
    def closeEvent(self, event):
        """Stop server when page/widget is closed."""
        self._stop_server_on_close()
        super().closeEvent(event)
    
    def _stop_server_on_close(self):
        """Stop the server thread if running."""
        if self.server_thread is not None:
            try:
                # Check if thread is still valid and running
                if self.server_thread.isRunning():
                    # Stop the server
                    self.server_thread.stop()
                    # Wait briefly for thread to stop (non-blocking check)
                    if not self.server_thread.wait(1000):  # 1 second timeout
                        # Thread didn't stop in time, but continue anyway
                        pass
            except RuntimeError:
                # C++ object already deleted, nothing to do
                pass
            except Exception:
                # Other error, continue anyway
                pass
            finally:
                self.server_thread = None

    def request_stop(self, on_done=None, timeout_ms: int = 5000) -> bool:
        """
        Ask the server to stop and invoke `on_done` once it's actually stopped.
        Returns True if a stop was requested (server was running), else False.
        """
        thread = self.server_thread
        if thread is None:
            print("[DEBUG] request_stop: No server thread found - calling callback immediately")
            if callable(on_done):
                # Call immediately (no need to wait for event loop)
                try:
                    print("[DEBUG] request_stop: Executing immediate callback")
                    on_done()
                except Exception as e:
                    print(f"[DEBUG] request_stop: Error in callback: {e}")
            return False

        try:
            running = thread.isRunning()
        except RuntimeError:
            print("[DEBUG] request_stop: Server thread C++ object already deleted")
            self.server_thread = None
            if callable(on_done):
                QTimer.singleShot(0, on_done)
            return False

        if not running:
            print("[DEBUG] request_stop: Server thread not running")
            if callable(on_done):
                QTimer.singleShot(0, on_done)
            return False

        print("[DEBUG] request_stop: Sending stop signal to server thread...")
        done_called = {"v": False}

        def _done():
            if done_called["v"]:
                return
            done_called["v"] = True
            print("[DEBUG] request_stop: Server stop confirmed or timed out")
            if callable(on_done):
                try:
                    on_done()
                except Exception:
                    pass

        # When the thread signals stopped, proceed.
        try:
            thread.server_stopped.connect(_done)
        except Exception as e:
            print(f"[DEBUG] request_stop: Could not connect to server_stopped: {e}")

        # Timeout safety: don't hang app close forever if something is stuck.
        QTimer.singleShot(timeout_ms, _done)

        # Request stop (the same procedure as clicking the button)
        try:
            thread.stop()
            print("[DEBUG] request_stop: thread.stop() called")
        except RuntimeError:
            print("[DEBUG] request_stop: RuntimeError during thread.stop()")
            self.server_thread = None
            _done()
        except Exception as e:
            print(f"[DEBUG] request_stop: Error calling thread.stop(): {e}")
            _done()

        return True

    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)

        title = QLabel("🖧 Servers")
        title.setProperty("class", "page_title")
        layout.addWidget(title)

        # TWO COLUMN LAYOUT
        cols = QHBoxLayout()
        cols.setSpacing(16)

        # ===================================================================
        # LEFT COLUMN: TOOL SERVER (MCP Server)
        # ===================================================================
        left_col = QWidget()
        left_layout = QVBoxLayout(left_col)
        left_layout.setContentsMargins(0, 0, 0, 0)
        left_layout.setSpacing(10)

        tool_server_group = QGroupBox("🛠️ Tool Server (MCP)")
        tool_server_layout = QVBoxLayout(tool_server_group)
        tool_server_layout.setSpacing(8)

        # Status
        self.status_label = QLabel("● Stopped")
        self.status_label.setStyleSheet("font-weight: bold;")
        tool_server_layout.addWidget(self.status_label)
        
        self.address_label = QLabel("Address: -")
        tool_server_layout.addWidget(self.address_label)
        
        # LAN address (dynamic)
        self.lan_address_label = None
        self.copy_lan_btn = None
        self.status_layout = tool_server_layout  # For backward compatibility

        # Start/Stop button
        self.start_stop_btn = QPushButton("▶ Start Server")
        # Prevent starting with wrong defaults before config loads (port/token mismatch)
        self.start_stop_btn.setEnabled(False)
        self.start_stop_btn.clicked.connect(self._toggle_server)
        tool_server_layout.addWidget(self.start_stop_btn)

        # Compact settings grid
        settings_grid = QGridLayout()
        settings_grid.setSpacing(6)
        
        # Port
        settings_grid.addWidget(QLabel("Port:"), 0, 0)
        self.port_edit = QLineEdit("8763")
        self.port_edit.setMaximumWidth(80)
        settings_grid.addWidget(self.port_edit, 0, 1)
        
        # Expose to LAN checkbox
        self.expose_to_lan_check = QCheckBox("LAN")
        self.expose_to_lan_check.setToolTip("Expose to LAN (0.0.0.0)")
        settings_grid.addWidget(self.expose_to_lan_check, 0, 2)
        
        # Token
        settings_grid.addWidget(QLabel("Token:"), 1, 0)
        self.token_edit = QLineEdit()
        self.token_edit.setEchoMode(QLineEdit.Password)
        self.token_edit.setPlaceholderText("Auth token")
        settings_grid.addWidget(self.token_edit, 1, 1, 1, 2)
        
        generate_token_btn = QPushButton("🎲")
        generate_token_btn.setMaximumWidth(30)
        generate_token_btn.setToolTip("Generate random token")
        generate_token_btn.clicked.connect(self._generate_token)
        settings_grid.addWidget(generate_token_btn, 1, 3)
        
        # Root directory
        settings_grid.addWidget(QLabel("Root:"), 2, 0)
        self.root_edit = QLineEdit(str(Path.cwd()))
        settings_grid.addWidget(self.root_edit, 2, 1, 1, 2)
        browse_btn = QPushButton("📁")
        browse_btn.setMaximumWidth(30)
        browse_btn.setToolTip("Browse...")
        browse_btn.clicked.connect(self._select_root)
        settings_grid.addWidget(browse_btn, 2, 3)
        
        tool_server_layout.addLayout(settings_grid)

        # Execution Mode (Native vs HTTP)
        mode_group = QGroupBox("Tool Execution Mode")
        mode_layout = QVBoxLayout()
        mode_layout.setSpacing(6)

        # Two side-by-side selectable buttons (exclusive)
        buttons_row = QHBoxLayout()
        buttons_row.setSpacing(8)

        self.mode_native_radio = QPushButton("Native")
        self.mode_native_radio.setCheckable(True)
        self.mode_native_radio.setToolTip("Direct Python execution (faster, local only). No HTTP server needed.")

        self.mode_http_radio = QPushButton("HTTP")
        self.mode_http_radio.setCheckable(True)
        self.mode_http_radio.setToolTip("HTTP server mode (network-capable). Can expose to LAN and works with remote.")

        self._mode_group = QButtonGroup(self)
        self._mode_group.setExclusive(True)
        self._mode_group.addButton(self.mode_native_radio)
        self._mode_group.addButton(self.mode_http_radio)

        btn_style = """
            QPushButton {
                background: rgba(255, 255, 255, 0.08);
                color: rgba(255, 255, 255, 0.85);
                border: 1px solid rgba(255, 255, 255, 0.18);
                border-radius: 8px;
                padding: 10px 12px;
                font-weight: 700;
                min-height: 36px;
            }
            QPushButton:hover {
                background: rgba(255, 255, 255, 0.14);
                border: 1px solid rgba(255, 255, 255, 0.28);
            }
            QPushButton:checked {
                background: rgba(102, 126, 234, 0.35);
                border: 1px solid rgba(102, 126, 234, 0.9);
                color: white;
            }
        """
        self.mode_native_radio.setStyleSheet(btn_style)
        self.mode_http_radio.setStyleSheet(btn_style)

        buttons_row.addWidget(self.mode_native_radio, 1)
        buttons_row.addWidget(self.mode_http_radio, 1)
        mode_layout.addLayout(buttons_row)

        # Small side-by-side info labels under the buttons
        info_grid = QGridLayout()
        info_grid.setHorizontalSpacing(8)
        info_grid.setVerticalSpacing(4)
        native_info = QLabel("• No port conflicts\n• Faster execution\n• No server needed")
        native_info.setStyleSheet("font-size: 9pt; color: #888;")
        native_info.setAlignment(Qt.AlignTop | Qt.AlignLeft)
        http_info = QLabel("• Can expose to network\n• Works with remote servers\n• MCP protocol compatible")
        http_info.setStyleSheet("font-size: 9pt; color: #888;")
        http_info.setAlignment(Qt.AlignTop | Qt.AlignLeft)
        info_grid.addWidget(native_info, 0, 0)
        info_grid.addWidget(http_info, 0, 1)
        mode_layout.addLayout(info_grid)
        
        mode_group.setLayout(mode_layout)
        tool_server_layout.addWidget(mode_group)
        
        # Connect to save
        self.mode_native_radio.toggled.connect(self._save_config_silent)
        self.mode_http_radio.toggled.connect(self._save_config_silent)

        # Permissions (compact)
        perm_label = QLabel("<b>Permissions:</b>")
        tool_server_layout.addWidget(perm_label)
        
        perm_grid = QGridLayout()
        perm_grid.setSpacing(4)
        self.allow_shell_check = QCheckBox("Shell")
        self.allow_write_check = QCheckBox("Write")
        self.allow_git_check = QCheckBox("Git")
        self.allow_git_check.setChecked(True)
        self.allow_network_check = QCheckBox("Network")
        perm_grid.addWidget(self.allow_shell_check, 0, 0)
        perm_grid.addWidget(self.allow_write_check, 0, 1)
        perm_grid.addWidget(self.allow_git_check, 1, 0)
        perm_grid.addWidget(self.allow_network_check, 1, 1)
        tool_server_layout.addLayout(perm_grid)

        # Compact buttons
        tool_btn_layout = QHBoxLayout()
        tool_btn_layout.setSpacing(4)
        
        self.health_btn = QPushButton("♥ Health")
        self.health_btn.clicked.connect(self._check_health)
        self.health_btn.setEnabled(False)
        tool_btn_layout.addWidget(self.health_btn)
        
        save_btn = QPushButton("💾 Save")
        save_btn.setToolTip("Save Configuration")
        save_btn.clicked.connect(self._save_config)
        tool_btn_layout.addWidget(save_btn)
        
        tool_server_layout.addLayout(tool_btn_layout)
        
        self.config_path_label = QLabel("Config: -")
        self.config_path_label.setWordWrap(True)
        self.config_path_label.setStyleSheet("font-size: 9pt; color: gray;")
        tool_server_layout.addWidget(self.config_path_label)

        left_layout.addWidget(tool_server_group)
        left_layout.addStretch()

        # ===================================================================
        # RIGHT COLUMN: LLM INFERENCE SERVER
        # ===================================================================
        right_col = QWidget()
        right_layout = QVBoxLayout(right_col)
        right_layout.setContentsMargins(0, 0, 0, 0)
        right_layout.setSpacing(10)

        llm_server_group = QGroupBox("🤖 LLM Inference Server")
        llm_server_layout = QVBoxLayout(llm_server_group)
        llm_server_layout.setSpacing(8)

        # Status
        self.llm_server_status_label = QLabel("● Not running")
        self.llm_server_status_label.setStyleSheet("font-weight: bold;")
        llm_server_layout.addWidget(self.llm_server_status_label)
        
        # Model selector
        model_select_label = QLabel("Select Model:")
        model_select_label.setStyleSheet("font-weight: bold; font-size: 9pt;")
        llm_server_layout.addWidget(model_select_label)
        
        self.llm_model_selector = QComboBox()
        self.llm_model_selector.setToolTip("Select which model to run for the OpenAI-compatible API")
        self.llm_model_selector.currentIndexChanged.connect(self._on_llm_model_selection_changed)
        self._populate_model_selector()
        llm_server_layout.addWidget(self.llm_model_selector)
        
        # Compact info grid
        info_grid = QGridLayout()
        info_grid.setSpacing(4)
        
        info_grid.addWidget(QLabel("Model:"), 0, 0)
        self.llm_model_label = QLabel("-")
        self.llm_model_label.setWordWrap(True)
        info_grid.addWidget(self.llm_model_label, 0, 1)
        
        info_grid.addWidget(QLabel("Port:"), 1, 0)
        self.llm_port_label = QLabel("-")
        info_grid.addWidget(self.llm_port_label, 1, 1)
        
        llm_server_layout.addLayout(info_grid)
        
        # API URL (full width)
        api_label_header = QLabel("OpenAI API:")
        api_label_header.setStyleSheet("font-weight: bold; font-size: 9pt;")
        llm_server_layout.addWidget(api_label_header)
        
        self.llm_api_label = QLabel("-")
        self.llm_api_label.setWordWrap(True)
        self.llm_api_label.setStyleSheet("font-size: 9pt; color: #0066cc;")
        self.llm_api_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
        llm_server_layout.addWidget(self.llm_api_label)

        # Control buttons
        llm_btn_layout = QHBoxLayout()
        llm_btn_layout.setSpacing(10) # Increased spacing
        
        self.llm_start_btn = QPushButton("▶ Start")
        self.llm_start_btn.setMinimumHeight(45) # Increased height
        self.llm_start_btn.setCursor(Qt.PointingHandCursor)
        self.llm_start_btn.setStyleSheet("""
            QPushButton {
                background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
                    stop:0 #4CAF50, stop:1 #388E3C);
                color: white;
                border: none;
                border-radius: 8px;
                font-size: 11pt;
                font-weight: bold;
            }
            QPushButton:hover {
                background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
                    stop:0 #66BB6A, stop:1 #43A047);
            }
            QPushButton:pressed {
                background: #2E7D32;
            }
            QPushButton:disabled {
                background: rgba(255, 255, 255, 0.1);
                color: rgba(255, 255, 255, 0.3);
            }
        """)
        self.llm_start_btn.clicked.connect(self._start_llm_server)
        llm_btn_layout.addWidget(self.llm_start_btn)
        
        self.llm_stop_btn = QPushButton("⏹ Stop")
        self.llm_stop_btn.setMinimumHeight(45) # Increased height
        self.llm_stop_btn.setCursor(Qt.PointingHandCursor)
        self.llm_stop_btn.setStyleSheet("""
            QPushButton {
                background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
                    stop:0 #f44336, stop:1 #d32f2f);
                color: white;
                border: none;
                border-radius: 8px;
                font-size: 11pt;
                font-weight: bold;
            }
            QPushButton:hover {
                background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
                    stop:0 #ef5350, stop:1 #e53935);
            }
            QPushButton:pressed {
                background: #c62828;
            }
            QPushButton:disabled {
                background: rgba(255, 255, 255, 0.1);
                color: rgba(255, 255, 255, 0.3);
            }
        """)
        self.llm_stop_btn.setEnabled(False)
        self.llm_stop_btn.clicked.connect(self._stop_llm_server)
        llm_btn_layout.addWidget(self.llm_stop_btn)
        
        llm_server_layout.addLayout(llm_btn_layout)
        
        # Copy and help buttons in the same line
        secondary_btn_layout = QHBoxLayout()
        secondary_btn_layout.setSpacing(10)
        
        self.copy_api_btn = QPushButton("📋 Copy API URL")
        self.copy_api_btn.setMinimumHeight(42)
        self.copy_api_btn.setCursor(Qt.PointingHandCursor)
        self.copy_api_btn.setStyleSheet("""
            QPushButton {
                background: rgba(255, 255, 255, 0.1);
                color: white;
                border: 1px solid rgba(255, 255, 255, 0.2);
                border-radius: 8px;
                font-size: 10pt;
                font-weight: 600;
            }
            QPushButton:hover {
                background: rgba(255, 255, 255, 0.2);
                border: 1px solid rgba(255, 255, 255, 0.3);
            }
            QPushButton:disabled {
                color: rgba(255, 255, 255, 0.2);
            }
        """)
        self.copy_api_btn.setToolTip("Copy for Cursor/VS Code")
        self.copy_api_btn.clicked.connect(self._copy_api_url)
        self.copy_api_btn.setEnabled(False)
        secondary_btn_layout.addWidget(self.copy_api_btn, 1)
        
        self.copy_model_btn = QPushButton("📋 Copy Model Name")
        self.copy_model_btn.setMinimumHeight(42)
        self.copy_model_btn.setCursor(Qt.PointingHandCursor)
        self.copy_model_btn.setStyleSheet("""
            QPushButton {
                background: rgba(255, 255, 255, 0.1);
                color: white;
                border: 1px solid rgba(255, 255, 255, 0.2);
                border-radius: 8px;
                font-size: 10pt;
                font-weight: 600;
            }
            QPushButton:hover {
                background: rgba(255, 255, 255, 0.2);
                border: 1px solid rgba(255, 255, 255, 0.3);
            }
            QPushButton:disabled {
                color: rgba(255, 255, 255, 0.2);
            }
        """)
        self.copy_model_btn.setToolTip("Copy model ID for Cursor Model field")
        self.copy_model_btn.clicked.connect(self._copy_model_name)
        self.copy_model_btn.setEnabled(False)
        secondary_btn_layout.addWidget(self.copy_model_btn, 1)
        
        help_btn = QPushButton("📖 Setup Guide")
        help_btn.setMinimumHeight(42)
        help_btn.setCursor(Qt.PointingHandCursor)
        help_btn.setStyleSheet("""
            QPushButton {
                background: transparent;
                color: #667eea;
                border: 1px solid #667eea;
                border-radius: 8px;
                font-size: 10pt;
                font-weight: 600;
            }
            QPushButton:hover {
                background: rgba(102, 126, 234, 0.1);
                border: 1px solid #7a8efc;
                color: #7a8efc;
            }
        """)
        help_btn.setToolTip("How to use with Cursor/VS Code")
        help_btn.clicked.connect(self._show_llm_api_help)
        secondary_btn_layout.addWidget(help_btn, 1) # Added stretch factor
        
        llm_server_layout.addLayout(secondary_btn_layout)
        
        # Status timer
        self.llm_status_timer = QTimer()
        self.llm_status_timer.timeout.connect(self._update_llm_server_status)
        self.llm_status_timer.timeout.connect(self._refresh_active_servers)
        self.llm_status_timer.start(2000)

        right_layout.addWidget(llm_server_group)

        # Active inference servers (from StateStore + /health; includes servers started from Test Chat)
        active_servers_group = QGroupBox("Active inference servers")
        active_servers_layout = QVBoxLayout(active_servers_group)
        active_servers_layout.setSpacing(6)
        self.active_servers_list = QListWidget()
        self.active_servers_list.setMinimumHeight(100)
        self.active_servers_list.setMaximumHeight(180)
        self.active_servers_list.setToolTip("Servers currently running (from this page or Test Chat). Select one to switch model/API.")
        self.active_servers_list.itemSelectionChanged.connect(self._on_active_server_selected)
        active_servers_layout.addWidget(self.active_servers_list)
        active_btns_layout = QHBoxLayout()
        active_refresh_btn = QPushButton("Refresh")
        active_refresh_btn.clicked.connect(self._refresh_active_servers)
        active_btns_layout.addWidget(active_refresh_btn)
        self.active_stop_selected_btn = QPushButton("⏹ Stop selected")
        self.active_stop_selected_btn.setToolTip("Stop the selected server (by model or by port)")
        self.active_stop_selected_btn.clicked.connect(self._stop_selected_active_server)
        active_btns_layout.addWidget(self.active_stop_selected_btn)
        active_servers_layout.addLayout(active_btns_layout)
        right_layout.addWidget(active_servers_group)
        
        # Server Log (shared by both servers)
        log_group = QGroupBox("📋 Server Log")
        log_layout = QVBoxLayout(log_group)
        log_layout.setSpacing(6)
        
        self.log_text = QTextEdit()
        self.log_text.setReadOnly(True)
        self.log_text.setMinimumHeight(300)
        self.log_text.setMaximumHeight(400)
        log_layout.addWidget(self.log_text)

        # Clear button in horizontal layout to ensure it's fully visible
        clear_btn_layout = QHBoxLayout()
        clear_btn_layout.setContentsMargins(5, 5, 5, 5)
        clear_btn = QPushButton("🗑️ Clear Log") # More descriptive
        clear_btn.setFixedWidth(140)  # Increased further for length
        clear_btn.setMinimumHeight(40) # Increased height
        clear_btn.setCursor(Qt.PointingHandCursor)
        clear_btn.setStyleSheet("""
            QPushButton {
                background: rgba(255, 255, 255, 0.08);
                color: rgba(255, 255, 255, 0.7);
                border: 1px solid rgba(255, 255, 255, 0.15);
                border-radius: 6px;
                font-weight: 600;
            }
            QPushButton:hover {
                background: rgba(255, 255, 255, 0.15);
                color: white;
                border: 1px solid rgba(255, 255, 255, 0.3);
            }
            QPushButton:pressed {
                background: rgba(255, 255, 255, 0.05);
            }
        """)
        clear_btn.clicked.connect(self.log_text.clear)
        clear_btn_layout.addWidget(clear_btn)
        clear_btn_layout.addStretch()  # Push button to the left
        log_layout.addLayout(clear_btn_layout)
        
        right_layout.addWidget(log_group)
        right_layout.addStretch()

        # Add columns to main layout
        cols.addWidget(left_col, 1)
        cols.addWidget(right_col, 1)
        layout.addLayout(cols)
        
        # Sync Copy Model Name button state with initial selection
        QTimer.singleShot(0, self._on_llm_model_selection_changed)
    
    def _initialize_config(self):
        """Initialize config manager and load config (deferred)."""
        if self._loading_config:
            return
        self._loading_config = True
        try:
            if self.config_manager is None:
                self.config_manager = ConfigManager()
            self._load_config()
        except Exception as e:
            # Non-critical - continue without config
            pass
        finally:
            # Always enable the button after init attempt; starting with defaults is better than a dead UI.
            if hasattr(self, "start_stop_btn"):
                self.start_stop_btn.setEnabled(True)
            self._loading_config = False

    def _select_root(self):
        path = QFileDialog.getExistingDirectory(self, "Select Workspace Root", self.root_edit.text())
        if path:
            self.root_edit.setText(path)
    
    def _generate_token(self):
        """Generate a random secure token."""
        # Generate a 32-byte token (64 hex characters)
        token = secrets.token_urlsafe(32)
        self.token_edit.setText(token)
        self.token_edit.setEchoMode(QLineEdit.Normal)  # Show it briefly
        QTimer.singleShot(2000, lambda: self.token_edit.setEchoMode(QLineEdit.Password))  # Hide after 2s
    
    def _on_llm_model_selection_changed(self):
        """Enable/disable Copy Model Name based on selection"""
        if hasattr(self, 'copy_model_btn'):
            self.copy_model_btn.setEnabled(self.llm_model_selector.currentData() is not None)
    
    def _populate_model_selector(self):
        """Populate the model selector dropdown with READY models from llm_backends.yaml.
        Matches READY by model_id and by normalized base_model path so config keys align with onboarding."""
        try:
            import yaml
            from pathlib import Path
            from core.model_onboarding import get_onboarding_service

            config_path = Path(__file__).parent.parent.parent / "configs" / "llm_backends.yaml"
            if not config_path.exists():
                self.llm_model_selector.addItem("(No models configured)", None)
                return

            with open(config_path, 'r', encoding='utf-8') as f:
                config = yaml.safe_load(f) or {}

            models = config.get("models", {})
            if not models:
                self.llm_model_selector.addItem("(No models configured)", None)
                return

            # Get READY models: by model_id and by normalized base_model path (so YAML key can differ from onboarding key)
            onboarding = get_onboarding_service()
            ready_list = onboarding.list_ready_models()
            ready_by_id = {entry["model_id"]: entry for entry in ready_list}
            ready_by_path = {}
            for e in ready_list:
                p = e.get("base_model_path") or ""
                if p:
                    try:
                        norm = str(Path(p).resolve()).lower().replace("\\", "/")
                        ready_by_path[norm] = e
                    except Exception:
                        ready_by_path[str(p).lower().replace("\\", "/")] = e

            def is_ready(model_id: str, base_model: str) -> bool:
                if model_id in ready_by_id:
                    return True
                if not base_model:
                    return False
                try:
                    norm = str(Path(base_model).resolve()).lower().replace("\\", "/")
                    return norm in ready_by_path
                except Exception:
                    return str(base_model).lower().replace("\\", "/") in ready_by_path

            # Add READY models that appear in config (match by id or by base path)
            model_items = []
            for model_id, model_cfg in models.items():
                if model_id == "default" and len(models) > 1:
                    continue
                base_model = model_cfg.get("base_model", "")
                if not is_ready(model_id, base_model):
                    continue
                port = model_cfg.get("port", "?")
                if base_model:
                    model_name = Path(base_model).name
                    display_text = f"✓ {model_name} (Port: {port})"
                else:
                    display_text = f"✓ {model_id} (Port: {port})"
                model_items.append((display_text, model_id))

            # Add READY models not in config so they still appear.
            # Registration into llm_backends.yaml is deferred to Start click to keep app startup fast.
            added_ids = {mid for _, mid in model_items}
            for entry in ready_list:
                mid = entry.get("model_id") or ""
                if not mid or mid in added_ids:
                    continue
                base = entry.get("base_model_path") or ""
                port = "?"
                model_cfg = models.get(mid, {}) if isinstance(models, dict) else {}
                if isinstance(model_cfg, dict) and model_cfg.get("port") is not None:
                    port = model_cfg.get("port", "?")
                name = Path(base).name if base else mid
                model_items.append((f"✓ {name} (Port: {port})", mid))
                added_ids.add(mid)

            model_items.sort(key=lambda x: x[0])

            self.llm_model_selector.clear()
            if not model_items:
                self.llm_model_selector.addItem("(No READY models - run onboarding first)", None)
            else:
                for display_text, model_id in model_items:
                    self.llm_model_selector.addItem(display_text, model_id)
                if self.llm_model_selector.count() > 0:
                    self.llm_model_selector.setCurrentIndex(0)
        except Exception as e:
            self.llm_model_selector.clear()
            self.llm_model_selector.addItem(f"(Error loading models: {e})", None)

    def _ensure_model_in_config(self, config_path: Path, config: dict, model_id: str, base_model_path: str):
        """Add READY model to llm_backends.yaml if missing so Start works. Returns port or None."""
        try:
            import yaml
            import socket
            if "models" not in config:
                config["models"] = {}
            if model_id in config["models"]:
                return config["models"][model_id].get("port")
            path_str = str(Path(base_model_path).resolve()) if base_model_path else ""
            if not path_str:
                return None

            def _port_free(p: int) -> bool:
                s = None
                try:
                    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    s.bind(("127.0.0.1", int(p)))
                    return True
                except Exception:
                    return False
                finally:
                    if s:
                        try:
                            s.close()
                        except Exception:
                            pass

            used = {int(c.get("port", 10500)) for c in config["models"].values() if isinstance(c, dict) and c.get("port") is not None}
            port = 10500
            while port in used or not _port_free(port):
                port += 1
            path_lower = path_str.lower()
            model_type = "instruct" if ("instruct" in path_lower or "chat" in path_lower or "-it" in path_lower) else "base"
            config["models"][model_id] = {
                "base_model": path_str,
                "adapter_dir": None,
                "model_type": model_type,
                "port": port,
                "use_4bit": True,
                "system_prompt": "",
            }
            with open(config_path, "w", encoding="utf-8") as f:
                yaml.safe_dump(config, f, sort_keys=False, default_flow_style=False)
            return port
        except Exception:
            return None

    def _load_config(self):
        """Load configuration from file."""
        if self.config_manager is None:
            return
        try:
            config = self.config_manager.load()
            self.port_edit.setText(str(config.get("port", 8763)))
            self.token_edit.setText(config.get("token", ""))
            self.root_edit.setText(config.get("workspace_root", str(Path.cwd())))
            self.allow_shell_check.setChecked(config.get("allow_shell", False))
            self.allow_write_check.setChecked(config.get("allow_write", False))
            self.allow_git_check.setChecked(config.get("allow_git", True))
            self.allow_network_check.setChecked(config.get("allow_network", False))
            self.expose_to_lan_check.setChecked(config.get("expose_to_lan", False))
            
            # Load execution mode
            execution_mode = config.get("execution_mode", "http")
            if execution_mode == "native":
                self.mode_native_radio.setChecked(True)
            else:
                self.mode_http_radio.setChecked(True)
            
            self.config_path_label.setText(f"Config: {self.config_manager.get_config_path()}")
        except Exception:
            # Non-critical - use defaults
            pass

    def _save_config(self):
        if self.config_manager is None:
            QMessageBox.warning(self, "Error", "Config manager not initialized. Please wait a moment and try again.")
            return
        try:
            existing = self.config_manager.load()
            expose = self.expose_to_lan_check.isChecked()
            config = {
                "execution_mode": "native" if self.mode_native_radio.isChecked() else "http",
                "host": "0.0.0.0" if expose else "127.0.0.1",
                "port": int(self.port_edit.text() or "8765"),
                "token": self.token_edit.text().strip(),
                "workspace_root": self.root_edit.text().strip() or str(Path.cwd()),
                "allow_shell": self.allow_shell_check.isChecked(),
                "allow_write": self.allow_write_check.isChecked(),
                "allow_git": self.allow_git_check.isChecked(),
                "allow_network": self.allow_network_check.isChecked(),
                "expose_to_lan": expose,
                "enabled_tools": existing.get("enabled_tools", {}),
            }
            self.config_manager.save(config)
            QMessageBox.information(self, "Saved", f"Config saved to:\n{self.config_manager.get_config_path()}")
        except Exception as e:
            QMessageBox.warning(self, "Error", f"Failed to save: {e}")

    def _save_config_silent(self):
        if self.config_manager is None:
            return
        try:
            existing = self.config_manager.load()
            expose = self.expose_to_lan_check.isChecked()
            config = {
                "execution_mode": "native" if self.mode_native_radio.isChecked() else "http",
                "host": "0.0.0.0" if expose else "127.0.0.1",
                "port": int(self.port_edit.text() or "8765"),
                "token": self.token_edit.text().strip(),
                "workspace_root": self.root_edit.text().strip() or str(Path.cwd()),
                "allow_shell": self.allow_shell_check.isChecked(),
                "allow_write": self.allow_write_check.isChecked(),
                "allow_git": self.allow_git_check.isChecked(),
                "allow_network": self.allow_network_check.isChecked(),
                "expose_to_lan": expose,
                "enabled_tools": existing.get("enabled_tools", {}),
            }
            self.config_manager.save(config)
        except Exception:
            pass

    def _toggle_server(self):
        # Prevent rapid clicking - disable button immediately
        if not self.start_stop_btn.isEnabled():
            return  # Already processing
        
        # Check if thread exists and is valid (C++ object not deleted)
        thread_valid = False
        thread_running = False
        if self.server_thread is not None:
            try:
                # Try to access the thread - will raise RuntimeError if C++ object is deleted
                thread_running = self.server_thread.isRunning()
                thread_valid = True
            except RuntimeError:
                # C++ object was deleted, set to None
                self.server_thread = None
                thread_valid = False
        
        if thread_valid and thread_running:
            # Stop the server
            try:
                self.server_thread.stop()
            except RuntimeError:
                # Thread was deleted, reset state
                self.server_thread = None
                self._on_stopped()
                return
            # Don't wait() here as it blocks the UI thread
            self.start_stop_btn.setText("Stopping...")
            self.start_stop_btn.setEnabled(False)
            # Schedule cleanup check
            QTimer.singleShot(500, self._check_thread_cleanup)
        else:
            # Check if previous thread is still cleaning up
            if thread_valid and not thread_running:
                # Thread finished but not yet deleted - wait a bit
                QTimer.singleShot(200, self._start_server)
            else:
                self._start_server()
    
    def _check_thread_cleanup(self):
        """Check if thread cleanup is complete."""
        if self.server_thread is None:
            # Thread was deleted, reset state
            self._on_stopped()
            return
        
        try:
            if not self.server_thread.isRunning():
                # Thread has stopped, reset button state
                self._on_stopped()
            else:
                # Still stopping, check again
                QTimer.singleShot(500, self._check_thread_cleanup)
        except RuntimeError:
            # C++ object was deleted, reset state
            self.server_thread = None
            self._on_stopped()
    
    def _start_server(self):
        """Start the server (called after ensuring previous thread is cleaned up)."""
        try:
            # Check execution mode
            execution_mode = "native" if self.mode_native_radio.isChecked() else "http"
            
            if execution_mode == "native":
                # Native mode - no HTTP server needed
                self._append_log("[INFO] Native mode - no HTTP server needed")
                self._append_log("[INFO] Tools will execute directly in-process")
                self._append_log("[INFO] Native mode is active. You can use tools in chat without starting a server.")
                self._on_started("native://local")
                return
            
            # HTTP mode - continue with server startup
            # Clean up previous thread if it exists (before creating new one)
            old_thread = self.server_thread
            if old_thread is not None:
                # Disconnect all signals to prevent stale callbacks
                try:
                    # Check if C++ object is still valid
                    if old_thread.isRunning():
                        # Thread still running, can't clean up yet
                        QMessageBox.warning(self, "Error", "Previous server thread is still running. Please wait.")
                        return
                    
                    # Safely disconnect all signals
                    for signal in [old_thread.log_output, old_thread.server_started, 
                                 old_thread.server_stopped, old_thread.error, old_thread.finished]:
                        try:
                            signal.disconnect()
                        except (RuntimeError, TypeError, Exception):
                            pass
                            
                    # Delete old thread
                    old_thread.deleteLater()
                except RuntimeError:
                    # C++ object already deleted, just clear reference
                    pass
                except Exception:
                    # Other error, try to continue
                    pass
                finally:
                    self.server_thread = None
            
            port = int(self.port_edit.text() or "8763")
            token = self.token_edit.text().strip() or "CHANGE_ME"
            root = Path(self.root_edit.text().strip() or ".")
            expose = self.expose_to_lan_check.isChecked()
            host = "0.0.0.0" if expose else "127.0.0.1"

            # Persist config before starting so tool-calling uses the same host/port/token.
            self._save_config_silent()

            # If the selected port is busy, automatically pick the next free port and persist it.
            if not self._is_port_available(host, port):
                alt = self._find_free_port(host, port)
                if alt is None:
                    raise RuntimeError(f"Port {port} is already in use and no free port was found nearby.")
                if alt != port:
                    self._append_log(f"[server] port {port} is in use; switching to {alt}")
                    port = alt
                    self.port_edit.setText(str(port))
                    self._save_config_silent()

            # Keep start lightweight: skip config save/load beyond what's needed
            ctx = ToolContext(
                root=root,
                token=token,
                allow_shell=self.allow_shell_check.isChecked(),
                allow_write=self.allow_write_check.isChecked(),
                allow_git=self.allow_git_check.isChecked(),
                allow_network=self.allow_network_check.isChecked(),
                require_token_for_openai=False,
                backend="mock",
                model_path="",
                backend_url="",
                enabled_tools={},
                require_auth_for_tools_list=expose,
            )

            self.server_thread = ServerThread(host, port, ctx)
            self.server_thread.log_output.connect(self._append_log)
            self.server_thread.server_started.connect(self._on_started)
            self.server_thread.server_stopped.connect(self._on_stopped)
            self.server_thread.error.connect(self._on_error)
            self.server_thread.finished.connect(self.server_thread.deleteLater)

            self.start_stop_btn.setText("Starting...")
            self.start_stop_btn.setEnabled(False)
            self.server_thread.start()
        except Exception as e:
            self._append_log(f"[ERROR] {e}")
            QMessageBox.critical(self, "Error", str(e))
            self.start_stop_btn.setText("Start Server")
            self.start_stop_btn.setEnabled(True)

    def _on_started(self, address: str):
        # Normalize for internal connections
        connection_address = self._normalize_connection_address(address)
        self._server_address = connection_address
        
        # Detect LAN IP if binding to 0.0.0.0
        lan_url = None
        if address.startswith("0.0.0.0:"):
            port = address.split(":")[1]
            lan_ip = self._get_lan_ip()
            if lan_ip:
                lan_url = f"http://{lan_ip}:{port}"
        
        # Update UI
        self.start_stop_btn.setText("⏹ Stop Server")
        self.start_stop_btn.setEnabled(True)
        self.status_label.setText("● Running")
        self.status_label.setStyleSheet("font-weight: bold; color: #4CAF50;")
        
        # Display localhost address (never show 0.0.0.0)
        self.address_label.setText(f"http://{connection_address}")
        
        # Add LAN address display and copy button if available
        if lan_url:
            # Create LAN label if it doesn't exist
            if self.lan_address_label is None:
                self.lan_address_label = QLabel()
                self.lan_address_label.setStyleSheet("color: #4CAF50; background: transparent;")
                # Insert before health button (which is at the end)
                self.status_layout.insertWidget(self.status_layout.count() - 1, self.lan_address_label)
                
                self.copy_lan_btn = QPushButton("📋 Copy LAN URL")
                self.copy_lan_btn.setStyleSheet("""
                    QPushButton {
                        background: rgba(76, 175, 80, 0.6);
                        color: white;
                        border: none;
                        padding: 4px 8px;
                        border-radius: 4px;
                        font-size: 9pt;
                    }
                    QPushButton:hover {
                        background: rgba(76, 175, 80, 0.8);
                    }
                """)
                self.status_layout.insertWidget(self.status_layout.count() - 1, self.copy_lan_btn)
            
            self.lan_address_label.setText(f"LAN: {lan_url}")
            self.lan_address_label.setVisible(True)
            self.copy_lan_btn.setVisible(True)
            # Update lambda to use current lan_url
            
            # Keep a stable slot reference to avoid Qt disconnect warnings.
            try:
                prev = getattr(self, "_copy_lan_slot", None)
                if prev is not None:
                    try:
                        self.copy_lan_btn.clicked.disconnect(prev)
                    except Exception:
                        pass
            except Exception:
                pass

            self._copy_lan_slot = (lambda checked=False, url=lan_url: self._copy_lan_url(url))
            self.copy_lan_btn.clicked.connect(self._copy_lan_slot)
        else:
            # Hide LAN UI if not available
            if self.lan_address_label is not None:
                self.lan_address_label.setVisible(False)
            if self.copy_lan_btn is not None:
                self.copy_lan_btn.setVisible(False)
        
        self.health_btn.setEnabled(True)

    def _on_stopped(self):
        self.start_stop_btn.setText("▶ Start Server")
        self.start_stop_btn.setEnabled(True)
        self.status_label.setText("● Stopped")
        self.status_label.setStyleSheet("font-weight: bold; color: #888;")
        self.address_label.setText("Address: -")
        if self.lan_address_label is not None:
            self.lan_address_label.setVisible(False)
        if self.copy_lan_btn is not None:
            self.copy_lan_btn.setVisible(False)
        self.health_btn.setEnabled(False)

    def _on_error(self, error: str):
        self._append_log(f"[ERROR] {error}")
        self.start_stop_btn.setText("Start Server")
        self.start_stop_btn.setEnabled(True)
        
        # Only show the message box if we aren't in the middle of shutting down the whole app
        main_window = self.window()
        is_shutting_down = False
        if main_window:
            try:
                is_shutting_down = getattr(main_window, "_shutdown_in_progress", False)
            except Exception:
                pass
                
        if not is_shutting_down:
            QMessageBox.warning(self, "Server Error", error)

    def _append_log(self, text: str):
        self.log_text.append(text)
    
    def _get_lan_ip(self) -> Optional[str]:
        """Get local network IPv4 address (not loopback)."""
        try:
            # Connect to a remote address to determine local IP
            # Doesn't actually send data, just determines route
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))  # Google DNS
            ip = s.getsockname()[0]
            s.close()
            # Only return non-loopback addresses
            if ip and ip != "127.0.0.1":
                return ip
            return None
        except Exception:
            return None

    def _is_port_available(self, host: str, port: int) -> bool:
        """Best-effort check whether (host, port) can be bound."""
        s = None
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((host, int(port)))
            return True
        except Exception:
            return False
        finally:
            try:
                if s is not None:
                    s.close()
            except Exception:
                pass

    def _find_free_port(self, host: str, start_port: int, max_tries: int = 50) -> Optional[int]:
        """Find a free port near start_port."""
        p = max(1, int(start_port))
        for _ in range(max_tries):
            if self._is_port_available(host, p):
                return p
            p += 1
        return None
    
    def _normalize_connection_address(self, address: str) -> str:
        """Convert server bind address to client connection address."""
        if address.startswith("0.0.0.0:"):
            return address.replace("0.0.0.0:", "127.0.0.1:", 1)
        return address
    
    def _copy_lan_url(self, url: str):
        """Copy LAN URL to clipboard."""
        clipboard = QApplication.clipboard()
        clipboard.setText(url)
        QMessageBox.information(self, "Copied", f"LAN URL copied to clipboard:\n{url}")
    
    def get_server_connection_info(self) -> Optional[Dict[str, str]]:
        """Get server connection info for MCP connections."""
        if not self._server_address:
            return None  # Server not running
        
        # Get token from UI or config
        token = self.token_edit.text().strip() or "CHANGE_ME"
        if self.config_manager:
            try:
                config = self.config_manager.load()
                token = config.get("token", token)
            except Exception:
                pass
        
        return {
            "url": f"http://{self._server_address}",
            "token": token,
            "name": "Local Tool Server"
        }

    def _check_health(self):
        if not self._server_address:
            return
        
        self.health_btn.setEnabled(False)
        self.health_btn.setText("Checking...")
        
        import threading
        def worker():
            try:
                import urllib.request
                url = f"http://{self._server_address}/health"
                with urllib.request.urlopen(url, timeout=5) as resp:
                    data = resp.read().decode()
                    # Update UI in main thread
                    QTimer.singleShot(0, lambda: self._on_health_check_result(f"[health] {data}"))
            except Exception as e:
                # Update UI in main thread
                QTimer.singleShot(0, lambda: self._on_health_check_result(f"[health] Error: {e}"))
        
        thread = threading.Thread(target=worker, daemon=True)
        thread.start()

    def _on_health_check_result(self, message: str):
        self.health_btn.setEnabled(True)
        self.health_btn.setText("Check Health")
        self._append_log(message)
    
    # ========================================================================
    # LLM Server Management Methods
    # ========================================================================
    
    def _start_llm_server(self):
        """Start the LLM inference server. Idempotent: if /health already ok or loading, just update UI."""
        try:
            from core.llm_server_manager import get_global_server_manager
            import requests

            selected_model_id = self.llm_model_selector.currentData()
            if selected_model_id is None:
                QMessageBox.warning(self, "No Model Selected", "Please select a model from the dropdown.")
                return

            self._last_llm_model_id = selected_model_id
            manager = get_global_server_manager()
            # Lazy config registration: only when user starts a model.
            # This avoids expensive work during app startup/page construction.
            if selected_model_id not in (manager.config.get("models") or {}):
                try:
                    from core.model_onboarding import get_onboarding_service
                    onboarding = get_onboarding_service()
                    ready_rows = onboarding.list_ready_models() or []
                    row = next((r for r in ready_rows if (r.get("model_id") or "") == selected_model_id), None)
                    base_model_path = (row or {}).get("base_model_path") or ""
                    if base_model_path:
                        config_path = Path(__file__).parent.parent.parent / "configs" / "llm_backends.yaml"
                        import yaml
                        with open(config_path, "r", encoding="utf-8") as f:
                            cfg = yaml.safe_load(f) or {}
                        self._ensure_model_in_config(config_path, cfg, selected_model_id, base_model_path)
                        manager._load_config()
                        self._append_log(f"[LLM] Registered READY model '{selected_model_id}' into config.")
                except Exception as e:
                    self._append_log(f"[LLM] Could not auto-register model '{selected_model_id}': {e}")
            url = manager._get_server_url(selected_model_id)

            # Idempotent: if server already up on this port, just refresh UI
            try:
                r = requests.get(f"{url}/health", timeout=2)
                if r.status_code == 200:
                    data = r.json()
                    status = str(data.get("status", "")).lower().strip()
                    reported_model = str(data.get("model", "")).strip()
                    if status in ("ok", "loading") and (reported_model == selected_model_id or reported_model in ("", "local-llm")):
                        self._append_log(f"[LLM] Server already running at {url}, reusing.")
                        QTimer.singleShot(0, lambda: self._on_llm_server_started(url, selected_model_id))
                        self._refresh_active_servers()
                        return
            except Exception:
                pass

            self.llm_start_btn.setEnabled(False)
            self.llm_start_btn.setText("⏳ Starting...")
            self.llm_server_status_label.setText("● Starting...")
            self.llm_server_status_label.setStyleSheet("font-weight: bold; color: #FF9800;")
            self._append_log(f"[LLM] Starting server for model '{selected_model_id}' (may take 2-3 minutes)...")

            import threading
            def worker():
                try:
                    def log_cb(msg):
                        QTimer.singleShot(0, lambda: self._append_log(f"[LLM] {msg}"))
                    manager = get_global_server_manager()
                    url = manager.ensure_server_running(selected_model_id, log_callback=log_cb)
                    QTimer.singleShot(0, lambda: self._on_llm_server_started(url, selected_model_id))
                except Exception as e:
                    import traceback
                    error_details = f"{str(e)}\n\nTraceback:\n{traceback.format_exc()}"
                    QTimer.singleShot(0, lambda: self._on_llm_server_error(error_details))

            thread = threading.Thread(target=worker, daemon=True)
            thread.start()

        except Exception as e:
            self._on_llm_server_error(str(e))
    
    def _stop_llm_server(self):
        """Stop the LLM inference server"""
        try:
            from core.llm_server_manager import get_global_server_manager
            
            # Get selected model ID
            selected_model_id = self.llm_model_selector.currentData()
            if selected_model_id is None:
                return
            
            self.llm_stop_btn.setEnabled(False)
            self._append_log(f"[LLM] Stopping server for model '{selected_model_id}'...")
            
            manager = get_global_server_manager()
            manager.shutdown_server(selected_model_id)
            
            self.llm_server_status_label.setText("● Stopped")
            self.llm_server_status_label.setStyleSheet("font-weight: bold; color: #888;")
            self.llm_model_label.setText("-")
            self.llm_port_label.setText("-")
            self.llm_api_label.setText("-")
            self.llm_start_btn.setEnabled(True)
            self.llm_start_btn.setText("▶ Start")
            self.copy_api_btn.setEnabled(False)
            
            self._append_log("[LLM] Server stopped")
            
        except Exception as e:
            self._append_log(f"[LLM Server] Error stopping: {e}")
            self.llm_stop_btn.setEnabled(True)
    
    def _on_llm_server_started(self, url: str, model_id: str):
        """Called when LLM server successfully starts"""
        self.llm_server_status_label.setText("● Running")
        self.llm_server_status_label.setStyleSheet("font-weight: bold; color: #4CAF50;")
        self.llm_port_label.setText(url.split(':')[-1])
        self.llm_api_label.setText(f"{url}/v1")
        
        # Load model name from config
        try:
            import yaml
            from pathlib import Path
            config_path = Path(__file__).parent.parent.parent / "configs" / "llm_backends.yaml"
            with open(config_path, 'r') as f:
                config = yaml.safe_load(f)
                if model_id in config.get('models', {}):
                    model_path = config['models'][model_id]['base_model']
                    model_name = Path(model_path).name
                    self.llm_model_label.setText(model_name)
                else:
                    self.llm_model_label.setText(model_id)
        except Exception:
            self.llm_model_label.setText(model_id if model_id else "unknown")
        
        self.llm_start_btn.setEnabled(False)
        self.llm_start_btn.setText("● Running")
        self.llm_stop_btn.setEnabled(True)
        self.copy_api_btn.setEnabled(True)
        
        self._append_log(f"[LLM] Server ready at {url}")
        self._append_log(f"[LLM] OpenAI API: {url}/v1")
    
    def _on_llm_server_error(self, error: str):
        """Called when LLM server fails to start"""
        self.llm_server_status_label.setText("● Error")
        self.llm_server_status_label.setStyleSheet("font-weight: bold; color: #f44336;")
        self.llm_start_btn.setEnabled(True)
        self.llm_start_btn.setText("▶ Start")
        
        # Log full error
        self._append_log(f"[LLM] ❌ Error starting server:")
        error_lines = error.split('\n')
        for line in error_lines:
            if line.strip():
                self._append_log(f"[LLM]   {line}")
        
        # Show error dialog with action to re-onboard when not truly READY/BROKEN
        low = (error or "").lower()
        needs_onboarding = any(
            m in low for m in [
                "please re-onboard/repair",
                "re-onboard/repair",
                "not ready for chat",
                "has not been onboarded yet",
                "marked broken",
            ]
        )

        msg = QMessageBox(self)
        msg.setWindowTitle("LLM Server Error")
        msg.setIcon(QMessageBox.Warning)
        msg.setText("Failed to start LLM server")
        if needs_onboarding:
            msg.setInformativeText("This model needs onboarding/repair before it can be used.")
        msg.setDetailedText(error)

        btn_reonboard = None
        if needs_onboarding:
            btn_reonboard = msg.addButton("Re-onboard model", QMessageBox.AcceptRole)
            msg.addButton("Open Models page", QMessageBox.ActionRole)
        msg.addButton(QMessageBox.Ok)

        msg.exec()

        if needs_onboarding and msg.clickedButton() == btn_reonboard:
            try:
                parent = self.parent()
                model_id = getattr(self, "_last_llm_model_id", None)
                if parent and model_id and hasattr(parent, "prompt_reonboard_server_model"):
                    parent.prompt_reonboard_server_model(model_id)
            except Exception:
                pass
    
    def _update_llm_server_status(self):
        """Periodically check LLM server status. Health-driven: always probe /health for selected model's port."""
        try:
            from core.llm_server_manager import get_global_server_manager
            import requests
            from pathlib import Path

            selected_model_id = self.llm_model_selector.currentData()
            if selected_model_id is None:
                return

            manager = get_global_server_manager()
            url = manager._get_server_url(selected_model_id)
            port = url.split(":")[-1] if ":" in url else ""

            try:
                response = requests.get(f"{url}/health", timeout=1)
                if response.status_code == 200:
                    data = response.json()
                    status = str(data.get("status", "")).lower().strip()
                    reported_model = str(data.get("model", "")).strip()

                    # Port occupied by a different model: show state, do not attempt restart
                    if reported_model and reported_model not in (selected_model_id, "local-llm", ""):
                        self.llm_server_status_label.setText(f"● Port in use by {reported_model}")
                        self.llm_server_status_label.setStyleSheet("font-weight: bold; color: #FF9800;")
                        self.llm_port_label.setText(port)
                        self.llm_api_label.setText(f"{url}/v1")
                        self.llm_model_label.setText(reported_model)
                        self.llm_start_btn.setEnabled(False)
                        self.llm_stop_btn.setEnabled(True)
                        self.copy_api_btn.setEnabled(True)
                        return

                    if status == "ok":
                        self.llm_server_status_label.setText("● Running")
                        self.llm_server_status_label.setStyleSheet("font-weight: bold; color: #4CAF50;")
                        self.llm_port_label.setText(port)
                        self.llm_api_label.setText(f"{url}/v1")
                        try:
                            model_cfg = manager.config["models"][selected_model_id]
                            base_model = model_cfg["base_model"]
                            self.llm_model_label.setText(Path(base_model).name)
                        except Exception:
                            self.llm_model_label.setText(reported_model or selected_model_id)
                        self.llm_start_btn.setEnabled(False)
                        self.llm_start_btn.setText("● Running")
                        self.llm_stop_btn.setEnabled(True)
                        self.copy_api_btn.setEnabled(True)
                        return
                    if status == "loading":
                        self.llm_server_status_label.setText("● Loading...")
                        self.llm_server_status_label.setStyleSheet("font-weight: bold; color: #FF9800;")
                        self.llm_port_label.setText(port)
                        self.llm_api_label.setText(f"{url}/v1")
                        self.llm_model_label.setText(reported_model or selected_model_id)
                        self.llm_start_btn.setEnabled(False)
                        self.llm_stop_btn.setEnabled(True)
                        self.copy_api_btn.setEnabled(True)
                        return
            except Exception:
                pass

            # No healthy response: show Not running and allow Start
            if not self.llm_start_btn.isEnabled():
                self.llm_server_status_label.setText("● Not running")
                self.llm_server_status_label.setStyleSheet("font-weight: bold; color: #888;")
                self.llm_model_label.setText("-")
                self.llm_port_label.setText("-")
                self.llm_api_label.setText("-")
                self.llm_start_btn.setEnabled(True)
                self.llm_start_btn.setText("▶ Start")
                self.llm_stop_btn.setEnabled(False)
                self.copy_api_btn.setEnabled(False)

        except Exception:
            pass

    def _refresh_active_servers(self):
        """Refresh Active inference servers list from StateStore + /health probes.
        Also probes ports from llm_backends.yaml so servers that are running but not in StateStore (e.g. stale state) still appear."""
        if not hasattr(self, "active_servers_list"):
            return
        try:
            from core.state_store import get_state_store
            import requests
            import yaml

            store = get_state_store()
            candidates = [s for s in store.list_servers() if (s.get("status") or "").upper() in ("STARTING", "RUNNING")]
            results_by_port = {}
            for s in candidates:
                model_id = s.get("model_id") or ""
                port = s.get("port") or 0
                pid = s.get("pid")
                if not port:
                    continue
                port = int(port)
                url = f"http://127.0.0.1:{port}/health"
                try:
                    r = requests.get(url, timeout=1)
                    if r.status_code == 200:
                        data = r.json()
                        status = str(data.get("status", "")).lower().strip()
                        model_from_health = str(data.get("model", "")).strip() or model_id
                        results_by_port[port] = {
                            "model_id": model_id,
                            "model_from_health": model_from_health,
                            "status": status,
                            "port": port,
                            "pid": pid,
                        }
                except Exception:
                    pass

            # Probe ports from config so running servers appear even if StateStore is missing/stale
            config_path = Path(__file__).parent.parent.parent / "configs" / "llm_backends.yaml"
            if config_path.exists():
                try:
                    with open(config_path, "r", encoding="utf-8") as f:
                        config = yaml.safe_load(f) or {}
                    for model_id, model_cfg in (config.get("models") or {}).items():
                        if not isinstance(model_cfg, dict):
                            continue
                        port = model_cfg.get("port")
                        if port is None or int(port) in results_by_port:
                            continue
                        port = int(port)
                        url = f"http://127.0.0.1:{port}/health"
                        try:
                            r = requests.get(url, timeout=1)
                            if r.status_code == 200:
                                data = r.json()
                                status = str(data.get("status", "")).lower().strip()
                                model_from_health = str(data.get("model", "")).strip() or model_id
                                results_by_port[port] = {
                                    "model_id": model_id,
                                    "model_from_health": model_from_health,
                                    "status": status,
                                    "port": port,
                                    "pid": None,
                                }
                        except Exception:
                            pass
                except Exception:
                    pass

            results = list(results_by_port.values())
            self.active_servers_list.blockSignals(True)
            self.active_servers_list.clear()
            for r in results:
                status_str = r["status"]
                if status_str == "ok":
                    status_str = "Running"
                elif status_str == "loading":
                    status_str = "Loading"
                else:
                    status_str = status_str or "Unknown"
                label = f"{r['model_from_health']} — port {r['port']} ({status_str})"
                item = QListWidgetItem(label)
                item.setData(Qt.UserRole, r)
                self.active_servers_list.addItem(item)
            self.active_servers_list.blockSignals(False)
        except Exception:
            pass

    def _on_active_server_selected(self):
        """When user selects an active server, switch model dropdown and update API/port labels."""
        items = self.active_servers_list.selectedItems()
        if not items:
            return
        try:
            r = items[0].data(Qt.UserRole)
            if not r or not isinstance(r, dict):
                return
            model_id = r.get("model_id")
            port = r.get("port")
            status = (r.get("status") or "").lower()
            if not model_id and port:
                model_id = r.get("model_from_health") or ""
            # Try to set model selector to this model_id if it exists in dropdown
            for i in range(self.llm_model_selector.count()):
                if self.llm_model_selector.itemData(i) == model_id:
                    self.llm_model_selector.setCurrentIndex(i)
                    break
            # Update API/port labels from this server
            if port:
                url = f"http://127.0.0.1:{port}"
                self.llm_port_label.setText(str(port))
                self.llm_api_label.setText(f"{url}/v1")
                if status == "ok":
                    self.llm_server_status_label.setText("● Running")
                    self.llm_server_status_label.setStyleSheet("font-weight: bold; color: #4CAF50;")
                    self.llm_model_label.setText(r.get("model_from_health") or model_id or "-")
                    self.llm_start_btn.setEnabled(False)
                    self.llm_start_btn.setText("● Running")
                    self.llm_stop_btn.setEnabled(True)
                    self.copy_api_btn.setEnabled(True)
                elif status == "loading":
                    self.llm_server_status_label.setText("● Loading...")
                    self.llm_server_status_label.setStyleSheet("font-weight: bold; color: #FF9800;")
                    self.llm_model_label.setText(r.get("model_from_health") or model_id or "-")
                    self.llm_start_btn.setEnabled(False)
                    self.llm_stop_btn.setEnabled(True)
                    self.copy_api_btn.setEnabled(True)
        except Exception:
            pass

    def _stop_selected_active_server(self):
        """Stop the server selected in the Active inference servers list (by model_id or by port)."""
        items = self.active_servers_list.selectedItems()
        if not items:
            self._append_log("[LLM] No server selected. Select a row in Active inference servers, then click Stop selected.")
            return
        try:
            from core.llm_server_manager import get_global_server_manager

            r = items[0].data(Qt.UserRole)
            if not r or not isinstance(r, dict):
                self._append_log("[LLM] Selected row has no data.")
                return
            model_id = (r.get("model_id") or "").strip() or (r.get("model_from_health") or "").strip()
            port = r.get("port") or 0
            pid = r.get("pid")

            manager = get_global_server_manager()

            # Prefer shutdown by model_id when we have one that matches a known config
            if model_id:
                try:
                    manager.shutdown_server(model_id)
                    self._append_log(f"[LLM] Stopped server for model '{model_id}'.")
                except Exception as e:
                    self._append_log(f"[LLM] Stop by model failed ({e}), trying by port {port}...")
                    if port and manager.shutdown_server_by_port(port):
                        self._append_log(f"[LLM] Stopped server on port {port}.")
                    else:
                        self._append_log(f"[LLM] Could not stop server (port {port}).")
            elif port:
                if manager.shutdown_server_by_port(port):
                    self._append_log(f"[LLM] Stopped server on port {port}.")
                else:
                    self._append_log(f"[LLM] Could not stop server on port {port}.")
            else:
                self._append_log("[LLM] No model or port for selected server.")

            self._refresh_active_servers()
            # Refresh status line in case the stopped server was the one shown
            QTimer.singleShot(0, self._update_llm_server_status)
        except Exception as e:
            self._append_log(f"[LLM] Error stopping selected server: {e}")
    
    def _copy_api_url(self):
        """Copy OpenAI-compatible API URL to clipboard"""
        try:
            from core.llm_server_manager import get_global_server_manager
            
            # Get selected model ID
            selected_model_id = self.llm_model_selector.currentData()
            if selected_model_id is None:
                QMessageBox.warning(self, "Error", "No model selected.")
                return
            
            manager = get_global_server_manager()
            url = manager._get_server_url(selected_model_id)
            api_url = f"{url}/v1"
            
            clipboard = QApplication.clipboard()
            clipboard.setText(api_url)
            
            QMessageBox.information(
                self,
                "API URL Copied",
                f"OpenAI-compatible API URL copied to clipboard:\n\n"
                f"{api_url}\n\n"
                f"Use this in Cursor, VS Code, Continue, etc.\n"
                f"Model name: {selected_model_id}\n"
                f"API Key: (any text works)"
            )
        except Exception as e:
            QMessageBox.warning(self, "Error", f"Failed to copy URL: {e}")
    
    def _copy_model_name(self):
        """Copy model ID to clipboard for Cursor Model field"""
        selected_model_id = self.llm_model_selector.currentData()
        if selected_model_id is None:
            QMessageBox.warning(self, "Error", "No model selected.")
            return
        clipboard = QApplication.clipboard()
        clipboard.setText(selected_model_id)
        QMessageBox.information(self, "Model Name Copied", f"Model ID copied to clipboard:\n{selected_model_id}")
    
    def _show_llm_api_help(self):
        """Show help dialog for using LLM API with external tools"""
        selected_model_id = self.llm_model_selector.currentData() if hasattr(self, 'llm_model_selector') else None
        model_hint = f"<code>{selected_model_id}</code>" if selected_model_id else "the selected model ID (dropdown above, or from <code>GET .../v1/models</code>)"
        help_text = f"""
<h3>Using Your Local LLM with External Tools</h3>

<p><b>Your LLM server provides an OpenAI-compatible API that works with:</b></p>
<ul>
  <li>Cursor IDE</li>
  <li>VS Code + Continue extension</li>
  <li>Open-WebUI</li>
  <li>LibreChat</li>
  <li>Any tool that supports OpenAI API</li>
</ul>

<h4>Quick Setup for Cursor:</h4>
<ol>
  <li><b>Start the LLM Server</b> (click "▶ Start" above)</li>
  <li><b>Copy the API URL</b> (click "Copy API URL" button)</li>
  <li><b>Open Cursor Settings</b> (Ctrl+,)</li>
  <li><b>Find OpenAI API settings</b></li>
  <li><b>Set Base URL</b> to the copied URL (e.g. <code>http://127.0.0.1:10500/v1</code>)</li>
  <li><b>Set API Key</b> to any text (e.g. "sk-local")</li>
  <li><b>Set Model</b> to {model_hint}</li>
</ol>

<h4>Benefits:</h4>
<ul>
  <li>✅ <b>Privacy</b> - Code never leaves your machine</li>
  <li>✅ <b>No costs</b> - Use your local GPU for free</li>
  <li>✅ <b>Offline</b> - Works without internet</li>
  <li>✅ <b>Fast</b> - No network latency</li>
</ul>

<p><b>📖 Full Documentation:</b><br>
See <code>OPENAI_COMPATIBLE_API.md</code> in the project root for detailed setup instructions.</p>
        """
        
        msg = QMessageBox(self)
        msg.setWindowTitle("LLM API Usage Guide")
        msg.setTextFormat(Qt.RichText)
        msg.setText(help_text)
        msg.setIcon(QMessageBox.Information)
        msg.exec()
