"""
Connection card widget for displaying installed MCP servers.
"""
from __future__ import annotations

from typing import Callable, Optional

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QFrame, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QTextEdit
)
from PySide6.QtGui import QFont


class ConnectionCard(QFrame):
    """Card widget for displaying an installed MCP server."""
    
    configure_clicked = Signal(str)  # Emits server_id
    start_clicked = Signal(str)  # Emits server_id
    stop_clicked = Signal(str)  # Emits server_id
    connect_clicked = Signal(str)  # Emits server_id
    disconnect_clicked = Signal(str)  # Emits server_id
    
    def __init__(self, server_data: dict, parent=None):
        super().__init__(parent)
        self.server_data = server_data
        self.server_id = server_data.get("server_id", "")
        self._setup_ui()
        self._update_status()
    
    def _setup_ui(self):
        """Build the card UI."""
        self.setFrameShape(QFrame.Box)
        self.setStyleSheet("""
            ConnectionCard {
                background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
                    stop:0 rgba(30, 30, 40, 0.9), stop:1 rgba(20, 20, 30, 0.9));
                border: 1px solid rgba(102, 126, 234, 0.3);
                border-radius: 8px;
                padding: 12px;
            }
        """)
        
        layout = QVBoxLayout(self)
        layout.setSpacing(8)
        layout.setContentsMargins(12, 12, 12, 12)
        
        # Top row: Name + Status badge
        top_row = QHBoxLayout()
        top_row.setSpacing(8)
        
        server_name = self.server_data.get("name") or self.server_data.get("server_id", self.server_id)
        name_label = QLabel(server_name)
        name_font = QFont()
        name_font.setBold(True)
        name_font.setPointSize(12)
        name_label.setFont(name_font)
        name_label.setStyleSheet("color: white; background: transparent;")
        top_row.addWidget(name_label)
        
        top_row.addStretch()
        
        # Status badge
        self.status_badge = QLabel()
        self.status_badge.setStyleSheet("""
            QLabel {
                padding: 4px 12px;
                border-radius: 4px;
                font-size: 9pt;
                font-weight: bold;
            }
        """)
        top_row.addWidget(self.status_badge)
        
        layout.addLayout(top_row)
        
        # Info row: Install method, path
        info_row = QHBoxLayout()
        install_method = self.server_data.get("install_method", "unknown")
        method_label = QLabel(f"Method: {install_method}")
        method_label.setStyleSheet("color: #888; font-size: 9pt; background: transparent;")
        info_row.addWidget(method_label)
        
        info_row.addStretch()
        layout.addLayout(info_row)
        
        # Buttons row
        buttons_row = QHBoxLayout()
        buttons_row.setSpacing(6)
        
        self.configure_btn = QPushButton("⚙️ Configure")
        self.configure_btn.setStyleSheet("""
            QPushButton {
                background: rgba(102, 126, 234, 0.6);
                color: white;
                border: none;
                padding: 6px 12px;
                border-radius: 4px;
                font-size: 9pt;
            }
            QPushButton:hover {
                background: rgba(102, 126, 234, 0.8);
            }
        """)
        self.configure_btn.clicked.connect(lambda: self.configure_clicked.emit(self.server_id))
        buttons_row.addWidget(self.configure_btn)
        
        self.start_btn = QPushButton("▶ Start")
        self.start_btn.setStyleSheet("""
            QPushButton {
                background: rgba(76, 175, 80, 0.6);
                color: white;
                border: none;
                padding: 6px 12px;
                border-radius: 4px;
                font-size: 9pt;
            }
            QPushButton:hover {
                background: rgba(76, 175, 80, 0.8);
            }
        """)
        self.start_btn.clicked.connect(lambda: self.start_clicked.emit(self.server_id))
        buttons_row.addWidget(self.start_btn)
        
        self.stop_btn = QPushButton("⏹ Stop")
        self.stop_btn.setStyleSheet("""
            QPushButton {
                background: rgba(244, 67, 54, 0.6);
                color: white;
                border: none;
                padding: 6px 12px;
                border-radius: 4px;
                font-size: 9pt;
            }
            QPushButton:hover {
                background: rgba(244, 67, 54, 0.8);
            }
        """)
        self.stop_btn.clicked.connect(lambda: self.stop_clicked.emit(self.server_id))
        buttons_row.addWidget(self.stop_btn)
        
        self.connect_btn = QPushButton("🔗 Connect")
        self.connect_btn.setStyleSheet("""
            QPushButton {
                background: rgba(102, 126, 234, 0.6);
                color: white;
                border: none;
                padding: 6px 12px;
                border-radius: 4px;
                font-size: 9pt;
            }
            QPushButton:hover {
                background: rgba(102, 126, 234, 0.8);
            }
        """)
        self.connect_btn.clicked.connect(lambda: self.connect_clicked.emit(self.server_id))
        buttons_row.addWidget(self.connect_btn)
        
        self.disconnect_btn = QPushButton("🔌 Disconnect")
        self.disconnect_btn.setStyleSheet("""
            QPushButton {
                background: rgba(158, 158, 158, 0.6);
                color: white;
                border: none;
                padding: 6px 12px;
                border-radius: 4px;
                font-size: 9pt;
            }
            QPushButton:hover {
                background: rgba(158, 158, 158, 0.8);
            }
        """)
        self.disconnect_btn.clicked.connect(lambda: self.disconnect_clicked.emit(self.server_id))
        buttons_row.addWidget(self.disconnect_btn)
        
        buttons_row.addStretch()
        layout.addLayout(buttons_row)
        
        # Logs area (collapsible)
        self.logs_text = QTextEdit()
        self.logs_text.setReadOnly(True)
        self.logs_text.setMaximumHeight(100)
        self.logs_text.setStyleSheet("""
            QTextEdit {
                background: rgba(10, 10, 15, 0.9);
                color: #00ff00;
                font-family: 'Consolas', 'Courier New', monospace;
                font-size: 9pt;
                border: 1px solid rgba(102, 126, 234, 0.3);
                border-radius: 4px;
                padding: 8px;
            }
        """)
        self.logs_text.setVisible(False)
        layout.addWidget(self.logs_text)
    
    def _update_status(self):
        """Update status badge and button states."""
        status = self.server_data.get("status", "installed")
        
        status_colors = {
            "installed": ("#9E9E9E", "Installed"),
            "configured": ("#FF9800", "Configured"),
            "running": ("#4CAF50", "Running"),
            "connected": ("#2196F3", "Connected"),
        }
        
        color, text = status_colors.get(status, ("#888", status.title()))
        self.status_badge.setText(text)
        self.status_badge.setStyleSheet(f"""
            QLabel {{
                background: {color};
                color: white;
                padding: 4px 12px;
                border-radius: 4px;
                font-size: 9pt;
                font-weight: bold;
            }}
        """)
        
        # Update button states
        install_method = self.server_data.get("install_method", "")
        
        # For "local" servers, hide Start/Stop buttons (managed from Server page)
        if install_method == "local":
            self.start_btn.setVisible(False)
            self.stop_btn.setVisible(False)
            # Connect is enabled if server is configured or running
            # (local servers are started from Server page, so we can connect once configured)
            self.connect_btn.setEnabled(status in ["configured", "running", "installed"])
        else:
            self.start_btn.setVisible(True)
            self.stop_btn.setVisible(True)
            self.start_btn.setEnabled(status in ["installed", "configured", "stopped"])
            self.stop_btn.setEnabled(status == "running")
            self.connect_btn.setEnabled(status == "running")
        
        self.disconnect_btn.setEnabled(status == "connected")
    
    def update_server_data(self, server_data: dict):
        """Update server data and refresh UI."""
        self.server_data = server_data
        self._update_status()
    
    def append_log(self, text: str):
        """Append text to logs."""
        self.logs_text.append(text)
        self.logs_text.setVisible(True)
    
    def clear_logs(self):
        """Clear logs."""
        self.logs_text.clear()
        self.logs_text.setVisible(False)
