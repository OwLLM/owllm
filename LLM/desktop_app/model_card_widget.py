"""Custom widget for displaying model cards with rich visual design"""
from __future__ import annotations
from PySide6.QtWidgets import QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QFrame, QScrollArea, QSizePolicy, QGridLayout
from PySide6.QtCore import Qt, Signal, QUrl
from PySide6.QtGui import QFont, QPixmap, QMouseEvent
try:
    from PySide6.QtNetwork import QNetworkAccessManager, QNetworkRequest
    NETWORK_AVAILABLE = True
except ImportError:
    NETWORK_AVAILABLE = False


class ModelCard(QFrame):
    """Beautiful large card widget matching Streamlit design"""
    
    download_clicked = Signal(str)  # Emits model ID
    card_clicked = Signal(str)  # Emits model ID when card is clicked
    
    def __init__(self, model_name: str, model_id: str, description: str, size: str, 
                 icons: str, is_downloaded: bool = False, is_new: bool = False, 
                 downloads: str = "", likes: str = "", author_icon: str = "", 
                 compatibility_badge: dict = None, parent=None):
        super().__init__(parent)
        self.model_id = model_id
        self.is_downloaded = is_downloaded
        self.is_dark = True
        self.compatibility_badge = compatibility_badge
        
        self.setMinimumHeight(220)
        # Remove setMaximumHeight to allow automatic sizing based on content
        self.setFrameShape(QFrame.Box)
        
        # Main layout
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 15, 20, 15)
        layout.setSpacing(8)
        
        # Header layout (Icon + Title + Stats)
        header_layout = QHBoxLayout()
        header_layout.setSpacing(15)
        
        # Author/Model Icon
        self.icon_label = QLabel()
        self.icon_label.setFixedSize(50, 50)
        self.icon_label.setAlignment(Qt.AlignCenter)
        self._set_model_icon(model_id, author_icon)
        header_layout.addWidget(self.icon_label)
        
        # Title and Stats Column
        title_stats_layout = QVBoxLayout()
        title_stats_layout.setSpacing(2)
        
        # Top row: Model name + NEW badge
        top_row = QHBoxLayout()
        top_row.setSpacing(10)
        
        name_label = QLabel(model_name)
        name_font = QFont()
        name_font.setPointSize(14)
        name_font.setBold(True)
        name_label.setFont(name_font)
        name_label.setWordWrap(True)  # Allow wrapping for long names
        name_label.setMaximumWidth(350)  # Limit width to force wrapping
        top_row.addWidget(name_label)
        
        # Compatibility badge (GPU suitability)
        if compatibility_badge:
            badge_color = compatibility_badge.get("color", "gray")
            badge_text = compatibility_badge.get("text", "")
            badge_tooltip = compatibility_badge.get("tooltip", "")
            
            # Define colors for each rating
            if badge_color == "green":
                bg_color = "#4CAF50"  # Green
                text_color = "white"
            elif badge_color == "orange":
                bg_color = "#FF9800"  # Orange
                text_color = "white"
            elif badge_color == "red":
                bg_color = "#f44336"  # Red
                text_color = "white"
            else:
                bg_color = "#888"  # Gray for unknown
                text_color = "white"
            
            compat_badge = QLabel(badge_text)
            compat_badge.setToolTip(badge_tooltip)
            compat_badge.setStyleSheet(f"""
                QLabel {{
                    background-color: {bg_color};
                    color: {text_color};
                    padding: 3px 8px;
                    border-radius: 4px;
                    font-size: 11px;
                    font-weight: bold;
                }}
            """)
            compat_badge.setWordWrap(True)
            compat_badge.setMaximumWidth(180)  # Allow wrapping for long text
            top_row.addWidget(compat_badge)
        
        if is_new:
            new_badge = QLabel("NEW")
            new_badge.setStyleSheet("""
                QLabel {
                    background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 #ff6b6b, stop:1 #ee5a6f);
                    color: white;
                    padding: 3px 8px;
                    border-radius: 4px;
                    font-size: 13px;
                    font-weight: bold;
                }
            """)
            new_badge.setMaximumWidth(50)
            top_row.addWidget(new_badge)
        
        top_row.addStretch(1)
        title_stats_layout.addLayout(top_row)
        
        # Stats row (likes/downloads)
        stats_row = QHBoxLayout()
        stats_row.setSpacing(15)
        if downloads:
            dl_stat = QLabel(f"📥 {downloads} downloads")
            dl_stat.setStyleSheet("color: #888; font-size: 11px;")
            stats_row.addWidget(dl_stat)
        if likes:
            like_stat = QLabel(f"❤️ {likes} likes")
            like_stat.setStyleSheet("color: #888; font-size: 11px;")
            stats_row.addWidget(like_stat)
        stats_row.addStretch(1)
        title_stats_layout.addLayout(stats_row)
        
        header_layout.addLayout(title_stats_layout, 1)
        layout.addLayout(header_layout)
        
        # Description
        if description:
            desc_label = QLabel(description)
            desc_font = QFont()
            desc_font.setPointSize(13)
            desc_label.setFont(desc_font)
            desc_label.setWordWrap(True)
            # Remove setMaximumHeight to allow text to flow naturally
            layout.addWidget(desc_label)
        
        # Size and icons row
        middle_layout = QHBoxLayout()
        
        size_label = QLabel(f"📦 {size}")
        size_font = QFont()
        size_font.setPointSize(13)
        size_label.setFont(size_font)
        middle_layout.addWidget(size_label)
        
        middle_layout.addStretch(1)
        
        icons_label = QLabel(icons)
        icons_font = QFont()
        icons_font.setPointSize(18)
        icons_label.setFont(icons_font)
        middle_layout.addWidget(icons_label)
        
        layout.addLayout(middle_layout)
        
        # Model ID
        id_label = QLabel(f"📂 {model_id}")
        id_font = QFont()
        id_font.setPointSize(11)
        id_label.setFont(id_font)
        id_label.setStyleSheet("color: #888;")
        layout.addWidget(id_label)
        
        layout.addStretch(1)
        
        # Button row (left-aligned)
        button_layout = QHBoxLayout()
        button_layout.setSpacing(8)
        
        # Download button (sized to fit text+icon)
        self.download_btn = QPushButton("📥 Download" if not is_downloaded else "✓ Downloaded")
        self.download_btn.setEnabled(not is_downloaded)
        self.download_btn.clicked.connect(lambda: self.download_clicked.emit(model_id))
        self.download_btn.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Fixed)
        self.download_btn.setMinimumHeight(38)
        self.download_btn.setMinimumWidth(140)  # Enough for icon + text
        self.download_btn.setStyleSheet("""
            QPushButton {
                background: rgba(102, 126, 234, 0.15);
                border: 1px solid rgba(102, 126, 234, 0.4);
                color: white;
                border-radius: 6px;
                padding: 6px 15px;
                font-weight: bold;
            }
            QPushButton:hover {
                background: rgba(102, 126, 234, 0.25);
                border: 1px solid rgba(102, 126, 234, 0.6);
            }
            QPushButton:pressed {
                background: rgba(102, 126, 234, 0.35);
            }
            QPushButton:disabled {
                background: rgba(150, 150, 150, 0.05);
                color: #888;
                border: 1px solid rgba(150, 150, 150, 0.1);
            }
        """)
        button_layout.addWidget(self.download_btn)
        button_layout.addStretch(1)
        
        layout.addLayout(button_layout)
        
        # Make card clickable (but don't interfere with download button)
        self.setCursor(Qt.PointingHandCursor)
        
        self._apply_style()
    
    def resizeEvent(self, event):
        super().resizeEvent(event)

    def mousePressEvent(self, event):
        """Handle card click - emit signal but don't interfere with button clicks"""
        if event.button() == Qt.LeftButton:
            # Check if click is on download button
            if self.download_btn.geometry().contains(event.pos()):
                # Let the button handle it
                super().mousePressEvent(event)
                return
            # Otherwise, emit card_clicked signal
            self.card_clicked.emit(self.model_id)
        super().mousePressEvent(event)
    
    def _set_model_icon(self, model_id, author_icon):
        """Set a visual icon based on model family or author"""
        # Default icon if nothing else matches
        icon_text = "🤖"
        bg_color = "#3498db"
        
        mid_lower = model_id.lower()
        if "llama" in mid_lower:
            icon_text = "🦙"
            bg_color = "#4CAF50" # Meta Green
        elif "qwen" in mid_lower:
            icon_text = "💮"
            bg_color = "#9C27B0" # Alibaba Purple
        elif "mistral" in mid_lower or "mixtral" in mid_lower:
            icon_text = "🌬️"
            bg_color = "#FF9800" # Mistral Orange
        elif "gemma" in mid_lower or "google" in mid_lower:
            icon_text = "💎"
            bg_color = "#4285F4" # Google Blue
        elif "phi" in mid_lower or "microsoft" in mid_lower:
            icon_text = "Φ"
            bg_color = "#00A4EF" # MS Blue
        elif "deepseek" in mid_lower:
            icon_text = "🐳"
            bg_color = "#0000FF" # DeepSeek Blue
        
        self.icon_label.setText(icon_text)
        self.icon_label.setStyleSheet(f"""
            QLabel {{
                background-color: {bg_color};
                color: white;
                border-radius: 25px;
                font-size: 24px;
                font-weight: bold;
                border: 2px solid rgba(255, 255, 255, 0.2);
            }}
        """)
    
    def _apply_style(self):
        """Apply card styling with color-coded border based on compatibility"""
        # Get border color based on compatibility badge
        border_color = "#667eea"  # Default blue
        if self.compatibility_badge:
            color = self.compatibility_badge.get("color", "")
            if color == "green":
                border_color = "#4CAF50"
            elif color == "orange":
                border_color = "#FF9800"
            elif color == "red":
                border_color = "#f44336"
        
        if self.is_dark:
            self.setStyleSheet(f"""
                ModelCard {{
                    background: qlineargradient(x1:0, y1:0, x2:0, y2:1, 
                                                stop:0 #1e1e2e, stop:1 #16213e);
                    border: 2px solid {border_color};
                    border-radius: 10px;
                }}
                ModelCard:hover {{
                    background: qlineargradient(x1:0, y1:0, x2:0, y2:1, 
                                                stop:0 #262740, stop:1 #1a2540);
                }}
                QLabel {{
                    background: transparent;
                    color: #fafafa;
                    border: none;
                }}
            """)
        else:
            self.setStyleSheet(f"""
                ModelCard {{
                    background: white;
                    border: 2px solid {border_color};
                    border-radius: 10px;
                }}
                ModelCard:hover {{
                    background: #f5f5f5;
                }}
                QLabel {{
                    background: transparent;
                    color: #262730;
                    border: none;
                }}
            """)
    
    def set_theme(self, dark_mode: bool):
        """Update theme"""
        self.is_dark = dark_mode
        self._apply_style()


