"""
Tool approval dialog for user confirmation before executing tools.
"""
from __future__ import annotations

import json
from typing import Optional

from PySide6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QCheckBox, QFrame, QTextEdit
)
from PySide6.QtCore import Qt
from PySide6.QtGui import QFont


class ToolApprovalDialog(QDialog):
    """Dialog for requesting user approval to execute a tool"""
    
    # Danger level colors
    DANGER_COLORS = {
        "safe": "#4CAF50",
        "warning": "#FF9800",
        "dangerous": "#F44336",
        "unknown": "#888888"
    }
    
    def __init__(self, tool_name: str, arguments: dict, danger_level: str = "unknown", parent=None):
        super().__init__(parent)
        self.tool_name = tool_name
        self.arguments = arguments
        self.danger_level = danger_level
        self.approved = False
        self.remember = False
        
        self._setup_ui()
    
    def _setup_ui(self):
        """Setup the dialog UI"""
        self.setWindowTitle("Tool Execution Approval")
        self.setMinimumWidth(500)
        self.setMinimumHeight(300)
        
        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        layout.setContentsMargins(20, 20, 20, 20)
        
        # Title with danger level
        title_layout = QHBoxLayout()
        
        title = QLabel(f"Execute Tool: {self.tool_name}")
        title_font = QFont()
        title_font.setPointSize(14)
        title_font.setBold(True)
        title.setFont(title_font)
        title.setStyleSheet("color: white;")
        title_layout.addWidget(title)
        
        title_layout.addStretch()
        
        # Danger level badge
        danger_color = self.DANGER_COLORS.get(self.danger_level, self.DANGER_COLORS["unknown"])
        danger_badge = QLabel(self.danger_level.upper())
        danger_badge.setStyleSheet(f"""
            QLabel {{
                background: {danger_color};
                color: white;
                padding: 4px 12px;
                border-radius: 4px;
                font-weight: bold;
                font-size: 10pt;
            }}
        """)
        title_layout.addWidget(danger_badge)
        
        layout.addLayout(title_layout)
        
        # Warning message for dangerous tools
        if self.danger_level == "dangerous":
            warning_frame = QFrame()
            warning_frame.setStyleSheet("""
                QFrame {
                    background: rgba(244, 67, 54, 0.2);
                    border: 2px solid #F44336;
                    border-radius: 6px;
                    padding: 12px;
                }
            """)
            warning_layout = QVBoxLayout(warning_frame)
            
            warning_label = QLabel("⚠️ WARNING: This tool can execute arbitrary commands on your system!")
            warning_label.setStyleSheet("color: #F44336; font-weight: bold; font-size: 11pt;")
            warning_label.setWordWrap(True)
            warning_layout.addWidget(warning_label)
            
            layout.addWidget(warning_frame)
        
        # Arguments section
        args_label = QLabel("Arguments:")
        args_label.setStyleSheet("color: white; font-weight: bold; font-size: 11pt;")
        layout.addWidget(args_label)
        
        args_frame = QFrame()
        args_frame.setStyleSheet("""
            QFrame {
                background: rgba(30, 30, 40, 0.8);
                border: 1px solid rgba(102, 126, 234, 0.3);
                border-radius: 6px;
                padding: 10px;
            }
        """)
        args_layout = QVBoxLayout(args_frame)
        
        if self.arguments:
            args_text = QTextEdit()
            args_text.setReadOnly(True)
            args_text.setMaximumHeight(150)
            args_text.setStyleSheet("""
                QTextEdit {
                    background: transparent;
                    color: #cccccc;
                    border: none;
                    font-family: 'Consolas', 'Courier New', monospace;
                    font-size: 10pt;
                }
            """)
            args_text.setPlainText(json.dumps(self.arguments, indent=2))
            args_layout.addWidget(args_text)
        else:
            no_args = QLabel("No arguments")
            no_args.setStyleSheet("color: #888; font-style: italic;")
            args_layout.addWidget(no_args)
        
        layout.addWidget(args_frame)
        
        # Remember checkbox
        self.remember_check = QCheckBox("Remember my choice for this session")
        self.remember_check.setStyleSheet("color: #b0b0b0; font-size: 10pt;")
        layout.addWidget(self.remember_check)
        
        layout.addStretch()
        
        # Buttons
        button_layout = QHBoxLayout()
        button_layout.addStretch()
        
        deny_btn = QPushButton("✖ Deny")
        deny_btn.setMinimumWidth(120)
        deny_btn.setStyleSheet("""
            QPushButton {
                background: rgba(244, 67, 54, 0.3);
                color: white;
                border: 1px solid rgba(244, 67, 54, 0.5);
                padding: 10px 20px;
                border-radius: 6px;
                font-weight: bold;
                font-size: 11pt;
            }
            QPushButton:hover {
                background: rgba(244, 67, 54, 0.5);
                border: 1px solid rgba(244, 67, 54, 0.8);
            }
        """)
        deny_btn.clicked.connect(self._on_deny)
        button_layout.addWidget(deny_btn)
        
        approve_btn = QPushButton("✓ Approve")
        approve_btn.setMinimumWidth(120)
        approve_btn.setStyleSheet("""
            QPushButton {
                background: rgba(76, 175, 80, 0.3);
                color: white;
                border: 1px solid rgba(76, 175, 80, 0.5);
                padding: 10px 20px;
                border-radius: 6px;
                font-weight: bold;
                font-size: 11pt;
            }
            QPushButton:hover {
                background: rgba(76, 175, 80, 0.5);
                border: 1px solid rgba(76, 175, 80, 0.8);
            }
        """)
        approve_btn.clicked.connect(self._on_approve)
        approve_btn.setDefault(True)  # Enter key approves
        button_layout.addWidget(approve_btn)
        
        layout.addLayout(button_layout)
        
        # Set dark background
        self.setStyleSheet("""
            QDialog {
                background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
                    stop:0 rgba(20, 20, 30, 0.95), stop:1 rgba(10, 10, 20, 0.95));
            }
        """)
    
    def _on_approve(self):
        """Handle approve button"""
        self.approved = True
        self.remember = self.remember_check.isChecked()
        self.accept()
    
    def _on_deny(self):
        """Handle deny button"""
        self.approved = False
        self.remember = self.remember_check.isChecked()
        self.reject()
    
    @staticmethod
    def request_approval(tool_name: str, arguments: dict, danger_level: str = "unknown", parent=None) -> tuple[bool, bool]:
        """
        Show approval dialog and return user's decision.
        
        Args:
            tool_name: Name of the tool
            arguments: Tool arguments
            danger_level: "safe", "warning", "dangerous", or "unknown"
            parent: Parent widget
            
        Returns:
            Tuple of (approved: bool, remember: bool)
        """
        dialog = ToolApprovalDialog(tool_name, arguments, danger_level, parent)
        dialog.exec()
        return dialog.approved, dialog.remember
