"""Synchronized WhatsApp-style chat display for side-by-side model comparison"""
from PySide6.QtWidgets import (QWidget, QHBoxLayout, QVBoxLayout, QScrollArea, 
                                QFrame, QLabel, QSizePolicy)
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QFont, QResizeEvent


class ChatBubble(QFrame):
    """WhatsApp-style chat bubble"""
    
    def __init__(self, text: str, is_user: bool, parent=None):
        super().__init__(parent)
        self.is_user = is_user
        self.is_dark = True
        
        # Set size policy to Preferred so bubble respects container width
        # The container will control the width, bubble should wrap text within it
        self.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Preferred)
        # Maximum width will be set dynamically in resizeEvent based on container width
        self.setFrameShape(QFrame.Box)
        
        layout = QVBoxLayout(self)
        layout.setContentsMargins(15, 10, 15, 10)
        layout.setSpacing(0)
        
        self.text_label = QLabel(text)
        self.text_label.setWordWrap(True)
        self.text_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
        # CRITICAL: Use Expanding so label fills bubble width and wraps properly
        self.text_label.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        # Align text to top of bubble
        self.text_label.setAlignment(Qt.AlignTop | Qt.AlignLeft)
        text_font = QFont()
        text_font.setPointSize(14)
        self.text_label.setFont(text_font)
        layout.addWidget(self.text_label, 0, Qt.AlignTop)  # Align to top, no stretch
        
        self._apply_style()
    
    def update_text(self, text: str):
        """Update the text content of the bubble"""
        self.text_label.setText(text)
        # Constrain bubble width to parent container if available
        if self.parent():
            parent_width = self.parent().width()
            if parent_width > 0:
                # Leave some margin (10px on each side)
                max_bubble_width = parent_width - 10
                self.setMaximumWidth(max_bubble_width)
        self._apply_style()
    
    def resizeEvent(self, event: QResizeEvent):
        """Override to constrain bubble width to container"""
        super().resizeEvent(event)
        # Ensure bubble doesn't exceed container width
        if self.parent():
            parent_width = self.parent().width()
            if parent_width > 0:
                max_bubble_width = parent_width - 10
                self.setMaximumWidth(max_bubble_width)
    
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
                        background: #2a2a3e;
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