class DownloadedModelCard(QFrame):
    """Card for already downloaded models - now styled like ModelCard with compatibility"""
    
    selected = Signal(str)
    delete_clicked = Signal(str)  # Emits model path
    repair_clicked = Signal(str)  # Emits model path
    
    def __init__(self, model_name: str, model_path: str, size: str, icons: str, 
                 is_incomplete: bool = False, compatibility_badge: dict = None, 
                 onboarding_status: str = None, env_key: str = None, parent=None):
        super().__init__(parent)
        self.model_path = model_path
        self.model_name = model_name
        self.is_incomplete = is_incomplete
        self.is_dark = True
        self.compatibility_badge = compatibility_badge
        self.onboarding_status = onboarding_status or "NEW"
        self.env_key = env_key
        
        self.setMinimumHeight(220)
        self.setFrameShape(QFrame.Box)
        
        # Main layout
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 15, 20, 15)
        layout.setSpacing(8)
        
        # Header layout
        header_layout = QHBoxLayout()
        header_layout.setSpacing(15)
        
        # Model Icon (using first letter or emoji based on model family)
        icon_label = QLabel()
        icon_label.setFixedSize(50, 50)
        icon_label.setAlignment(Qt.AlignCenter)
        self._set_model_icon(model_name, icon_label)
        header_layout.addWidget(icon_label)
        
        # Title and badges column
        title_stats_layout = QVBoxLayout()
        title_stats_layout.setSpacing(2)
        
        # Top row: Model name + Compatibility badge
        top_row = QHBoxLayout()
        top_row.setSpacing(10)
        
        name_label = QLabel(model_name)
        name_font = QFont()
        name_font.setPointSize(14)
        name_font.setBold(True)
        name_label.setFont(name_font)
        name_label.setWordWrap(True)
        name_label.setMaximumWidth(350)
        top_row.addWidget(name_label)
        
        # Compatibility badge (GPU suitability)
        if compatibility_badge and not is_incomplete:
            badge_color = compatibility_badge.get("color", "gray")
            badge_text = compatibility_badge.get("text", "")
            badge_tooltip = compatibility_badge.get("tooltip", "")
            
            # Define colors for each rating
            if badge_color == "green":
                bg_color = "#4CAF50"
                text_color = "white"
            elif badge_color == "orange":
                bg_color = "#FF9800"
                text_color = "white"
            elif badge_color == "red":
                bg_color = "#f44336"
                text_color = "white"
            else:
                bg_color = "#888"
                text_color = "white"
            
            compat_badge = QLabel(badge_text)
            compat_badge.setToolTip(badge_tooltip)
            compat_badge.setStyleSheet(f"""
                QLabel {{
                    background-color: {bg_color};
                    color: {text_color};
                    padding: 3px 8px;
                    border-radius: 4px;
                    font-size: 11px;
                    font-weight: bold;
                }}
            """)
            compat_badge.setWordWrap(True)
            compat_badge.setMaximumWidth(180)
            top_row.addWidget(compat_badge)
        
        top_row.addStretch(1)
        title_stats_layout.addLayout(top_row)
        
        # Status row (local badge + onboarding status badge)
        status_row = QHBoxLayout()
        status_row.setSpacing(10)
        local_badge = QLabel("💾 Downloaded")
        local_badge.setStyleSheet("""
            QLabel {
                background: rgba(76, 175, 80, 0.2);
                color: #4CAF50;
                padding: 2px 6px;
                border-radius: 3px;
                font-size: 10px;
                font-weight: bold;
            }
        """)
        status_row.addWidget(local_badge)
        
        # Environment badge (if env_key exists)
        if self.env_key:
            env_badge = QLabel(f"🔧 {self.env_key}")
            env_badge.setStyleSheet("""
                QLabel {
                    background: rgba(102, 126, 234, 0.3);
                    color: #667eea;
                    padding: 2px 8px;
                    border-radius: 3px;
                    font-size: 10px;
                    font-weight: bold;
                }
            """)
            env_badge.setToolTip(f"Environment: {self.env_key}")
            status_row.addWidget(env_badge)
        
        # Onboarding status badge
        if self.onboarding_status == "READY":
            onboarding_badge = QLabel("✓ Ready")
            onboarding_badge.setStyleSheet("""
                QLabel {
                    background: #4CAF50;
                    color: white;
                    padding: 4px 10px;
                    border-radius: 4px;
                    font-size: 11px;
                    font-weight: bold;
                }
            """)
        elif self.onboarding_status == "BUILDING":
            onboarding_badge = QLabel("⏳ Building...")
            onboarding_badge.setStyleSheet("""
                QLabel {
                    background: #FF9800;
                    color: white;
                    padding: 4px 10px;
                    border-radius: 4px;
                    font-size: 11px;
                    font-weight: bold;
                }
            """)
        elif self.onboarding_status == "BROKEN":
            onboarding_badge = QLabel("❌ Broken")
            onboarding_badge.setStyleSheet("""
                QLabel {
                    background: #f44336;
                    color: white;
                    padding: 4px 10px;
                    border-radius: 4px;
                    font-size: 11px;
                    font-weight: bold;
                }
            """)
        else:  # NEW or None
            onboarding_badge = QLabel("🆕 Not Onboarded")
            onboarding_badge.setStyleSheet("""
                QLabel {
                    background: #888;
                    color: white;
                    padding: 4px 10px;
                    border-radius: 4px;
                    font-size: 11px;
                    font-weight: bold;
                }
            """)
        status_row.addWidget(onboarding_badge)
        status_row.addStretch(1)
        title_stats_layout.addLayout(status_row)
        
        header_layout.addLayout(title_stats_layout, 1)
        layout.addLayout(header_layout)
        
        # Size and icons row
        middle_layout = QHBoxLayout()
        
        size_label = QLabel(f"📦 {size}")
        size_font = QFont()
        size_font.setPointSize(13)
        size_label.setFont(size_font)
        if is_incomplete:
            size_label.setStyleSheet("color: #ff6b6b; font-weight: bold;")
        middle_layout.addWidget(size_label)
        
        middle_layout.addStretch(1)
        
        icons_label = QLabel(icons)
        icons_font = QFont()
        icons_font.setPointSize(18)
        icons_label.setFont(icons_font)
        middle_layout.addWidget(icons_label)
        
        layout.addLayout(middle_layout)
        
        # Model path
        path_label = QLabel(f"📂 {model_path}")
        path_font = QFont()
        path_font.setPointSize(11)
        path_label.setFont(path_font)
        path_label.setStyleSheet("color: #888;")
        path_label.setWordWrap(True)
        layout.addWidget(path_label)
        
        layout.addStretch(1)
        
        # Button row
        button_layout = QHBoxLayout()
        button_layout.setSpacing(8)
        
        button_style = """
            QPushButton {
                background: rgba(102, 126, 234, 0.15);
                border: 1px solid rgba(102, 126, 234, 0.4);
                color: white;
                border-radius: 6px;
                padding: 6px 15px;
                font-weight: bold;
            }
            QPushButton:hover {
                background: rgba(102, 126, 234, 0.25);
                border: 1px solid rgba(102, 126, 234, 0.6);
            }
            QPushButton:pressed {
                background: rgba(102, 126, 234, 0.35);
            }
            QPushButton:disabled {
                background: rgba(150, 150, 150, 0.05);
                color: #888;
                border: 1px solid rgba(150, 150, 150, 0.1);
            }
        """
        
        # Repair button for incomplete models
        if is_incomplete:
            self.repair_btn = QPushButton("🔧 Repair")
            self.repair_btn.setToolTip("Repair / Resume download for this model")
            self.repair_btn.setMinimumHeight(35)
            self.repair_btn.setCursor(Qt.ArrowCursor)
            self.repair_btn.clicked.connect(lambda: self.repair_clicked.emit(self.model_path))
            self.repair_btn.setStyleSheet(button_style)
            button_layout.addWidget(self.repair_btn)
        
        # Delete button
        self.delete_btn = QPushButton("🗑️ Delete")
        self.delete_btn.setToolTip("Delete this model")
        self.delete_btn.setMinimumHeight(35)
        self.delete_btn.setCursor(Qt.ArrowCursor)
        self.delete_btn.clicked.connect(lambda: self.delete_clicked.emit(self.model_path))
        self.delete_btn.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Fixed)
        self.delete_btn.setStyleSheet(button_style)
        button_layout.addWidget(self.delete_btn)
        
        button_layout.addStretch(1)
        layout.addLayout(button_layout)
        
        self._apply_style()
    
    def _set_model_icon(self, model_name, icon_label):
        """Set a visual icon based on model family"""
        icon_text = "🤖"
        bg_color = "#3498db"
        
        name_lower = model_name.lower()
        if "llama" in name_lower:
            icon_text = "🦙"
            bg_color = "#4CAF50"
        elif "qwen" in name_lower:
            icon_text = "💮"
            bg_color = "#9C27B0"
        elif "mistral" in name_lower or "mixtral" in name_lower:
            icon_text = "🌬️"
            bg_color = "#FF9800"
        elif "gemma" in name_lower or "google" in name_lower:
            icon_text = "💎"
            bg_color = "#4285F4"
        elif "phi" in name_lower or "microsoft" in name_lower:
            icon_text = "Φ"
            bg_color = "#00A4EF"
        elif "deepseek" in name_lower:
            icon_text = "🐳"
            bg_color = "#0000FF"
        
        icon_label.setText(icon_text)
        icon_label.setStyleSheet(f"""
            QLabel {{
                background-color: {bg_color};
                color: white;
                border-radius: 25px;
                font-size: 24px;
                font-weight: bold;
                border: 2px solid rgba(255, 255, 255, 0.2);
            }}
        """)
    
    def _apply_style(self):
        # Apply color-coded border based on compatibility badge
        border_color = "#667eea"  # Default blue
        if self.compatibility_badge and not self.is_incomplete:
            color = self.compatibility_badge.get("color", "")
            if color == "green":
                border_color = "#4CAF50"
            elif color == "orange":
                border_color = "#FF9800"
            elif color == "red":
                border_color = "#f44336"
        
        if self.is_incomplete:
            border_color = "#ff6b6b"
        
        if self.is_dark:
            self.setStyleSheet(f"""
                DownloadedModelCard {{
                    background: qlineargradient(x1:0, y1:0, x2:0, y2:1, 
                                                stop:0 #1e1e2e, stop:1 #16213e);
                    border: 2px solid {border_color};
                    border-radius: 10px;
                }}
                DownloadedModelCard:hover {{
                    background: qlineargradient(x1:0, y1:0, x2:0, y2:1, 
                                                stop:0 #262740, stop:1 #1a2540);
                }}
                QLabel {{
                    background: transparent;
                    color: #fafafa;
                    border: none;
                }}
            """)
        else:
            self.setStyleSheet(f"""
                DownloadedModelCard {{
                    background: white;
                    border: 2px solid {border_color};
                    border-radius: 10px;
                }}
                DownloadedModelCard:hover {{
                    background: #f5f5f5;
                }}
                QLabel {{
                    background: transparent;
                    color: #262730;
                    border: none;
                }}
            """)
    
    def set_theme(self, dark_mode: bool):
        self.is_dark = dark_mode
        self._apply_style()
    
    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            self.selected.emit(self.model_path)
        super().mousePressEvent(event)


