"""WhatsApp-style chat widget"""
from __future__ import annotations
from PySide6.QtWidgets import QWidget, QVBoxLayout, QHBoxLayout, QLabel, QScrollArea, QFrame
from PySide6.QtCore import Qt
from PySide6.QtGui import QFont


class ChatBubble(QFrame):
    """WhatsApp-style chat bubble"""
    
    def __init__(self, text: str, is_user: bool, parent=None):
        super().__init__(parent)
        self.is_user = is_user
        self.is_dark = True
        
        self.setMaximumWidth(600)
        self.setFrameShape(QFrame.Box)
        
        layout = QVBoxLayout(self)
        layout.setContentsMargins(15, 10, 15, 10)
        
        self.text_label = QLabel(text)
        self.text_label.setWordWrap(True)
        self.text_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
        text_font = QFont()
        text_font.setPointSize(14)
        self.text_label.setFont(text_font)
        layout.addWidget(self.text_label)
        
        self._apply_style()
    
    def update_text(self, text: str):
        """Update the text content of the bubble"""
        self.text_label.setText(text)
        
        self._apply_style()
    
    def _apply_style(self):
        if self.is_user:
            # User messages: right side, blue/green gradient
            if self.is_dark:
                self.setStyleSheet("""
                    ChatBubble {
                        background: qlineargradient(x1:0, y1:0, x2:1, y2:0, 
                                                    stop:0 #667eea, stop:1 #764ba2);
                        border: none;
                        border-radius: 12px;
                    }
                    QLabel {
                        background: transparent;
                        color: white;
                        border: none;
                    }
                """)
            else:
                self.setStyleSheet("""
                    ChatBubble {
                        background: #DCF8C6;
                        border: 1px solid #B8E0A0;
                        border-radius: 12px;
                    }
                    QLabel {
                        background: transparent;
                        color: #000;
                        border: none;
                    }
                """)
        else:
            # AI messages: left side, gray
            if self.is_dark:
                self.setStyleSheet("""
                    ChatBubble {
                        background: palette(alternate-base);
                        border: 1px solid #3a3a4e;
                        border-radius: 12px;
                    }
                    QLabel {
                        background: transparent;
                        color: #fafafa;
                        border: none;
                    }
                """)
            else:
                self.setStyleSheet("""
                    ChatBubble {
                        background: white;
                        border: 1px solid #e0e0e0;
                        border-radius: 12px;
                    }
                    QLabel {
                        background: transparent;
                        color: #000;
                        border: none;
                    }
                """)
    
    def set_theme(self, dark_mode: bool):
        self.is_dark = dark_mode
        self._apply_style()


class ChatWidget(QWidget):
    """WhatsApp-style chat container"""
    
    def __init__(self, parent=None):
        super().__init__(parent)
        self.is_dark = True
        self.bubbles = []
        self.user_message_containers = []  # Store user message containers for height sync
        
        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(0, 0, 0, 0)
        
        # Scroll area
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        
        # Container for messages
        self.messages_container = QWidget()
        self.messages_layout = QVBoxLayout(self.messages_container)
        self.messages_layout.setSpacing(10)
        self.messages_layout.setContentsMargins(10, 10, 10, 10)
        self.messages_layout.addStretch(1)
        
        self.scroll.setWidget(self.messages_container)
        main_layout.addWidget(self.scroll)
    
    def add_message(self, text: str, is_user: bool):
        """Add a message bubble to the chat"""
        bubble = ChatBubble(text, is_user)
        bubble.set_theme(self.is_dark)
        
        # Create container for alignment
        container = QWidget()
        container_layout = QHBoxLayout(container)
        container_layout.setContentsMargins(0, 0, 0, 0)
        
        if is_user:
            # User messages on the right
            container_layout.addStretch(1)
            container_layout.addWidget(bubble)
            # Store user message container for height synchronization
            self.user_message_containers.append(container)
        else:
            # AI messages on the left
            container_layout.addWidget(bubble)
            container_layout.addStretch(1)
        
        # Insert before the stretch
        self.messages_layout.insertWidget(self.messages_layout.count() - 1, container)
        self.bubbles.append(bubble)
        
        # Scroll to bottom (only if scroll area exists)
        if hasattr(self, 'scroll') and self.scroll:
            self.scroll.verticalScrollBar().setValue(self.scroll.verticalScrollBar().maximum())
        
        return container if is_user else None
    
    def get_last_user_container(self):
        """Get the last user message container for height synchronization"""
        if self.user_message_containers:
            return self.user_message_containers[-1]
        return None
    
    def sync_user_message_height(self, target_height: int):
        """Set the height of the last user message container to match target"""
        last_container = self.get_last_user_container()
        if last_container:
            last_container.setMinimumHeight(target_height)
            last_container.setMaximumHeight(target_height)
    
    def clear(self):
        """Clear all messages"""
        while self.messages_layout.count() > 1:  # Keep the stretch
            item = self.messages_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        self.bubbles.clear()
        self.user_message_containers.clear()
    
    def set_theme(self, dark_mode: bool):
        """Update theme for all bubbles"""
        self.is_dark = dark_mode
        for bubble in self.bubbles:
            bubble.set_theme(dark_mode)
    
    def update_last_ai_message(self, new_text: str):
        """Update the text of the last AI message bubble"""
        # Find the last AI bubble (is_user=False)
        for bubble in reversed(self.bubbles):
            if not bubble.is_user:
                bubble.update_text(new_text)
                # Auto-scroll to bottom to show new content (only if scroll area exists)
                if hasattr(self, 'scroll') and self.scroll:
                    self.scroll.verticalScrollBar().setValue(self.scroll.verticalScrollBar().maximum())
                return

