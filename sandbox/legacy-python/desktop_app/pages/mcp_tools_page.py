"""
MCP Tools page for displaying and running tools from connected servers.
"""
from __future__ import annotations

import json
import urllib.request
import urllib.error
from typing import Dict, Any, List, Optional

from PySide6.QtCore import Qt, QTimer, QEvent, Signal, QObject, QThread
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QLineEdit, QComboBox, QScrollArea, QDialog, QTextEdit,
    QCheckBox, QMessageBox, QFrame, QGroupBox, QSplitter, QSizePolicy
)
from PySide6.QtGui import QFont

from desktop_app.widgets.tool_card import ToolCard
from desktop_app.widgets.schema_form import SchemaForm
from desktop_app.config.config_manager import ConfigManager
from desktop_app.mcp.connection_manager import MCPConnectionManager


class RunToolDialog(QDialog):
    """Dialog for running a tool with auto-generated form."""
    
    def __init__(self, tool_data: dict, parent=None):
        super().__init__(parent)
        self.tool_data = tool_data
        self.result_data = None
        self._setup_ui()
    
    def _setup_ui(self):
        """Setup the dialog UI."""
        self.setWindowTitle(f"Run Tool: {self.tool_data.get('name', '')}")
        self.setMinimumSize(600, 500)
        
        layout = QVBoxLayout(self)
        layout.setSpacing(12)
        layout.setContentsMargins(16, 16, 16, 16)
        
        # Tool info
        info_frame = QFrame()
        info_frame.setStyleSheet("""
            QFrame {
                background: rgba(30, 30, 40, 0.9);
                border: 1px solid rgba(102, 126, 234, 0.3);
                border-radius: 6px;
                padding: 8px;
            }
        """)
        info_layout = QVBoxLayout(info_frame)
        info_layout.setSpacing(4)
        
        name_label = QLabel(f"<b>{self.tool_data.get('name', '')}</b>")
        name_label.setStyleSheet("color: white; font-size: 14pt;")
        info_layout.addWidget(name_label)
        
        # Show source server if available
        source_server = self.tool_data.get("source_server")
        if source_server:
            server_label = QLabel(f"From: {source_server}")
            server_label.setStyleSheet("color: #888; font-size: 10pt;")
            info_layout.addWidget(server_label)
        
        desc_label = QLabel(self.tool_data.get("description", ""))
        desc_label.setWordWrap(True)
        desc_label.setStyleSheet("color: #cccccc; font-size: 10pt;")
        info_layout.addWidget(desc_label)
        
        layout.addWidget(info_frame)
        
        # Form
        form_label = QLabel("Parameters:")
        form_label.setStyleSheet("color: white; font-weight: bold;")
        layout.addWidget(form_label)
        
        schema_json = self.tool_data.get("args_schema_json") or self.tool_data.get("input_schema")
        if schema_json:
            if isinstance(schema_json, str):
                self.form = SchemaForm(schema_json=schema_json)
            else:
                self.form = SchemaForm(schema_json=json.dumps(schema_json))
        else:
            self.form = SchemaForm()
            self.form.layout.addWidget(QLabel("No parameters required."))
        
        form_scroll = QScrollArea()
        form_scroll.setWidget(self.form)
        form_scroll.setWidgetResizable(True)
        form_scroll.setStyleSheet("QScrollArea { border: none; background: transparent; }")
        layout.addWidget(form_scroll, 1)
        
        # Dry run checkbox
        self.dry_run_check = QCheckBox("Dry run (validate only, don't execute)")
        self.dry_run_check.setStyleSheet("color: white;")
        layout.addWidget(self.dry_run_check)
        
        # Output area
        output_label = QLabel("Output:")
        output_label.setStyleSheet("color: white; font-weight: bold;")
        layout.addWidget(output_label)
        
        self.output_text = QTextEdit()
        self.output_text.setReadOnly(True)
        self.output_text.setMaximumHeight(150)
        self.output_text.setStyleSheet("""
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
        layout.addWidget(self.output_text)
        
        # Buttons
        btn_layout = QHBoxLayout()
        
        copy_btn = QPushButton("Copy Output")
        copy_btn.clicked.connect(self._copy_output)
        btn_layout.addWidget(copy_btn)
        
        btn_layout.addStretch()
        
        cancel_btn = QPushButton("Close")
        cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(cancel_btn)
        
        self.execute_btn = QPushButton("Execute")
        self.execute_btn.setStyleSheet("""
            QPushButton {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 rgba(76, 175, 80, 0.8), stop:1 rgba(102, 126, 234, 0.8));
                color: white;
                border: none;
                padding: 8px 16px;
                border-radius: 4px;
                font-weight: bold;
            }
            QPushButton:hover {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 rgba(76, 175, 80, 1.0), stop:1 rgba(102, 126, 234, 1.0));
            }
        """)
        self.execute_btn.clicked.connect(self._execute)
        btn_layout.addWidget(self.execute_btn)
        
        layout.addLayout(btn_layout)
    
    def _copy_output(self):
        """Copy output to clipboard."""
        from PySide6.QtWidgets import QApplication
        QApplication.clipboard().setText(self.output_text.toPlainText())
    
    def _execute(self):
        """Execute the tool (called from parent MCPToolsPage)."""
        # This will be called by parent with server connection
        pass


class ToolsRefreshWorker(QObject):
    """Worker object for refreshing tools in background thread."""
    tools_ready = Signal(list)  # Emits list of tools
    error = Signal(str)  # Emits error message
    finished = Signal()  # Emits when work is complete (success or error)
    
    def __init__(self, connection_manager):
        super().__init__()
        self.connection_manager = connection_manager
    
    def refresh(self):
        """Fetch tools in background thread."""
        import sys
        try:
            print("[MCP Tools] Worker: Starting refresh...", file=sys.stderr, flush=True)
            tools = self.connection_manager.get_all_tools()
            print(f"[MCP Tools] Worker: Got {len(tools)} tools", file=sys.stderr, flush=True)
            self.tools_ready.emit(tools)
        except Exception as e:
            import traceback
            error_str = str(e)
            print(f"[MCP Tools] Worker: Error: {error_str}", file=sys.stderr, flush=True)
            print(traceback.format_exc(), file=sys.stderr, flush=True)
            self.error.emit(error_str)
        finally:
            # Always emit finished, whether success or error
            self.finished.emit()


class MCPToolsPage(QWidget):
    """MCP tools page with card-based UI for aggregated tools from all connected servers."""
    
    def __init__(self, parent=None):
        super().__init__(parent)
        # Set background to match app theme
        self.setStyleSheet("QWidget { background: transparent; }")
        # Defer manager initialization to avoid blocking during page creation
        self.config_manager = None
        self.connection_manager = None
        self.tools: List[Dict[str, Any]] = []
        self.tool_cards: Dict[str, ToolCard] = {}
        self._refresh_worker = None
        self._refresh_thread = None
        self._setup_ui()
        # Defer manager creation to avoid blocking
        QTimer.singleShot(100, self._initialize_managers)
    
    def _initialize_managers(self):
        """Initialize managers after UI is set up."""
        self.config_manager = ConfigManager()
        self.connection_manager = MCPConnectionManager()
        # Auto-refresh tools after managers are ready
        QTimer.singleShot(300, self._refresh_tools)
    
    def _setup_ui(self):
        """Setup the UI with 3 equal columns (1/3 each)."""
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)
        # Ensure layout has proper size
        self.setMinimumSize(800, 600)
        
        # Title
        title = QLabel("🧩 MCP Tools")
        title.setStyleSheet("font-size: 20pt; font-weight: bold; color: #ffffff; background: transparent;")
        title.setVisible(True)
        layout.addWidget(title)
        
        # Status banner
        self.status_banner = QFrame()
        self.status_banner.setVisible(False)
        self.status_banner.setStyleSheet("background: rgba(255, 152, 0, 0.1); border: 1px solid rgba(255, 152, 0, 0.3); border-radius: 4px;")
        banner_layout = QHBoxLayout(self.status_banner)
        self.status_banner_label = QLabel()
        self.status_banner_label.setWordWrap(True)
        self.status_banner_label.setStyleSheet("color: #ffcc80; font-size: 10pt;")
        banner_layout.addWidget(self.status_banner_label, 1)
        layout.addWidget(self.status_banner)
        
        # Top bar: Search + Refresh
        top_bar = QHBoxLayout()
        top_bar.setSpacing(8)
        
        self.search_edit = QLineEdit()
        self.search_edit.setPlaceholderText("Search tools...")
        self.search_edit.textChanged.connect(self._filter_tools)
        self.search_edit.setStyleSheet("QLineEdit { background: rgba(40, 40, 50, 0.8); color: white; border: 1px solid rgba(102, 126, 234, 0.3); border-radius: 4px; padding: 6px; }")
        top_bar.addWidget(self.search_edit, 1)
        
        self.category_combo = QComboBox()
        self.category_combo.addItem("All Categories")
        self.category_combo.currentTextChanged.connect(self._filter_tools)
        self.category_combo.setStyleSheet("QComboBox { background: rgba(40, 40, 50, 0.8); color: white; border: 1px solid rgba(102, 126, 234, 0.3); border-radius: 4px; padding: 6px; }")
        top_bar.addWidget(self.category_combo)
        
        self.refresh_btn = QPushButton("🔄 Refresh")
        self.refresh_btn.clicked.connect(self._refresh_tools)
        self.refresh_btn.setStyleSheet("QPushButton { background: rgba(102, 126, 234, 0.3); color: white; border: 1px solid rgba(102, 126, 234, 0.5); border-radius: 4px; padding: 6px 12px; } QPushButton:hover { background: rgba(102, 126, 234, 0.5); }")
        top_bar.addWidget(self.refresh_btn)
        
        layout.addLayout(top_bar)
        
        # Use QSplitter for fixed 1/3 divisions
        splitter = QSplitter(Qt.Horizontal)
        splitter.setStyleSheet("QSplitter::handle { background: rgba(102, 126, 234, 0.1); width: 1px; } QSplitter::handle:hover { background: rgba(102, 126, 234, 0.2); }")
        # Disable manual resizing - maintain fixed 1/3 ratio
        splitter.setChildrenCollapsible(False)
        
        # COLUMN 1 & 2 (Scroll Areas for Tool Cards)
        col1_widget = QWidget()
        col1_widget.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.col1_layout = QVBoxLayout(col1_widget)
        self.col1_layout.setContentsMargins(10, 10, 10, 10)
        self.col1_layout.setSpacing(12)
        self.col1_layout.addStretch()
        
        col2_widget = QWidget()
        col2_widget.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.col2_layout = QVBoxLayout(col2_widget)
        self.col2_layout.setContentsMargins(10, 10, 10, 10)
        self.col2_layout.setSpacing(12)
        self.col2_layout.addStretch()
        
        scroll1 = QScrollArea()
        scroll1.setWidgetResizable(True)
        scroll1.setFrameShape(QFrame.NoFrame)
        scroll1.setStyleSheet("QScrollArea { background: transparent; border: none; }")
        scroll1.setWidget(col1_widget)
        scroll1.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        scroll1.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        
        scroll2 = QScrollArea()
        scroll2.setWidgetResizable(True)
        scroll2.setFrameShape(QFrame.NoFrame)
        scroll2.setStyleSheet("QScrollArea { background: transparent; border: none; }")
        scroll2.setWidget(col2_widget)
        scroll2.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        scroll2.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        
        # COLUMN 3: Tool Execution Panel (replaces dialog)
        right_panel = QWidget()
        right_panel.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        right_v_layout = QVBoxLayout(right_panel)
        right_v_layout.setContentsMargins(20, 0, 0, 0)
        right_v_layout.setSpacing(15)
        
        # Tool info section
        self.tool_info_section = QWidget()
        tool_info_layout = QVBoxLayout(self.tool_info_section)
        tool_info_layout.setContentsMargins(0, 0, 0, 0)
        tool_info_layout.setSpacing(8)
        
        self.selected_tool_title = QLabel("Select a Tool")
        self.selected_tool_title.setStyleSheet("""
            font-size: 20pt; 
            font-weight: 700; 
            color: #ffffff;
            letter-spacing: 0.5px;
            padding-bottom: 12px;
            border-bottom: 2px solid rgba(102, 126, 234, 0.3);
        """)
        tool_info_layout.addWidget(self.selected_tool_title)
        
        self.selected_tool_desc = QLabel("Click a tool card on the left to see details and execute it.")
        self.selected_tool_desc.setWordWrap(True)
        self.selected_tool_desc.setStyleSheet("""
            color: #b0b0b0; 
            font-size: 11pt;
            line-height: 1.5;
            padding-top: 8px;
        """)
        tool_info_layout.addWidget(self.selected_tool_desc)
        
        self.selected_tool_server = QLabel()
        self.selected_tool_server.setWordWrap(True)
        self.selected_tool_server.setStyleSheet("color: #888; font-size: 9pt;")
        self.selected_tool_server.setVisible(False)
        tool_info_layout.addWidget(self.selected_tool_server)
        
        right_v_layout.addWidget(self.tool_info_section)
        
        # Form section (initially hidden)
        self.form_section = QWidget()
        form_section_layout = QVBoxLayout(self.form_section)
        form_section_layout.setContentsMargins(0, 0, 0, 0)
        form_section_layout.setSpacing(8)
        
        form_label = QLabel("Parameters:")
        form_label.setStyleSheet("""
            color: #667eea; 
            font-weight: 700; 
            font-size: 11pt;
            letter-spacing: 1px;
            padding-bottom: 8px;
            border-bottom: 2px solid rgba(102, 126, 234, 0.2);
        """)
        form_section_layout.addWidget(form_label)
        
        self.tool_form_scroll = QScrollArea()
        self.tool_form_scroll.setWidgetResizable(True)
        self.tool_form_scroll.setFrameShape(QFrame.NoFrame)
        self.tool_form_scroll.setStyleSheet("QScrollArea { border: none; background: transparent; }")
        self.tool_form = None
        form_section_layout.addWidget(self.tool_form_scroll, 1)
        
        self.dry_run_check = QCheckBox("Dry run (validate only, don't execute)")
        self.dry_run_check.setStyleSheet("color: #b0b0b0; font-size: 10pt;")
        form_section_layout.addWidget(self.dry_run_check)
        
        self.execute_btn = QPushButton("▶ Execute Tool")
        self.execute_btn.setStyleSheet("""
            QPushButton {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 rgba(76, 175, 80, 0.3), stop:1 rgba(102, 126, 234, 0.3));
                color: #ffffff;
                border: 1px solid rgba(76, 175, 80, 0.5);
                padding: 12px;
                border-radius: 8px;
                font-weight: 600;
                font-size: 11pt;
            }
            QPushButton:hover {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 rgba(76, 175, 80, 0.5), stop:1 rgba(102, 126, 234, 0.5));
                border: 1px solid rgba(76, 175, 80, 0.8);
            }
            QPushButton:disabled {
                background: rgba(60, 60, 60, 0.3);
                color: #888;
                border: 1px solid rgba(102, 126, 234, 0.2);
            }
        """)
        self.execute_btn.clicked.connect(self._execute_selected_tool)
        form_section_layout.addWidget(self.execute_btn)
        
        self.form_section.setVisible(False)
        right_v_layout.addWidget(self.form_section, 1)
        
        # Output section (initially hidden)
        self.output_section = QWidget()
        output_section_layout = QVBoxLayout(self.output_section)
        output_section_layout.setContentsMargins(0, 0, 0, 0)
        output_section_layout.setSpacing(8)
        
        output_label = QLabel("Output:")
        output_label.setStyleSheet("""
            color: #667eea; 
            font-weight: 700; 
            font-size: 11pt;
            letter-spacing: 1px;
            padding-bottom: 8px;
            border-bottom: 2px solid rgba(102, 126, 234, 0.2);
        """)
        output_section_layout.addWidget(output_label)
        
        self.output_text = QTextEdit()
        self.output_text.setReadOnly(True)
        self.output_text.setStyleSheet("""
            background: rgba(0, 0, 0, 0.4);
            color: #4ade80;
            font-family: 'Consolas', 'Courier New', monospace;
            font-size: 10pt;
            border: 1px solid rgba(102, 126, 234, 0.2);
            border-radius: 8px;
            padding: 12px;
        """)
        output_section_layout.addWidget(self.output_text, 1)
        
        copy_btn = QPushButton("📋 Copy Output")
        copy_btn.setStyleSheet("""
            QPushButton {
                background: rgba(102, 126, 234, 0.2);
                color: #ffffff;
                border: 1px solid rgba(102, 126, 234, 0.3);
                padding: 8px;
                border-radius: 6px;
                font-size: 10pt;
            }
            QPushButton:hover {
                background: rgba(102, 126, 234, 0.3);
                border: 1px solid rgba(102, 126, 234, 0.5);
            }
        """)
        copy_btn.clicked.connect(self._copy_output)
        output_section_layout.addWidget(copy_btn)
        
        self.output_section.setVisible(False)
        right_v_layout.addWidget(self.output_section, 1)
        
        # Store current tool data
        self.current_tool_data = None
        
        splitter.addWidget(scroll1)
        splitter.addWidget(scroll2)
        splitter.addWidget(right_panel)
        
        # Set equal 1/3 sizes after widgets are added
        splitter.setStretchFactor(0, 1)
        splitter.setStretchFactor(1, 1)
        splitter.setStretchFactor(2, 1)
        
        # Store splitter reference
        self.tools_splitter = splitter
        
        # Set stretch factors for equal distribution
        splitter.setStretchFactor(0, 1)
        splitter.setStretchFactor(1, 1)
        splitter.setStretchFactor(2, 1)
        
        # Force fixed 1/3 ratio - maintain equal sizes on any resize
        def maintain_fixed_ratio():
            width = splitter.width()
            if width > 0:
                third = width // 3
                current = splitter.sizes()
                # Only update if not already equal (avoid infinite loops)
                if len(current) == 3 and (current[0] != third or current[1] != third or current[2] != third):
                    splitter.setSizes([third, third, third])
        
        # Use event filter to catch all resize events
        class FixedRatioFilter(QObject):
            def eventFilter(self, obj, event):
                if event.type() == QEvent.Resize and obj is splitter:
                    QTimer.singleShot(1, maintain_fixed_ratio)
                return False
        
        filter_obj = FixedRatioFilter()
        splitter.installEventFilter(filter_obj)
        self._splitter_filter = filter_obj  # Keep reference
        
        # Set initial sizes
        QTimer.singleShot(100, maintain_fixed_ratio)
        
        # Also check periodically (backup in case events are missed)
        self._ratio_timer = QTimer()
        self._ratio_timer.timeout.connect(maintain_fixed_ratio)
        self._ratio_timer.start(100)  # Check every 100ms
        
        splitter.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        layout.addWidget(splitter, 1)
        
    def _log(self, message: str):
        """Add message to log (print to console for now)."""
        import sys
        from datetime import datetime
        timestamp = datetime.now().strftime("%H:%M:%S")
        log_msg = f"[{timestamp}] {message}"
        print(log_msg, file=sys.stderr, flush=True)

    def showEvent(self, event: QEvent):
        """Refresh tools when page is shown (only if managers are ready)."""
        super().showEvent(event)
        if self.connection_manager is not None and self.refresh_btn.isEnabled():
            QTimer.singleShot(200, self._refresh_tools)
    
    def closeEvent(self, event):
        """Clean up threads when page/widget is closed."""
        self._cleanup_threads()
        super().closeEvent(event)
    
    def _cleanup_threads(self):
        """Stop and clean up any running threads."""
        if self._refresh_thread is not None:
            try:
                if self._refresh_thread.isRunning():
                    # Request thread to quit gracefully
                    self._refresh_thread.quit()
                    # Wait briefly for clean shutdown
                    if not self._refresh_thread.wait(500):
                        # If still running after 500ms, terminate it
                        self._refresh_thread.terminate()
                        self._refresh_thread.wait(500)
            except RuntimeError:
                # C++ object already deleted
                pass
            except Exception:
                # Other errors, continue cleanup
                pass
            finally:
                self._refresh_thread = None
                self._refresh_worker = None
    
    def _show_status_banner(self, message: str, is_info: bool = False):
        """Show status banner."""
        self.status_banner_label.setText(message)
        if is_info:
            self.status_banner.setStyleSheet("background: rgba(76, 175, 80, 0.2); border: 1px solid rgba(76, 175, 80, 0.4); border-radius: 4px; padding: 8px;")
        else:
            self.status_banner.setStyleSheet("background: rgba(255, 152, 0, 0.2); border: 1px solid rgba(255, 152, 0, 0.4); border-radius: 4px; padding: 8px;")
        self.status_banner.setVisible(True)
    
    def _hide_status_banner(self):
        """Hide status banner."""
        self.status_banner.setVisible(False)
    
    def _filter_tools(self):
        """Filter tools by search and category."""
        search_text = self.search_edit.text().lower()
        category_filter = self.category_combo.currentText()

        for tool_name, card in self.tool_cards.items():
            tool_data = card.tool_data
            matches_search = (not search_text or search_text in tool_data.get("name", "").lower() or search_text in tool_data.get("description", "").lower())
            matches_category = (category_filter == "All Categories" or category_filter == tool_data.get("category", ""))
            card.setVisible(matches_search and matches_category)
    
    def _refresh_tools(self):
        """Refresh tools in background thread."""
        if not self.refresh_btn.isEnabled(): return
        if self.connection_manager is None:
            QTimer.singleShot(100, self._refresh_tools)
            return
        
        # Clean up any existing thread first
        self._cleanup_threads()
        
        self._hide_status_banner()
        self.refresh_btn.setEnabled(False)
        self.refresh_btn.setText("🔄 Refreshing...")
        
        self._refresh_thread = QThread()
        self._refresh_worker = ToolsRefreshWorker(self.connection_manager)
        self._refresh_worker.moveToThread(self._refresh_thread)
        self._refresh_thread.started.connect(self._refresh_worker.refresh)
        self._refresh_worker.tools_ready.connect(self._on_tools_refreshed)
        self._refresh_worker.error.connect(self._on_refresh_error)
        self._refresh_worker.finished.connect(self._refresh_thread.quit)
        self._refresh_thread.finished.connect(self._refresh_thread.deleteLater)
        self._refresh_thread.start()

    def _on_tools_refreshed(self, tools: List[Dict[str, Any]]):
        self.refresh_btn.setEnabled(True)
        self.refresh_btn.setText("🔄 Refresh")
        self.tools = tools
        if not self.tools:
            self._show_status_banner("No tools available. Connect to servers first.")
        else:
            self._show_status_banner(f"Loaded {len(self.tools)} tool(s).", is_info=True)
            QTimer.singleShot(3000, self._hide_status_banner)
        self._update_tool_cards()

    def _on_refresh_error(self, error_msg: str):
        self.refresh_btn.setEnabled(True)
        self.refresh_btn.setText("🔄 Refresh")
        self._show_status_banner(f"Error loading tools: {error_msg}")
        self.tools = []
        self._update_tool_cards()
    
    def _update_tool_cards(self):
        """Update display in 2 scrollable columns."""
        # Clear existing cards
        for layout in [self.col1_layout, self.col2_layout]:
            # Remove all widgets except the stretch at the end
            while layout.count() > 1:
                item = layout.takeAt(0)
                widget = item.widget()
                if widget:
                    widget.setParent(None)
                    widget.deleteLater()
        
        self.tool_cards.clear()
        
        # Update categories
        categories = {"All Categories"}
        for tool in self.tools: 
            categories.add(tool.get("category", "General"))
        
        curr = self.category_combo.currentText()
        self.category_combo.clear()
        self.category_combo.addItems(sorted(categories))
        if curr in categories: 
            self.category_combo.setCurrentText(curr)
        
        # Get enabled tools config
        enabled_tools = {}
        if self.config_manager:
            try:
                enabled_tools = self.config_manager.load().get("enabled_tools", {})
            except:
                pass
        
        # Add cards to columns
        for idx, tool in enumerate(self.tools):
            name = tool.get("name", "")
            if not name: 
                continue
            
            tool["enabled"] = enabled_tools.get(name, tool.get("enabled", True))
            card = ToolCard(tool)
            card.run_clicked.connect(self._run_tool)
            card.enabled_changed.connect(self._on_tool_enabled_changed)
            self.tool_cards[name] = card
            
            # Add to alternating columns
            target = self.col1_layout if idx % 2 == 0 else self.col2_layout
            # Insert before the stretch (which is at count - 1)
            target.insertWidget(target.count() - 1, card)
        
        # Force layout update
        self.col1_layout.update()
        self.col2_layout.update()
        
        self._filter_tools()
        self._log(f"Displaying {len(self.tool_cards)} tools.")

    def _on_tool_enabled_changed(self, tool_name: str, enabled: bool):
        """Handle tool enabled/disabled state change."""
        # Update the tool data in self.tools
        for tool in self.tools:
            if tool.get("name") == tool_name:
                tool["enabled"] = enabled
                break
        
        # Save to config
        if not self.config_manager: return
        config = self.config_manager.load()
        if "enabled_tools" not in config: config["enabled_tools"] = {}
        config["enabled_tools"][tool_name] = enabled
        self.config_manager.save(config)
    
    def _run_tool(self, tool_name: str):
        """Show tool in third column for execution."""
        tool_data = next((t for t in self.tools if t.get("name") == tool_name), None)
        if not tool_data:
            self._log(f"Tool '{tool_name}' not found.")
            return
        
        # Note: We removed the enabled check - let users run any tool
        # The checkbox is just for visual organization/preference
        
        self.current_tool_data = tool_data
        
        # Update tool info
        self.selected_tool_title.setText(tool_data.get("name", "Unknown Tool"))
        self.selected_tool_desc.setText(tool_data.get("description", "No description available."))
        
        source_server = tool_data.get("source_server")
        if source_server:
            self.selected_tool_server.setText(f"From: {source_server}")
            self.selected_tool_server.setVisible(True)
        else:
            self.selected_tool_server.setVisible(False)
        
        # Setup form
        if self.tool_form:
            self.tool_form.deleteLater()
        
        schema_json = tool_data.get("args_schema_json") or tool_data.get("input_schema")
        if schema_json:
            if isinstance(schema_json, str):
                self.tool_form = SchemaForm(schema_json=schema_json)
            else:
                self.tool_form = SchemaForm(schema_json=json.dumps(schema_json))
        else:
            self.tool_form = SchemaForm()
            self.tool_form.layout.addWidget(QLabel("No parameters required."))
        
        self.tool_form_scroll.setWidget(self.tool_form)
        self.dry_run_check.setChecked(False)
        self.execute_btn.setEnabled(True)
        self.execute_btn.setText("▶ Execute Tool")
        
        # Show form and hide output initially
        self.form_section.setVisible(True)
        self.output_section.setVisible(False)
        self.output_text.clear()
        
        self._log(f"Selected tool: {tool_name}")

    def _execute_selected_tool(self):
        """Execute the currently selected tool."""
        if not self.current_tool_data:
            return
        
        tool_name = self.current_tool_data.get("name", "")
        if not tool_name:
            return
        
        values = self.tool_form.get_values() if self.tool_form else {}
        
        if self.dry_run_check.isChecked():
            self.output_text.setPlainText(f"[DRY RUN] Would execute: {tool_name}\n\nArgs:\n{json.dumps(values, indent=2)}")
            self.output_section.setVisible(True)
            return
        
        self.execute_btn.setEnabled(False)
        self.execute_btn.setText("Executing...")
        self._log(f"Executing: {tool_name}...")
        self.output_section.setVisible(True)
        self.output_text.setPlainText("Executing... Please wait.")
        
        import threading
        def worker():
            try:
                server_url = self.current_tool_data.get("source_server_url", "http://127.0.0.1:8000")
                auth_token = None
                source_server = self.current_tool_data.get("source_server")
                if source_server and self.connection_manager:
                    server_config = self.connection_manager.get_server(source_server)
                    if server_config:
                        auth_token = server_config.get("config", {}).get("auth_token")
                
                headers = {"Content-Type": "application/json"}
                if auth_token:
                    headers["X-Auth-Token"] = auth_token
                
                req = urllib.request.Request(
                    f"{server_url}/call",
                    headers=headers,
                    data=json.dumps({"name": tool_name, "args": values}).encode("utf-8"),
                    method="POST"
                )
                
                with urllib.request.urlopen(req, timeout=30) as r:
                    result = json.loads(r.read().decode("utf-8"))
                    QTimer.singleShot(0, lambda: self._on_tool_executed(result))
            except Exception as e:
                import traceback
                error_msg = f"{str(e)}\n\n{traceback.format_exc()}"
                QTimer.singleShot(0, lambda: self._on_tool_execution_error(error_msg))
        
        threading.Thread(target=worker, daemon=True).start()

    def _on_tool_executed(self, result: dict):
        """Handle tool execution success."""
        self.execute_btn.setEnabled(True)
        self.execute_btn.setText("▶ Execute Tool")
        if result.get("ok"):
            self.output_text.setPlainText(f"✓ Success\n\n{json.dumps(result.get('result', {}), indent=2)}")
            self._log(f"Tool {self.current_tool_data.get('name')} executed successfully.")
        else:
            self.output_text.setPlainText(f"✗ Error\n\n{result.get('error', 'Unknown error')}")
            self._log(f"Tool {self.current_tool_data.get('name')} failed: {result.get('error', 'Unknown')}")

    def _on_tool_execution_error(self, error_msg: str):
        """Handle tool execution error."""
        self.execute_btn.setEnabled(True)
        self.execute_btn.setText("▶ Execute Tool")
        self.output_text.setPlainText(f"✗ Error\n\n{error_msg}")
        self._log(f"Tool {self.current_tool_data.get('name') if self.current_tool_data else 'Unknown'} error: {error_msg[:100]}")

    def _copy_output(self):
        """Copy output to clipboard."""
        from PySide6.QtWidgets import QApplication
        QApplication.clipboard().setText(self.output_text.toPlainText())
        self._log("Output copied to clipboard.")