class ModelDetailsPanel(QWidget):
    """Panel displaying detailed model information from Hugging Face API"""
    
    def __init__(self, parent=None):
        super().__init__(parent)
        self.is_dark = True
        self._setup_ui()
        self._show_empty_state()
    
    def _setup_ui(self):
        """Setup the UI layout"""
        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 14, 14, 14)
        layout.setSpacing(10)
        
        # Header row: avatar (left) + title/meta (right)
        header_row = QHBoxLayout()
        header_row.setSpacing(12)

        self.avatar_label = QLabel()
        self.avatar_label.setFixedSize(96, 96)
        self.avatar_label.setAlignment(Qt.AlignCenter)
        self.avatar_label.setStyleSheet(
            "QLabel { border: 2px solid rgba(102,126,234,0.25); border-radius: 10px; background: rgba(0,0,0,0.18); }"
        )
        header_row.addWidget(self.avatar_label, 0, Qt.AlignTop)

        title_col = QVBoxLayout()
        title_col.setSpacing(4)

        self.title_label = QLabel()
        self.title_label.setAlignment(Qt.AlignLeft)
        title_font = QFont()
        title_font.setPointSize(15)
        title_font.setBold(True)
        self.title_label.setFont(title_font)
        self.title_label.setWordWrap(True)
        title_col.addWidget(self.title_label)

        self.author_label = QLabel()
        self.author_label.setAlignment(Qt.AlignLeft)
        self.author_label.setStyleSheet("color: #9aa4b2; font-size: 10.5pt;")
        self.author_label.setWordWrap(True)
        title_col.addWidget(self.author_label)

        self.repo_label = QLabel()
        self.repo_label.setAlignment(Qt.AlignLeft)
        self.repo_label.setStyleSheet("color: #7d8696; font-size: 9.5pt;")
        self.repo_label.setWordWrap(True)
        title_col.addWidget(self.repo_label)

        header_row.addLayout(title_col, 1)
        layout.addLayout(header_row)
        
        # Separator
        separator = QFrame()
        separator.setFrameShape(QFrame.HLine)
        separator.setStyleSheet("color: rgba(102, 126, 234, 0.25);")
        layout.addWidget(separator)
        
        # Description (compact)
        self.description_label = QLabel()
        self.description_label.setWordWrap(True)
        self.description_label.setStyleSheet(
            "color: #d7dde7; font-size: 10.5pt; padding: 8px 10px; background: rgba(255,255,255,0.04); border-radius: 8px;"
        )
        layout.addWidget(self.description_label)

        # Compact stats grid (downloads/likes/license/task)
        self.stats_grid = QGridLayout()
        self.stats_grid.setHorizontalSpacing(10)
        self.stats_grid.setVerticalSpacing(6)

        self.stats_left = QLabel()
        self.stats_left.setStyleSheet("color: #b6c0cf; font-size: 10pt;")
        self.stats_left.setWordWrap(True)
        self.stats_right = QLabel()
        self.stats_right.setStyleSheet("color: #b6c0cf; font-size: 10pt;")
        self.stats_right.setWordWrap(True)

        self.stats_grid.addWidget(self.stats_left, 0, 0)
        self.stats_grid.addWidget(self.stats_right, 0, 1)
        layout.addLayout(self.stats_grid)
        
        # Tags (chips)
        tags_header = QLabel("Tags")
        tags_header.setStyleSheet("font-weight: 600; font-size: 10.5pt; color: #8ea2ff; margin-top: 4px;")
        layout.addWidget(tags_header)
        self.tags_label = QLabel()
        self.tags_label.setWordWrap(True)
        self.tags_label.setTextFormat(Qt.RichText)
        self.tags_label.setStyleSheet("color: #c2cad6; font-size: 9.5pt;")
        layout.addWidget(self.tags_label)
        
        # License (kept, but compact)
        license_header = QLabel("License")
        license_header.setStyleSheet("font-weight: 600; font-size: 10.5pt; color: #8ea2ff; margin-top: 4px;")
        layout.addWidget(license_header)
        self.license_label = QLabel()
        self.license_label.setWordWrap(True)
        self.license_label.setStyleSheet("color: #c2cad6; font-size: 9.5pt;")
        layout.addWidget(self.license_label)
        
        # Files section
        files_header = QLabel("Files (top)")
        files_header.setStyleSheet("font-weight: 600; font-size: 10.5pt; color: #8ea2ff; margin-top: 4px;")
        layout.addWidget(files_header)
        self.files_label = QLabel()
        self.files_label.setWordWrap(True)
        self.files_label.setStyleSheet("color: #b6c0cf; font-size: 9pt; font-family: Consolas, monospace;")
        layout.addWidget(self.files_label)
        
        # Additional info
        info_header = QLabel("Info")
        info_header.setStyleSheet("font-weight: 600; font-size: 10.5pt; color: #8ea2ff; margin-top: 4px;")
        layout.addWidget(info_header)
        self.info_label = QLabel()
        self.info_label.setWordWrap(True)
        self.info_label.setStyleSheet("color: #b6c0cf; font-size: 9.5pt;")
        layout.addWidget(self.info_label)
        
        layout.addStretch()
    
    def _show_empty_state(self):
        """Show empty state when no model is selected"""
        self.avatar_label.clear()
        self.avatar_label.setText("📦")
        self.title_label.setText("Select a model to view details")
        self.title_label.setStyleSheet("color: #888; font-size: 14pt;")
        self.author_label.clear()
        self.repo_label.clear()
        self.description_label.clear()
        self.tags_label.clear()
        self.license_label.clear()
        if hasattr(self, "stats_left"):
            self.stats_left.clear()
        if hasattr(self, "stats_right"):
            self.stats_right.clear()
        self.files_label.clear()
        self.info_label.clear()
    
    def show_loading(self):
        """Show loading state"""
        self.avatar_label.clear()
        self.avatar_label.setText("⏳")
        self.title_label.setText("Loading model details...")
        self.title_label.setStyleSheet("color: #667eea; font-size: 14pt;")
        self.author_label.clear()
        self.repo_label.clear()
        self.description_label.setText("Fetching information from Hugging Face...")
        self.tags_label.clear()
        self.license_label.clear()
        if hasattr(self, "stats_left"):
            self.stats_left.clear()
        if hasattr(self, "stats_right"):
            self.stats_right.clear()
        self.files_label.clear()
        self.info_label.clear()
    
    def show_error(self, error_msg: str):
        """Show error state"""
        self.avatar_label.clear()
        self.avatar_label.setText("❌")
        self.title_label.setText("Error loading model details")
        self.title_label.setStyleSheet("color: #f44336; font-size: 14pt;")
        self.author_label.clear()
        self.repo_label.clear()
        self.description_label.setText(f"Error: {error_msg}")
        self.description_label.setStyleSheet("color: #f44336; font-size: 11pt; padding: 10px;")
        self.tags_label.clear()
        self.license_label.clear()
        if hasattr(self, "stats_left"):
            self.stats_left.clear()
        if hasattr(self, "stats_right"):
            self.stats_right.clear()
        self.files_label.clear()
        self.info_label.clear()
    
    def display_details(self, details: dict):
        """Display detailed model information - MUST be called from main thread"""
        # Avatar/Logo (try multiple candidates)
        # Note: This MUST run in main thread to avoid "Cannot create children for parent in different thread"
        candidates = details.get("thumbnail_candidates") or []
        if isinstance(candidates, str):
            candidates = [candidates]
        if details.get("thumbnail"):
            candidates = [details.get("thumbnail")] + list(candidates)
        if details.get("avatar_url"):
            candidates = list(candidates) + [details.get("avatar_url")]
        # de-dup
        seen = set()
        candidates = [u for u in candidates if u and not (u in seen or seen.add(u))]
        
        # Load avatar directly (we're already in main thread via signal connection)
        if candidates:
            self._load_avatar_candidates(candidates)
        else:
            self.avatar_label.clear()
            self.avatar_label.setText("🤖")
        
        # Title
        model_id = details.get("model_id", "Unknown Model")
        model_name = model_id.split("/")[-1] if "/" in model_id else model_id
        self.title_label.setText(model_name)
        self.title_label.setStyleSheet("color: white; font-size: 16pt; font-weight: bold;")
        self.repo_label.setText(model_id if "/" in model_id else "")
        
        # Author
        author = details.get("author", "Unknown")
        self.author_label.setText(f"by {author}")
        
        # Description
        description = details.get("description") or details.get("text") or "No description available."
        # Truncate if too long
        if len(description) > 500:
            description = description[:500] + "..."
        self.description_label.setText(description)
        
        # Tags (chips)
        tags = details.get("tags", [])
        if tags:
            show = tags[:14]
            chips = []
            for t in show:
                chips.append(
                    f"<span style=\"display:inline-block; padding:2px 8px; margin:2px 6px 2px 0; "
                    f"border-radius:10px; background:rgba(102,126,234,0.18); color:#cdd6ff;\">{t}</span>"
                )
            more = ""
            if len(tags) > len(show):
                more = f"<span style=\"color:#98a3b7;\">+{len(tags)-len(show)} more</span>"
            self.tags_label.setText("".join(chips) + more)
        else:
            self.tags_label.setText("No tags available")
        
        # License
        license_info = details.get("license")
        if license_info:
            if isinstance(license_info, list):
                license_text = ", ".join(license_info)
            else:
                license_text = str(license_info)
            self.license_label.setText(license_text)
        else:
            self.license_label.setText("Not specified")
        
        # Compact stats
        downloads = details.get("downloads", 0)
        likes = details.get("likes", 0)
        pipeline_tag = details.get("pipeline_tag") or ""
        lib = details.get("library_name") or ""
        left = f"⬇ {downloads:,} downloads\n❤ {likes:,} likes"
        right_parts = []
        if pipeline_tag:
            right_parts.append(f"Task: {pipeline_tag}")
        if lib:
            right_parts.append(f"Library: {lib}")
        self.stats_left.setText(left)
        self.stats_right.setText("\n".join(right_parts) if right_parts else "")
        
        # Files (short list)
        siblings = details.get("siblings", [])
        if siblings:
            files_text = ""
            total_size = 0
            for file_info in siblings[:8]:  # Show first 8 files
                filename = file_info.get("filename", "unknown")
                size = file_info.get("size", 0)
                if size:
                    size_mb = size / (1024 * 1024)
                    files_text += f"{filename} ({size_mb:.1f} MB)\n"
                    total_size += size
                else:
                    files_text += f"{filename}\n"
            if len(siblings) > 8:
                files_text += f"... +{len(siblings) - 8} more\n"
            if total_size > 0:
                total_gb = total_size / (1024 ** 3)
                files_text += f"\nTotal size: {total_gb:.2f} GB"
            self.files_label.setText(files_text)
        else:
            self.files_label.setText("No file information available")
        
        # Additional info
        info_parts = []
        pipeline_tag = details.get("pipeline_tag")
        if pipeline_tag:
            info_parts.append(f"Task: {pipeline_tag}")
        library_name = details.get("library_name")
        if library_name:
            info_parts.append(f"Library: {library_name}")
        base_model = details.get("base_model")
        if base_model:
            info_parts.append(f"Base Model: {base_model}")
        model_type = details.get("model_type")
        if model_type:
            info_parts.append(f"Type: {model_type}")
        if details.get("private"):
            info_parts.append("Private: Yes")
        if details.get("gated"):
            info_parts.append("Gated: Yes (requires access approval)")
        
        if info_parts:
            self.info_label.setText("\n".join(info_parts))
        else:
            self.info_label.setText("No additional information available")
    
    def _load_avatar(self, url: str):
        """Load avatar/logo from URL"""
        if not NETWORK_AVAILABLE:
            self.avatar_label.clear()
            self.avatar_label.setText("🤖")
            return
        
        try:
            if not hasattr(self, 'network_manager'):
                self.network_manager = QNetworkAccessManager()
            
            request = QNetworkRequest(QUrl(url))
            reply = self.network_manager.get(request)
            
            def on_finished():
                try:
                    from PySide6.QtNetwork import QNetworkReply
                    if reply.error() == QNetworkReply.NetworkError.NoError:
                        pixmap = QPixmap()
                        pixmap.loadFromData(reply.readAll())
                        if not pixmap.isNull():
                            # Scale to fit
                            scaled = pixmap.scaled(120, 120, Qt.KeepAspectRatio, Qt.SmoothTransformation)
                            self.avatar_label.setPixmap(scaled)
                except Exception:
                    pass
                finally:
                    reply.deleteLater()
            
            reply.finished.connect(on_finished)
        except Exception as e:
            # Fallback to emoji if image loading fails
            self.avatar_label.clear()
            self.avatar_label.setText("🤖")

    def _load_avatar_candidates(self, urls: list) -> None:
        """Try multiple avatar URLs until one loads. Must be called from main thread."""
        if not urls:
            self.avatar_label.clear()
            self.avatar_label.setText("🤖")
            return
        if not NETWORK_AVAILABLE:
            self.avatar_label.clear()
            self.avatar_label.setText("🤖")
            return
        
        try:
            # Ensure network manager is created in the main thread
            if not hasattr(self, "network_manager") or self.network_manager is None:
                self.network_manager = QNetworkAccessManager(self)  # Parent it to this widget
 
            # capture a mutable index
            state = {"i": 0}
 
            def try_next():
                if state["i"] >= len(urls):
                    self.avatar_label.clear()
                    self.avatar_label.setText("🤖")
                    return
                url = urls[state["i"]]
                state["i"] += 1
                
                request = QNetworkRequest(QUrl(url))
                reply = self.network_manager.get(request)
 
                def on_finished():
                    try:
                        from PySide6.QtNetwork import QNetworkReply
                        if reply.error() == QNetworkReply.NetworkError.NoError:
                            pixmap = QPixmap()
                            pixmap.loadFromData(reply.readAll())
                            if not pixmap.isNull():
                                scaled = pixmap.scaled(96, 96, Qt.KeepAspectRatio, Qt.SmoothTransformation)
                                self.avatar_label.setPixmap(scaled)
                                reply.deleteLater()
                                return
                    except Exception:
                        pass
                    finally:
                        reply.deleteLater()
                    try_next()
 
                reply.finished.connect(on_finished)
 
            try_next()
        except Exception:
            self.avatar_label.clear()
            self.avatar_label.setText("🤖")


