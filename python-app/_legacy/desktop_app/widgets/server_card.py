"""
Server card widget for displaying MCP servers in the catalog.
"""
from __future__ import annotations

from typing import Callable, Optional

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QFrame, QVBoxLayout, QHBoxLayout, QLabel, QPushButton
)
from PySide6.QtGui import QFont


class ServerCard(QFrame):
    """Card widget for displaying an MCP server in the catalog."""
    
    install_clicked = Signal(str)  # Emits server_id
    
    def __init__(self, server_data: dict, parent=None):
        super().__init__(parent)
        self.server_data = server_data
        self.server_id = server_data.get("id") or server_data.get("name", "")
        self._setup_ui()
    
    def _setup_ui(self):
        """Build the card UI."""
        self.setFrameShape(QFrame.Box)
        self.setStyleSheet("""
            ServerCard {
                background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
                    stop:0 rgba(30, 30, 40, 0.9), stop:1 rgba(20, 20, 30, 0.9));
                border: 1px solid rgba(102, 126, 234, 0.3);
                border-radius: 8px;
                padding: 12px;
            }
            ServerCard:hover {
                border: 1px solid rgba(102, 126, 234, 0.6);
                background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
                    stop:0 rgba(40, 40, 50, 0.9), stop:1 rgba(30, 30, 40, 0.9));
            }
        """)
        
        layout = QVBoxLayout(self)
        layout.setSpacing(8)
        layout.setContentsMargins(12, 12, 12, 12)
        
        # Top row: Icon + Name
        top_row = QHBoxLayout()
        top_row.setSpacing(8)
        
        # Icon (use first emoji or default)
        icon_text = self.server_data.get("icon") or "🔌"
        icon_label = QLabel(icon_text)
        icon_label.setFixedSize(32, 32)
        icon_label.setAlignment(Qt.AlignCenter)
        icon_label.setStyleSheet("font-size: 20pt; background: transparent;")
        top_row.addWidget(icon_label)
        
        # Name (bold)
        name_label = QLabel(self.server_data.get("name", "Unknown Server"))
        name_font = QFont()
        name_font.setBold(True)
        name_font.setPointSize(12)
        name_label.setFont(name_font)
        name_label.setStyleSheet("color: white; background: transparent;")
        top_row.addWidget(name_label)
        
        top_row.addStretch()
        layout.addLayout(top_row)
        
        # Description
        desc = self.server_data.get("description", "No description available.")
        desc_label = QLabel(desc)
        desc_label.setWordWrap(True)
        desc_label.setStyleSheet("color: #cccccc; background: transparent; font-size: 10pt;")
        layout.addWidget(desc_label)
        
        # Badges row: Categories/Tags
        badges_row = QHBoxLayout()
        badges_row.setSpacing(6)
        
        categories = self.server_data.get("categories", []) or self.server_data.get("tags", [])
        for cat in categories[:3]:  # Show max 3 categories
            cat_badge = QLabel(cat)
            cat_badge.setStyleSheet("""
                QLabel {
                    background: rgba(102, 126, 234, 0.3);
                    color: white;
                    padding: 2px 8px;
                    border-radius: 4px;
                    font-size: 9pt;
                }
            """)
            badges_row.addWidget(cat_badge)
        
        badges_row.addStretch()
        layout.addLayout(badges_row)
        
        # Info row: Publisher, Install method
        info_row = QHBoxLayout()
        info_row.setSpacing(12)
        
        publisher = self.server_data.get("publisher", "")
        if publisher:
            pub_label = QLabel(f"by {publisher}")
            pub_label.setStyleSheet("color: #888; font-size: 9pt; background: transparent;")
            info_row.addWidget(pub_label)
        
        install_method = self.server_data.get("install_method", "unknown")
        method_label = QLabel(f"📦 {install_method}")
        method_label.setStyleSheet("color: #888; font-size: 9pt; background: transparent;")
        info_row.addWidget(method_label)
        
        info_row.addStretch()
        layout.addLayout(info_row)
        
        # Install button
        install_btn = QPushButton("📥 Install")
        install_btn.setStyleSheet("""
            QPushButton {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 rgba(102, 126, 234, 0.8), stop:1 rgba(76, 175, 80, 0.8));
                color: white;
                border: none;
                padding: 8px;
                border-radius: 4px;
                font-weight: bold;
            }
            QPushButton:hover {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 rgba(102, 126, 234, 1.0), stop:1 rgba(76, 175, 80, 1.0));
            }
        """)
        install_btn.clicked.connect(lambda: self.install_clicked.emit(self.server_id))
        layout.addWidget(install_btn)
