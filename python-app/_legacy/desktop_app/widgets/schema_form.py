"""
Auto-generated form widget from JSON Schema.
"""
from __future__ import annotations

import json
from typing import Any, Dict, Optional

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QLineEdit, QSpinBox,
    QDoubleSpinBox, QCheckBox, QComboBox, QPlainTextEdit, QScrollArea
)


class SchemaForm(QWidget):
    """Form widget that auto-generates inputs from JSON Schema."""
    
    def __init__(self, schema_json: Optional[str] = None, parent=None):
        super().__init__(parent)
        self.schema: Optional[Dict[str, Any]] = None
        self.fields: Dict[str, QWidget] = {}
        self._setup_ui()
        if schema_json:
            self.load_schema(schema_json)
    
    def _setup_ui(self):
        """Setup the form layout."""
        self.layout = QVBoxLayout(self)
        self.layout.setSpacing(10)
        self.layout.setContentsMargins(0, 0, 0, 0)
    
    def load_schema(self, schema_json: str):
        """Load and render schema."""
        try:
            self.schema = json.loads(schema_json)
        except json.JSONDecodeError:
            # Fallback: try to parse as dict if it's already a dict
            if isinstance(schema_json, dict):
                self.schema = schema_json
            else:
                self.schema = {"type": "object", "properties": {}}
        
        self._render_schema()
    
    def _render_schema(self):
        """Render form fields from schema."""
        # Clear existing fields
        for widget in self.fields.values():
            widget.setParent(None)
        self.fields.clear()
        
        if not self.schema:
            return
        
        properties = self.schema.get("properties", {})
        required = set(self.schema.get("required", []))
        
        for prop_name, prop_schema in properties.items():
            if not isinstance(prop_schema, dict):
                continue
            
            # Create label
            label = QLabel(prop_name.replace("_", " ").title() + ("" if prop_name not in required else " *"))
            label.setStyleSheet("color: white; font-weight: bold;")
            self.layout.addWidget(label)
            
            # Create input based on type
            prop_type = prop_schema.get("type", "string")
            default = prop_schema.get("default")
            description = prop_schema.get("description", "")
            
            if prop_type == "boolean":
                widget = QCheckBox()
                if default is not None:
                    widget.setChecked(bool(default))
                self.fields[prop_name] = widget
                self.layout.addWidget(widget)
            
            elif prop_type == "integer":
                widget = QSpinBox()
                widget.setRange(-2147483647, 2147483647)
                if default is not None:
                    widget.setValue(int(default))
                self.fields[prop_name] = widget
                self.layout.addWidget(widget)
            
            elif prop_type == "number":
                widget = QDoubleSpinBox()
                widget.setRange(-1e10, 1e10)
                widget.setDecimals(6)
                if default is not None:
                    widget.setValue(float(default))
                self.fields[prop_name] = widget
                self.layout.addWidget(widget)
            
            elif "enum" in prop_schema:
                # Enum -> ComboBox
                widget = QComboBox()
                widget.addItems([str(v) for v in prop_schema["enum"]])
                if default is not None:
                    idx = widget.findText(str(default))
                    if idx >= 0:
                        widget.setCurrentIndex(idx)
                self.fields[prop_name] = widget
                self.layout.addWidget(widget)
            
            elif prop_type == "object" or prop_type == "array":
                # Complex type -> JSON editor
                widget = QPlainTextEdit()
                widget.setPlaceholderText(f"Enter JSON for {prop_name}...")
                widget.setMaximumHeight(120)
                if default is not None:
                    widget.setPlainText(json.dumps(default, indent=2))
                widget.setStyleSheet("""
                    QPlainTextEdit {
                        background: rgba(20, 20, 30, 0.9);
                        color: #00ff00;
                        font-family: 'Consolas', 'Courier New', monospace;
                        font-size: 9pt;
                        border: 1px solid rgba(102, 126, 234, 0.3);
                        border-radius: 4px;
                        padding: 4px;
                    }
                """)
                self.fields[prop_name] = widget
                self.layout.addWidget(widget)
            
            else:
                # Default: string input
                widget = QLineEdit()
                widget.setPlaceholderText(description or prop_name)
                if default is not None:
                    widget.setText(str(default))
                self.fields[prop_name] = widget
                self.layout.addWidget(widget)
            
            # Add description if available
            if description and prop_type not in ("object", "array"):
                desc_label = QLabel(description)
                desc_label.setWordWrap(True)
                desc_label.setStyleSheet("color: #888; font-size: 9pt; margin-left: 8px;")
                self.layout.addWidget(desc_label)
            
            self.layout.addSpacing(4)
        
        self.layout.addStretch()
    
    def get_values(self) -> Dict[str, Any]:
        """Get form values as a dictionary."""
        values = {}
        
        for prop_name, widget in self.fields.items():
            if isinstance(widget, QCheckBox):
                values[prop_name] = widget.isChecked()
            elif isinstance(widget, (QSpinBox, QDoubleSpinBox)):
                values[prop_name] = widget.value()
            elif isinstance(widget, QComboBox):
                values[prop_name] = widget.currentText()
            elif isinstance(widget, QPlainTextEdit):
                # Try to parse as JSON
                text = widget.toPlainText().strip()
                if text:
                    try:
                        values[prop_name] = json.loads(text)
                    except json.JSONDecodeError:
                        values[prop_name] = text  # Fallback to string
                else:
                    values[prop_name] = None
            else:
                # QLineEdit or other
                text = widget.text().strip()
                if text:
                    values[prop_name] = text
                else:
                    values[prop_name] = None
        
        return values
    
    def set_values(self, values: Dict[str, Any]):
        """Set form values from a dictionary."""
        for prop_name, value in values.items():
            if prop_name not in self.fields:
                continue
            
            widget = self.fields[prop_name]
            if isinstance(widget, QCheckBox):
                widget.setChecked(bool(value))
            elif isinstance(widget, QSpinBox):
                widget.setValue(int(value))
            elif isinstance(widget, QDoubleSpinBox):
                widget.setValue(float(value))
            elif isinstance(widget, QComboBox):
                idx = widget.findText(str(value))
                if idx >= 0:
                    widget.setCurrentIndex(idx)
            elif isinstance(widget, QPlainTextEdit):
                widget.setPlainText(json.dumps(value, indent=2) if value is not None else "")
            else:
                widget.setText(str(value) if value is not None else "")