class SynchronizedChatDisplay(QWidget):
    """WhatsApp-style chat with row-based synchronized display"""
    
    def __init__(self, num_models=2, parent=None):
        super().__init__(parent)
        self.is_dark = True
        self.num_models = num_models
        self.current_row_a_bubble = None
        self.current_row_b_bubble = None
        self.current_row_c_bubble = None
        # Model-to-model (M2M) pending turn row (per-column alignment)
        self._m2m_pending_speaker: str | None = None
        self._m2m_pending_bubbles = None  # dict[str, ChatBubble] when active
        
        # Set size policy to maintain proper width distribution
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        
        # Setup UI
        self._setup_ui()
    
    def _setup_ui(self):
        """Setup the synchronized display layout"""
        # Main layout
        main_layout = QHBoxLayout(self)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(0)
        
        # Create container widget that will hold all message ROWS
        self.scroll_container = QWidget()
        # Set size policy to maintain width ratios
        self.scroll_container.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        self.rows_layout = QVBoxLayout(self.scroll_container)
        self.rows_layout.setContentsMargins(0, 10, 0, 10)  # Only vertical margins for alignment
        self.rows_layout.setSpacing(10)
        self.rows_layout.addStretch(1)
        
        # Single scroll area containing all rows
        self.scroll_area = QScrollArea()
        self.scroll_area.setWidgetResizable(True)
        self.scroll_area.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.scroll_area.setVerticalScrollBarPolicy(Qt.ScrollBarAlwaysOn)
        # Ensure scroll area maintains width ratios
        self.scroll_area.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.scroll_area.setWidget(self.scroll_container)
        main_layout.addWidget(self.scroll_area)
        
        # Apply scrollbar styling
        self._apply_scrollbar_style()
    
    def _create_message_row(self, bubble_a: ChatBubble, bubble_b: ChatBubble = None, bubble_c: ChatBubble = None, is_user: bool = False):
        """Create a row containing Model A, optionally Model B, and optionally Model C bubbles side by side"""
        row = QWidget()
        row.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        row_layout = QHBoxLayout(row)
        row_layout.setContentsMargins(0, 0, 0, 0)
        row_layout.setSpacing(6)  # 6 pixels between chat columns
        
        # Helper to create column container with fixed equal width
        def create_column_container(bubble, is_user_msg):
            container = QWidget()
            # CRITICAL: Set expanding horizontal policy to fill available space equally
            container.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
            container.setMinimumWidth(0)
            
            # CRITICAL: Constrain bubble to NOT expand beyond container
            # Use Maximum so it respects container width and wraps text
            bubble.setSizePolicy(QSizePolicy.Maximum, QSizePolicy.Preferred)
            
            layout = QHBoxLayout(container)
            layout.setContentsMargins(0, 0, 0, 0)  # No margins to match header alignment
            layout.setSpacing(0)
            
            # Add stretch first to push bubble to left (for AI) or right (for user)
            # CRITICAL: Give bubble stretch factor 0 so it doesn't expand beyond its preferred size
            if is_user_msg:
                layout.addStretch(1)
                layout.addWidget(bubble, 0)  # Stretch 0 = no expansion
            else:
                layout.addWidget(bubble, 0)  # Stretch 0 = no expansion
                layout.addStretch(1)
            
            # Set initial maximum width constraint on bubble
            # This will be updated when container is resized
            def update_bubble_max_width():
                container_width = container.width()
                if container_width > 0:
                    # Leave margins (5px on each side = 10px total)
                    max_bubble_width = container_width - 10
                    bubble.setMaximumWidth(max_bubble_width)
            
            # Update after layout is complete
            QTimer.singleShot(0, update_bubble_max_width)
            
            # Also update on container resize - override resizeEvent properly
            # QWidget's default resizeEvent does nothing, so we just need to call our update function
            def resize_event_override(event):
                # QWidget.resizeEvent doesn't need to be called (it's a no-op)
                # Just update the bubble width
                update_bubble_max_width()
                # Accept the event
                event.accept()
            container.resizeEvent = resize_event_override
            
            return container
        
        # Left column (Model A) - always present
        left_container = create_column_container(bubble_a, is_user)
        row_layout.addWidget(left_container, 1)
        
        # Middle column (Model B) - only if num_models >= 2
        if self.num_models >= 2 and bubble_b is not None:
            right_container = create_column_container(bubble_b, is_user)
            row_layout.addWidget(right_container, 1)
        
        # Third column (Model C) - only if num_models == 3
        if self.num_models == 3 and bubble_c is not None:
            center_container = create_column_container(bubble_c, is_user)
            row_layout.addWidget(center_container, 1)
        
        # Set stretch factors for equal widths
        for i in range(row_layout.count()):
            row_layout.setStretch(i, 1)
        
        return row

    def _create_message_row_mixed(
        self,
        bubble_a: ChatBubble,
        is_user_a: bool,
        bubble_b: ChatBubble = None,
        is_user_b: bool = False,
        bubble_c: ChatBubble = None,
        is_user_c: bool = False,
    ):
        """Create a row where each column can be independently left/right aligned."""
        row = QWidget()
        row.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        row_layout = QHBoxLayout(row)
        row_layout.setContentsMargins(0, 0, 0, 0)
        row_layout.setSpacing(6)

        def create_column_container(bubble, is_user_msg):
            container = QWidget()
            container.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
            container.setMinimumWidth(0)
            bubble.setSizePolicy(QSizePolicy.Maximum, QSizePolicy.Preferred)

            layout = QHBoxLayout(container)
            layout.setContentsMargins(0, 0, 0, 0)
            layout.setSpacing(0)

            if is_user_msg:
                layout.addStretch(1)
                layout.addWidget(bubble, 0)
            else:
                layout.addWidget(bubble, 0)
                layout.addStretch(1)

            def update_bubble_max_width():
                container_width = container.width()
                if container_width > 0:
                    bubble.setMaximumWidth(container_width - 10)

            QTimer.singleShot(0, update_bubble_max_width)

            def resize_event_override(event):
                update_bubble_max_width()
                event.accept()

            container.resizeEvent = resize_event_override
            return container

        row_layout.addWidget(create_column_container(bubble_a, is_user_a), 1)
        if self.num_models >= 2 and bubble_b is not None:
            row_layout.addWidget(create_column_container(bubble_b, is_user_b), 1)
        if self.num_models == 3 and bubble_c is not None:
            row_layout.addWidget(create_column_container(bubble_c, is_user_c), 1)

        for i in range(row_layout.count()):
            row_layout.setStretch(i, 1)

        return row

    def start_m2m_turn(self, speaker: str):
        """
        Model-to-model: start a pending row for a speaker.
        Speaker's column shows a RIGHT-side bubble ("Thinking..."), other columns will be filled on finish.
        """
        s = (speaker or "a").strip().lower()[:1]
        self._m2m_pending_speaker = s

        bubble_a = ChatBubble("Thinking..." if s == "a" else "", is_user=(s == "a"))
        bubble_a.set_theme(self.is_dark)
        if s != "a":
            bubble_a.setVisible(False)

        bubble_b = None
        if self.num_models >= 2:
            bubble_b = ChatBubble("Thinking..." if s == "b" else "", is_user=(s == "b"))
            bubble_b.set_theme(self.is_dark)
            if s != "b":
                bubble_b.setVisible(False)

        bubble_c = None
        if self.num_models == 3:
            bubble_c = ChatBubble("Thinking..." if s == "c" else "", is_user=(s == "c"))
            bubble_c.set_theme(self.is_dark)
            if s != "c":
                bubble_c.setVisible(False)

        row = self._create_message_row_mixed(
            bubble_a, s == "a",
            bubble_b, s == "b",
            bubble_c, s == "c",
        )
        self.rows_layout.insertWidget(self.rows_layout.count() - 1, row)
        self._m2m_pending_bubbles = {"a": bubble_a, "b": bubble_b, "c": bubble_c}
        self._scroll_to_bottom()

    def finish_m2m_turn(self, speaker: str, text: str):
        """
        Model-to-model: fill the pending row started by start_m2m_turn().
        Show ONLY the speaker's message in its own column (no cross-column repeats).
        """
        s = (speaker or "a").strip().lower()[:1]
        msg = (text or "").strip()
        if not msg:
            msg = ""

        pending = self._m2m_pending_bubbles
        if not pending or self._m2m_pending_speaker != s:
            # Fallback: just add a new row
            return self.add_m2m_turn_message(s, msg)

        for col in ("a", "b", "c"):
            bubble = pending.get(col) if isinstance(pending, dict) else None
            if bubble is None:
                continue
            if col == s:
                bubble.update_text(msg)
                bubble.setVisible(True)
            else:
                bubble.update_text("")
                bubble.setVisible(False)

        self._m2m_pending_speaker = None
        self._m2m_pending_bubbles = None
        self._scroll_to_bottom()

    def add_m2m_turn_message(self, speaker: str, text: str):
        """Model-to-model: add a completed turn row with per-column left/right alignment."""
        s = (speaker or "a").strip().lower()[:1]
        msg = (text or "").strip()
        bubble_a = ChatBubble(msg if s == "a" else "", is_user=(s == "a"))
        bubble_a.set_theme(self.is_dark)
        if s != "a":
            bubble_a.setVisible(False)
        bubble_b = None
        if self.num_models >= 2:
            bubble_b = ChatBubble(msg if s == "b" else "", is_user=(s == "b"))
            bubble_b.set_theme(self.is_dark)
            if s != "b":
                bubble_b.setVisible(False)
        bubble_c = None
        if self.num_models == 3:
            bubble_c = ChatBubble(msg if s == "c" else "", is_user=(s == "c"))
            bubble_c.set_theme(self.is_dark)
            if s != "c":
                bubble_c.setVisible(False)

        row = self._create_message_row_mixed(
            bubble_a, s == "a",
            bubble_b, s == "b",
            bubble_c, s == "c",
        )
        self.rows_layout.insertWidget(self.rows_layout.count() - 1, row)
        self._scroll_to_bottom()
    
    def add_user_message(self, text: str):
        """Add user prompt to all columns on the SAME ROW"""
        # Reset response row tracking when new user message is added
        self.current_row_a_bubble = None
        self.current_row_b_bubble = None
        self.current_row_c_bubble = None
        
        # Create user bubbles for visible models only
        bubble_a = ChatBubble(text, is_user=True)
        bubble_a.set_theme(self.is_dark)
        
        bubble_b = None
        if self.num_models >= 2:
            bubble_b = ChatBubble(text, is_user=True)
            bubble_b.set_theme(self.is_dark)
        
        bubble_c = None
        if self.num_models == 3:
            bubble_c = ChatBubble(text, is_user=True)
            bubble_c.set_theme(self.is_dark)
        
        # Create a single row containing all bubbles
        row = self._create_message_row(bubble_a, bubble_b, bubble_c, is_user=True)
        
        # Insert before the stretch
        self.rows_layout.insertWidget(self.rows_layout.count() - 1, row)
        
        # Scroll to bottom
        self._scroll_to_bottom()
    
    def _ensure_response_row_exists(self):
        """Ensure a response row exists with bubbles for visible models, creating it if needed"""
        if self.current_row_a_bubble is None and self.current_row_b_bubble is None and self.current_row_c_bubble is None:
            # No row exists yet, create one with empty placeholders for visible models
            bubble_a = ChatBubble("", is_user=False)
            bubble_a.set_theme(self.is_dark)
            bubble_a.setVisible(False)
            self.current_row_a_bubble = bubble_a
            
            bubble_b = None
            if self.num_models >= 2:
                bubble_b = ChatBubble("", is_user=False)
                bubble_b.set_theme(self.is_dark)
                bubble_b.setVisible(False)
                self.current_row_b_bubble = bubble_b
            
            bubble_c = None
            if self.num_models == 3:
                bubble_c = ChatBubble("", is_user=False)
                bubble_c.set_theme(self.is_dark)
                bubble_c.setVisible(False)
                self.current_row_c_bubble = bubble_c
            
            # Create row with bubbles for visible models
            row = self._create_message_row(bubble_a, bubble_b, bubble_c, is_user=False)
            self.rows_layout.insertWidget(self.rows_layout.count() - 1, row)
    
    def start_model_a_response(self):
        """Add thinking placeholder for Model A in the shared response row"""
        self._ensure_response_row_exists()
        if self.current_row_a_bubble:
            self.current_row_a_bubble.update_text("Thinking...")
            self.current_row_a_bubble.setVisible(True)
        self._scroll_to_bottom()
    
    def start_model_b_response(self):
        """Add thinking placeholder for Model B in the shared response row"""
        if self.num_models < 2:
            return
        self._ensure_response_row_exists()
        if self.current_row_b_bubble:
            self.current_row_b_bubble.update_text("Thinking...")
            self.current_row_b_bubble.setVisible(True)
        self._scroll_to_bottom()
    
    def start_model_c_response(self):
        """Add thinking placeholder for Model C in the shared response row"""
        if self.num_models != 3:
            return
        self._ensure_response_row_exists()
        if self.current_row_c_bubble:
            self.current_row_c_bubble.update_text("Thinking...")
            self.current_row_c_bubble.setVisible(True)
        self._scroll_to_bottom()
    
    def update_model_a_response(self, text: str):
        """Update Model A's current response"""
        if not self.current_row_a_bubble:
            self._ensure_response_row_exists()
        if self.current_row_a_bubble:
            self.current_row_a_bubble.update_text(text)
            self.current_row_a_bubble.setVisible(True)
            self._scroll_to_bottom()
    
    def update_model_b_response(self, text: str):
        """Update Model B's current response"""
        if self.num_models < 2:
            return
        if not self.current_row_b_bubble:
            self._ensure_response_row_exists()
        if self.current_row_b_bubble:
            self.current_row_b_bubble.update_text(text)
            self.current_row_b_bubble.setVisible(True)
            self._scroll_to_bottom()
    
    def update_model_c_response(self, text: str):
        """Update Model C's current response"""
        if self.num_models != 3:
            return
        if not self.current_row_c_bubble:
            self._ensure_response_row_exists()
        if self.current_row_c_bubble:
            self.current_row_c_bubble.update_text(text)
            self.current_row_c_bubble.setVisible(True)
            self._scroll_to_bottom()
    
    def clear(self):
        """Clear all chat history"""
        # Remove all rows except the stretch
        while self.rows_layout.count() > 1:
            item = self.rows_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        
        self.current_row_a_bubble = None
        self.current_row_b_bubble = None
        self.current_row_c_bubble = None
        self._m2m_pending_speaker = None
        self._m2m_pending_bubbles = None
    
    def add_tool_call(self, tool_name: str, args: dict, column: str):
        """
        Add a tool call indicator to the chat.
        
        Args:
            tool_name: Name of the tool being called
            args: Tool arguments
            column: "a", "b", or "c" for which model column
        """
        import json
        
        # Format arguments for display
        args_str = json.dumps(args, indent=2) if args else "(no arguments)"
        text = f"🔧 Calling {tool_name}\n\n{args_str}"
        
        # Create tool call bubble
        bubble = ChatBubble(text, is_user=False)
        bubble.set_theme(self.is_dark)
        
        # Style as tool call (slightly different color)
        bubble.setStyleSheet("""
            ChatBubble {
                background: rgba(102, 126, 234, 0.3);
                border: 1px solid rgba(102, 126, 234, 0.5);
                border-radius: 12px;
            }
            QLabel {
                background: transparent;
                color: white;
                border: none;
            }
        """)
        
        # Add to appropriate column
        self._ensure_response_row_exists()
        
        if column.lower() == "a" and self.current_row_a_bubble is not None:
            self.current_row_a_bubble.update_text(text)
            self.current_row_a_bubble.setVisible(True)
            # Apply tool call styling
            self.current_row_a_bubble.setStyleSheet(bubble.styleSheet())
        elif column.lower() == "b" and self.num_models >= 2 and self.current_row_b_bubble is not None:
            self.current_row_b_bubble.update_text(text)
            self.current_row_b_bubble.setVisible(True)
            self.current_row_b_bubble.setStyleSheet(bubble.styleSheet())
        elif column.lower() == "c" and self.num_models == 3 and self.current_row_c_bubble is not None:
            self.current_row_c_bubble.update_text(text)
            self.current_row_c_bubble.setVisible(True)
            self.current_row_c_bubble.setStyleSheet(bubble.styleSheet())
        
        self._scroll_to_bottom()
    
    def add_tool_result(self, result: any, column: str, success: bool = True):
        """
        Add a tool result to the chat.
        
        Args:
            result: Tool result (will be JSON formatted if dict/list)
            column: "a", "b", or "c" for which model column
            success: Whether the tool execution was successful
        """
        import json
        
        # Format result
        if isinstance(result, (dict, list)):
            result_str = json.dumps(result, indent=2)
        else:
            result_str = str(result)
        
        status_icon = "✓" if success else "✗"
        status_text = "Success" if success else "Error"
        
        text = f"{status_icon} Tool Result ({status_text})\n\n{result_str}"
        
        # Create new row for tool result - only create bubbles for visible columns
        bubble_a = ChatBubble("", is_user=False)
        bubble_a.set_theme(self.is_dark)
        bubble_a.setVisible(False)
        
        bubble_b = None
        if self.num_models >= 2:
            bubble_b = ChatBubble("", is_user=False)
            bubble_b.set_theme(self.is_dark)
            bubble_b.setVisible(False)
        
        bubble_c = None
        if self.num_models == 3:
            bubble_c = ChatBubble("", is_user=False)
            bubble_c.set_theme(self.is_dark)
            bubble_c.setVisible(False)
        
        # Set text and styling for the appropriate column
        result_style = """
            ChatBubble {
                background: rgba(76, 175, 80, 0.2);
                border: 1px solid rgba(76, 175, 80, 0.4);
                border-radius: 12px;
            }
            QLabel {
                background: transparent;
                color: white;
                border: none;
                font-family: 'Consolas', 'Courier New', monospace;
                font-size: 10pt;
            }
        """ if success else """
            ChatBubble {
                background: rgba(244, 67, 54, 0.2);
                border: 1px solid rgba(244, 67, 54, 0.4);
                border-radius: 12px;
            }
            QLabel {
                background: transparent;
                color: white;
                border: none;
                font-family: 'Consolas', 'Courier New', monospace;
                font-size: 10pt;
            }
        """
        
        if column.lower() == "a":
            bubble_a.update_text(text)
            bubble_a.setVisible(True)
            bubble_a.setStyleSheet(result_style)
        elif column.lower() == "b" and bubble_b is not None:
            bubble_b.update_text(text)
            bubble_b.setVisible(True)
            bubble_b.setStyleSheet(result_style)
        elif column.lower() == "c" and bubble_c is not None:
            bubble_c.update_text(text)
            bubble_c.setVisible(True)
            bubble_c.setStyleSheet(result_style)
        
        # Create row
        row = self._create_message_row(bubble_a, bubble_b, bubble_c, is_user=False)
        self.rows_layout.insertWidget(self.rows_layout.count() - 1, row)
        
        # Reset current row tracking so next response starts fresh
        self.current_row_a_bubble = None
        self.current_row_b_bubble = None
        self.current_row_c_bubble = None
        
        self._scroll_to_bottom()
    
    def set_theme(self, dark_mode: bool):
        """Apply theme to all content"""
        self.is_dark = dark_mode
        # Update all existing bubbles
        for i in range(self.rows_layout.count() - 1):  # Exclude stretch
            row = self.rows_layout.itemAt(i).widget()
            if row:
                # Find all ChatBubble widgets in the row
                for bubble in row.findChildren(ChatBubble):
                    bubble.set_theme(dark_mode)
        self._apply_scrollbar_style()
    
    def _apply_scrollbar_style(self):
        """Apply styling to scroll area's scrollbar"""
        if self.is_dark:
            style = """
                QScrollBar:vertical {
                    background-color: #262730;
                    width: 14px;
                    border-radius: 7px;
                }
                QScrollBar::handle:vertical {
                    background-color: #667eea;
                    border-radius: 7px;
                    min-height: 30px;
                }
                QScrollBar::handle:vertical:hover {
                    background-color: #764ba2;
                }
                QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {
                    height: 0px;
                }
            """
        else:
            style = """
                QScrollBar:vertical {
                    background-color: #f0f0f0;
                    width: 14px;
                    border-radius: 7px;
                }
                QScrollBar::handle:vertical {
                    background-color: #667eea;
                    border-radius: 7px;
                    min-height: 30px;
                }
                QScrollBar::handle:vertical:hover {
                    background-color: #764ba2;
                }
                QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {
                    height: 0px;
                }
            """
        self.scroll_area.verticalScrollBar().setStyleSheet(style)
    
    def _scroll_to_bottom(self):
        """Scroll to bottom of the chat"""
        scrollbar = self.scroll_area.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())
