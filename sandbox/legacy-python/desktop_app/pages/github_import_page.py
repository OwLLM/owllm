"""
GitHub Import page for importing external tools from GitHub repositories.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from PySide6.QtCore import Qt, QTimer, QThread, Signal, QObject
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QLineEdit,
    QTextEdit, QListWidget, QListWidgetItem, QGroupBox, QMessageBox,
    QFrame, QScrollArea
)
from PySide6.QtGui import QFont

from desktop_app.mcp.github_importer import GitHubToolImporter


class ImportWorker(QObject):
    """Worker thread for importing GitHub repositories"""
    progress = Signal(str)
    finished = Signal(bool, str, Optional[Path])
    error = Signal(str)
    
    def __init__(self, importer: GitHubToolImporter, repo_url: str, branch: str):
        super().__init__()
        self.importer = importer
        self.repo_url = repo_url
        self.branch = branch
    
    def run(self):
        """Run import in background"""
        try:
            self.progress.emit(f"Cloning repository from {self.repo_url}...")
            success, message, install_path = self.importer.import_from_github(
                self.repo_url,
                self.branch
            )
            
            if success:
                self.progress.emit(f"Scanning for tools...")
                tools = self.importer.scan_for_tools(install_path)
                if tools:
                    self.progress.emit(f"Found {len(tools)} tool(s): {', '.join(tools)}")
                else:
                    self.progress.emit("No tools found (files with @tool decorator)")
            
            self.finished.emit(success, message, install_path)
        except Exception as e:
            self.error.emit(str(e))


class GitHubImportPage(QWidget):
    """Page for importing tools from GitHub"""
    
    def __init__(self, parent=None):
        super().__init__(parent)
        self.importer: Optional[GitHubToolImporter] = None
        self.import_thread: Optional[QThread] = None
        self.import_worker: Optional[ImportWorker] = None
        self._setup_ui()
        self._initialize_importer()
    
    def _initialize_importer(self):
        """Initialize the GitHub importer"""
        try:
            # Get external tools directory
            from pathlib import Path
            base_dir = Path(__file__).parent.parent.parent
            external_tools_dir = base_dir / "tool_server" / "external_tools"
            self.importer = GitHubToolImporter(external_tools_dir)
            self._refresh_installed_list()
        except Exception as e:
            QMessageBox.warning(self, "Error", f"Failed to initialize importer: {e}")
    
    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)
        
        # Title
        title = QLabel("📦 Import External Tools from GitHub")
        title.setProperty("class", "page_title")
        title.setStyleSheet("font-size: 18pt; font-weight: bold; margin-bottom: 10px;")
        layout.addWidget(title)
        
        # Description
        desc = QLabel(
            "Import tools from GitHub repositories. Tools are automatically discovered "
            "and made available in the Tools tab. External tools run in a sandboxed environment."
        )
        desc.setWordWrap(True)
        desc.setStyleSheet("color: #888; margin-bottom: 10px;")
        layout.addWidget(desc)
        
        # Import form
        form_group = QGroupBox("Import Tool Repository")
        form_layout = QVBoxLayout()
        form_layout.setSpacing(8)
        
        # URL input
        url_layout = QHBoxLayout()
        url_layout.addWidget(QLabel("GitHub URL:"))
        self.url_input = QLineEdit()
        self.url_input.setPlaceholderText("https://github.com/username/repo")
        url_layout.addWidget(self.url_input, 1)
        form_layout.addLayout(url_layout)
        
        # Branch input
        branch_layout = QHBoxLayout()
        branch_layout.addWidget(QLabel("Branch:"))
        self.branch_input = QLineEdit("main")
        self.branch_input.setPlaceholderText("main")
        branch_layout.addWidget(self.branch_input)
        form_layout.addLayout(branch_layout)
        
        # Import button
        self.import_btn = QPushButton("📥 Import Tools")
        self.import_btn.clicked.connect(self._import_clicked)
        form_layout.addWidget(self.import_btn)
        
        # Status/log
        self.log_display = QTextEdit()
        self.log_display.setReadOnly(True)
        self.log_display.setMaximumHeight(150)
        self.log_display.setPlaceholderText("Import status will appear here...")
        form_layout.addWidget(self.log_display)
        
        form_group.setLayout(form_layout)
        layout.addWidget(form_group)
        
        # Installed tools list
        installed_group = QGroupBox("Installed External Tools")
        installed_layout = QVBoxLayout()
        
        # Refresh button
        refresh_layout = QHBoxLayout()
        refresh_btn = QPushButton("🔄 Refresh")
        refresh_btn.clicked.connect(self._refresh_installed_list)
        refresh_layout.addWidget(refresh_btn)
        refresh_layout.addStretch()
        installed_layout.addLayout(refresh_layout)
        
        self.installed_list = QListWidget()
        self.installed_list.setAlternatingRowColors(True)
        installed_layout.addWidget(self.installed_list)
        
        # Remove button
        remove_btn = QPushButton("🗑️ Remove Selected")
        remove_btn.clicked.connect(self._remove_selected)
        installed_layout.addWidget(remove_btn)
        
        installed_group.setLayout(installed_layout)
        layout.addWidget(installed_group, 1)
    
    def _import_clicked(self):
        """Handle import button click"""
        url = self.url_input.text().strip()
        branch = self.branch_input.text().strip() or "main"
        
        if not url:
            QMessageBox.warning(self, "Error", "Please enter a GitHub URL")
            return
        
        if not url.startswith("http") or "github.com" not in url:
            QMessageBox.warning(self, "Error", "Please enter a valid GitHub URL (e.g., https://github.com/username/repo)")
            return
        
        if self.importer is None:
            QMessageBox.warning(self, "Error", "Importer not initialized")
            return
        
        # Disable button during import
        self.import_btn.setEnabled(False)
        self.log_display.clear()
        self.log_display.append(f"Starting import from {url}...")
        
        # Create worker thread
        self.import_thread = QThread()
        self.import_worker = ImportWorker(self.importer, url, branch)
        self.import_worker.moveToThread(self.import_thread)
        
        # Connect signals
        self.import_thread.started.connect(self.import_worker.run)
        self.import_worker.progress.connect(self._on_import_progress)
        self.import_worker.finished.connect(self._on_import_finished)
        self.import_worker.error.connect(self._on_import_error)
        self.import_thread.finished.connect(self.import_thread.deleteLater)
        
        # Start thread
        self.import_thread.start()
    
    def _on_import_progress(self, message: str):
        """Handle import progress updates"""
        self.log_display.append(message)
    
    def _on_import_finished(self, success: bool, message: str, install_path: Optional[Path]):
        """Handle import completion"""
        self.import_btn.setEnabled(True)
        
        if success:
            self.log_display.append(f"✅ {message}")
            QMessageBox.information(self, "Success", f"{message}\n\nTools will be available after restarting the app.")
            self._refresh_installed_list()
        else:
            self.log_display.append(f"❌ {message}")
            QMessageBox.warning(self, "Import Failed", message)
        
        # Clean up thread
        if self.import_thread:
            self.import_thread.quit()
            self.import_thread.wait()
            self.import_thread = None
        self.import_worker = None
    
    def _on_import_error(self, error: str):
        """Handle import errors"""
        self.import_btn.setEnabled(True)
        self.log_display.append(f"❌ Error: {error}")
        QMessageBox.critical(self, "Error", f"Import failed: {error}")
        
        # Clean up thread
        if self.import_thread:
            self.import_thread.quit()
            self.import_thread.wait()
            self.import_thread = None
        self.import_worker = None
    
    def _refresh_installed_list(self):
        """Refresh the list of installed repositories"""
        self.installed_list.clear()
        
        if self.importer is None:
            return
        
        try:
            repos = self.importer.list_installed_repos()
            
            if not repos:
                item = QListWidgetItem("No external tools installed")
                item.setFlags(Qt.NoItemFlags)  # Make it non-selectable
                self.installed_list.addItem(item)
                return
            
            for repo in repos:
                tool_count = repo.get("tool_count", 0)
                tools = repo.get("tools", [])
                
                item_text = f"{repo['name']} ({tool_count} tool{'s' if tool_count != 1 else ''})"
                if tools:
                    item_text += f"\n  Tools: {', '.join(tools[:3])}"
                    if len(tools) > 3:
                        item_text += f" + {len(tools) - 3} more"
                
                item = QListWidgetItem(item_text)
                item.setData(Qt.UserRole, repo['name'])  # Store repo name for removal
                self.installed_list.addItem(item)
        except Exception as e:
            QMessageBox.warning(self, "Error", f"Failed to refresh list: {e}")
    
    def _remove_selected(self):
        """Remove selected repository"""
        current_item = self.installed_list.currentItem()
        if not current_item:
            QMessageBox.warning(self, "Error", "Please select a repository to remove")
            return
        
        repo_name = current_item.data(Qt.UserRole)
        if not repo_name:
            QMessageBox.warning(self, "Error", "Invalid repository selection")
            return
        
        reply = QMessageBox.question(
            self,
            "Confirm Removal",
            f"Are you sure you want to remove '{repo_name}'?\n\nThis will delete all files in the repository.",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No
        )
        
        if reply == QMessageBox.Yes:
            if self.importer:
                success, message = self.importer.remove_repo(repo_name)
                if success:
                    QMessageBox.information(self, "Removed", message)
                    self._refresh_installed_list()
                else:
                    QMessageBox.warning(self, "Error", message)
