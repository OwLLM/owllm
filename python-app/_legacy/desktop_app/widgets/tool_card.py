"""
Tool card widget for displaying tools in a card-based UI.
"""
from __future__ import annotations

from typing import Callable, Optional

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QFrame, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QCheckBox, QSizePolicy
)
from PySide6.QtGui import QFont


class ToolCard(QFrame):
    """Card widget for displaying a tool with icon, badges, and controls."""
    
    run_clicked = Signal(str)  # Emits tool name
    enabled_changed = Signal(str, bool)  # Emits tool name and enabled state
    
    # Icon mapping (simple text icons for now)
    ICON_MAP = {
        "folder": "📁",
        "file": "📄",
        "file-edit": "✏️",
        "git": "🔀",
        "terminal": "💻",
        "default": "🔧",
    }
    
    # Danger level colors
    DANGER_COLORS = {
        "safe": "#4CAF50",
        "warning": "#FF9800",
        "dangerous": "#F44336",
    }
    
    def __init__(self, tool_data: dict, parent=None):
        super().__init__(parent)
        self.tool_data = tool_data
        self.tool_name = tool_data.get("name", "")
        self._setup_ui()
    
    def _setup_ui(self):
        """Build the card UI with a modern, polished design."""
        self.setFrameShape(QFrame.NoFrame)
        self.setMinimumHeight(160)
        self.setMaximumHeight(200)
        # Cards should fit within their column - no max width constraint, let layout handle it
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.setStyleSheet("""
            ToolCard {
                background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
                    stop:0 rgba(40, 40, 55, 0.6), stop:1 rgba(25, 25, 35, 0.6));
                border: 1px solid rgba(102, 126, 234, 0.2);
                border-radius: 12px;
                padding: 0px;
            }
            ToolCard:hover {
                background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
                    stop:0 rgba(60, 60, 80, 0.8), stop:1 rgba(40, 40, 55, 0.8));
                border: 1px solid rgba(102, 126, 234, 0.5);
            }
        """)
        
        layout = QVBoxLayout(self)
        layout.setSpacing(10)
        layout.setContentsMargins(18, 16, 18, 16)
        
        # Top row: Icon + Name + Enable toggle
        top_row = QHBoxLayout()
        top_row.setSpacing(12)
        
        # Icon with background
        icon_key = self.tool_data.get("icon_key") or "default"
        icon_text = self.ICON_MAP.get(icon_key, self.ICON_MAP["default"])
        icon_label = QLabel(icon_text)
        icon_label.setFixedSize(40, 40)
        icon_label.setAlignment(Qt.AlignCenter)
        icon_label.setStyleSheet("""
            font-size: 20pt; 
            background: rgba(102, 126, 234, 0.15);
            border-radius: 8px;
        """)
        top_row.addWidget(icon_label)
        
        # Name
        name_label = QLabel(self.tool_data.get("name", ""))
        name_label.setWordWrap(True)
        name_label.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        name_label.setStyleSheet("""
            color: #ffffff; 
            font-size: 14pt; 
            font-weight: 700; 
            background: transparent;
            letter-spacing: 0.3px;
        """)
        top_row.addWidget(name_label, 1)
        
        top_row.addStretch()
        
        # Enable toggle
        self.enable_check = QCheckBox("Enable")
        self.enable_check.setChecked(self.tool_data.get("enabled", True))
        self.enable_check.stateChanged.connect(self._on_enable_changed)
        self.enable_check.setStyleSheet("""
            QCheckBox { 
                color: #b0b0b0; 
                font-size: 10pt; 
                background: transparent;
                font-weight: 500;
            }
            QCheckBox::indicator {
                width: 18px;
                height: 18px;
                border-radius: 4px;
                border: 2px solid rgba(102, 126, 234, 0.5);
                background: transparent;
            }
            QCheckBox::indicator:checked {
                background: rgba(102, 126, 234, 0.8);
                border-color: #667eea;
            }
        """)
        top_row.addWidget(self.enable_check)
        
        layout.addLayout(top_row)
        
        # Description
        desc_label = QLabel(self.tool_data.get("description", ""))
        desc_label.setWordWrap(True)
        desc_label.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        desc_label.setStyleSheet("""
            color: #b0b0b0; 
            background: transparent; 
            font-size: 10pt;
            line-height: 1.4;
        """)
        layout.addWidget(desc_label)
        
        # Badges row
        badges_row = QHBoxLayout()
        badges_row.setSpacing(8)
        
        # Source server badge
        source_server = self.tool_data.get("source_server")
        if source_server:
            server_badge = QLabel(f"🔌 {source_server}")
            server_badge.setStyleSheet("""
                background: rgba(156, 39, 176, 0.2);
                color: #ce93d8;
                padding: 4px 10px;
                border-radius: 8px;
                font-size: 9pt;
                font-weight: 600;
                border: 1px solid rgba(156, 39, 176, 0.3);
            """)
            badges_row.addWidget(server_badge)
        
        # Category badge
        category = self.tool_data.get("category", "General")
        cat_badge = QLabel(category)
        cat_badge.setStyleSheet("""
            background: rgba(102, 126, 234, 0.2);
            color: #9fa8ff;
            padding: 4px 10px;
            border-radius: 8px;
            font-size: 9pt;
            font-weight: 500;
            border: 1px solid rgba(102, 126, 234, 0.3);
        """)
        badges_row.addWidget(cat_badge)
        
        # Danger level badge
        danger_level = self.tool_data.get("danger_level", "safe")
        danger_color = self.DANGER_COLORS.get(danger_level, "#888")
        danger_badge = QLabel(danger_level.upper())
        danger_badge.setStyleSheet(f"""
            background: {danger_color}33;
            color: {danger_color};
            padding: 4px 10px;
            border-radius: 8px;
            font-size: 9pt;
            font-weight: 600;
            border: 1px solid {danger_color}66;
        """)
        badges_row.addWidget(danger_badge)
        
        badges_row.addStretch()
        layout.addLayout(badges_row)
        
        # Run button
        run_btn = QPushButton("▶ Run Tool")
        run_btn.setCursor(Qt.PointingHandCursor)
        run_btn.setStyleSheet("""
            QPushButton {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 rgba(102, 126, 234, 0.3), stop:1 rgba(118, 75, 162, 0.3));
                color: #ffffff;
                border: 1px solid rgba(102, 126, 234, 0.4);
                padding: 10px;
                border-radius: 8px;
                font-weight: 600;
                font-size: 10pt;
                margin-top: 8px;
            }
            QPushButton:hover {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 rgba(102, 126, 234, 0.6), stop:1 rgba(118, 75, 162, 0.6));
                border: 1px solid rgba(102, 126, 234, 0.8);
            }
            QPushButton:pressed {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 rgba(80, 100, 200, 0.5), stop:1 rgba(100, 60, 140, 0.5));
            }
        """)
        run_btn.clicked.connect(lambda: self.run_clicked.emit(self.tool_name))
        layout.addWidget(run_btn)
    
    def _on_enable_changed(self, state: int):
        """Handle enable checkbox change."""
        enabled = state == Qt.Checked
        self.enabled_changed.emit(self.tool_name, enabled)
    
    def set_enabled(self, enabled: bool):
        """Set enabled state without emitting signal."""
        self.enable_check.blockSignals(True)
        self.enable_check.setChecked(enabled)
        self.enable_check.blockSignals(False)
