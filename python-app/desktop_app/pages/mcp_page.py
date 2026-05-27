"""
MCP page with sub-tabs for Catalog, Connections, and Tools.
"""
from __future__ import annotations

from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QWidget, QVBoxLayout, QTabWidget

from desktop_app.pages.mcp_catalog_page import MCPCatalogPage
from desktop_app.pages.mcp_connections_page import MCPConnectionsPage
from desktop_app.pages.mcp_tools_page import MCPToolsPage


class MCPPage(QWidget):
    """MCP page container with sub-tabs for Catalog, Connections, and Tools."""
    
    def __init__(self, parent=None):
        super().__init__(parent)
        self._ui_setup = False  # Guard to prevent multiple setup calls
        self._created_pages = {}  # Track which pages have been created
        self._setup_ui()
    
    def _setup_ui(self):
        """Setup the UI with sub-tabs."""
        # Guard against multiple calls
        if self._ui_setup:
            return
        self._ui_setup = True
        
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        
        # Sub-tabs
        self.sub_tabs = QTabWidget()
        self.sub_tabs.setStyleSheet("""
            QTabWidget::pane {
                border: none;
                background: transparent;
            }
            QTabBar::tab {
                background: rgba(30, 30, 40, 0.8);
                color: white;
                padding: 10px 20px;
                border: none;
                border-top-left-radius: 6px;
                border-top-right-radius: 6px;
                font-size: 12pt;
                font-weight: 600;
                min-height: 22px;
            }
            QTabBar::tab:selected {
                background: rgba(102, 126, 234, 0.8);
            }
            QTabBar::tab:hover {
                background: rgba(102, 126, 234, 0.6);
            }
        """)
        
        # Add empty placeholder tabs - pages will be created lazily
        self.sub_tabs.addTab(QWidget(), "📦 Catalog")
        self.sub_tabs.addTab(QWidget(), "🔌 Connections")
        self.sub_tabs.addTab(QWidget(), "🧩 Tools")
        
        # Connect to lazy-load pages on first access
        self.sub_tabs.currentChanged.connect(self._lazy_load_page)
        
        layout.addWidget(self.sub_tabs)
    
    def _lazy_load_page(self, index: int):
        """Lazy-load page when tab is first accessed."""
        if index in self._created_pages:
            return  # Already created
        
        # Create page on first access (deferred from UI thread)
        # Use functools.partial or a method reference to avoid lambda closure issues
        QTimer.singleShot(0, lambda idx=index: self._create_page(idx))
    
    def _create_page(self, index: int):
        """Create the actual page widget."""
        # Safety check - ensure widget still exists
        if not self.sub_tabs or index < 0 or index >= self.sub_tabs.count():
            return
        
        if index in self._created_pages:
            return  # Already created
        
        try:
            # Determine which page to create
            if index == 0:  # Catalog
                page = MCPCatalogPage(self)
                tab_text = "📦 Catalog"
                # Store as attribute for backward compatibility
                self.catalog_page = page
            elif index == 1:  # Connections
                page = MCPConnectionsPage(self)
                tab_text = "🔌 Connections"
                # Store as attribute for backward compatibility
                self.connections_page = page
            elif index == 2:  # Tools
                page = MCPToolsPage(self)
                tab_text = "🧩 Tools"
                # Store as attribute for backward compatibility
                self.tools_page = page
            else:
                return
            
            # Replace placeholder with actual page
            self.sub_tabs.removeTab(index)
            self.sub_tabs.insertTab(index, page, tab_text)
            self.sub_tabs.setCurrentIndex(index)
            self._created_pages[index] = page
        except Exception:
            # If page creation fails, don't crash - just leave placeholder
            pass
    
    def get_tools_page(self):
        """Get tools page if it exists."""
        return self._created_pages.get(2) or getattr(self, 'tools_page', None)
    
    def get_connections_page(self):
        """Get connections page if it exists."""
        return self._created_pages.get(1) or getattr(self, 'connections_page', None)
    
    def closeEvent(self, event):
        """Clean up all sub-pages when container is closed."""
        # Clean up any created pages
        for page in self._created_pages.values():
            if page and hasattr(page, 'closeEvent'):
                try:
                    # Manually trigger cleanup
                    if hasattr(page, '_cleanup_threads'):
                        page._cleanup_threads()
                except Exception:
                    pass
        super().closeEvent(event)