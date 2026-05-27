#!/usr/bin/env python3
"""
First-Run Setup Wizard for LLM Fine-tuning Studio
Automatically detects hardware and installs all dependencies
"""

import sys
import json
from pathlib import Path
from datetime import datetime
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QLabel, QPushButton, QProgressBar, QTextEdit, QFrame
)
from PySide6.QtCore import Qt, QThread, Signal, QTimer
from PySide6.QtGui import QFont, QPixmap, QTextCursor

# Import our detection and installation modules
from system_detector import SystemDetector
from installer_v2 import InstallerV2


class SetupThread(QThread):
    """Background thread for running setup operations"""
    progress = Signal(str)  # Progress message
    hardware_detected = Signal(dict)  # Hardware detection results
    install_progress = Signal(str, int)  # Package name, progress percentage
    install_complete = Signal(bool, str)  # Success, message
    
    def __init__(self, parent=None):
        super().__init__(parent)
        self.detector = SystemDetector()
        self.installer = InstallerV2()
        self.should_stop = False
    
    def run(self):
        """Run the complete setup process"""
        try:
            # Phase 1: Hardware Detection
            self.progress.emit("🔍 Detecting hardware and system components...")
            detection_results = self.detector.detect_all()
            self.hardware_detected.emit(detection_results)
            
            if self.should_stop:
                return
            
            # Phase 2: Install Dependencies
            self.progress.emit("📦 Installing dependencies...")
            
            # Set up logging callback for InstallerV2
            def log_callback(message):
                self.progress.emit(message)
            
            self.installer.log = log_callback
            
            # Run the installer
            success = self._install_all_dependencies(detection_results)
            
            if success:
                # Phase 3: Verification
                self.progress.emit("✅ Verifying installation...")
                verification_passed = self._verify_installation()
                
                if verification_passed:
                    self.install_complete.emit(True, "Setup completed successfully!")
                else:
                    self.install_complete.emit(False, "Installation verification failed. Please check the logs.")
            else:
                self.install_complete.emit(False, "Installation failed. Please check the logs.")
                
        except Exception as e:
            self.install_complete.emit(False, f"Setup error: {str(e)}")
    
    def _install_all_dependencies(self, detection_results: dict) -> bool:
        """Install all required dependencies"""
        try:
            # Redirect print to progress
            import builtins
            original_print = builtins.print
            
            def progress_print(*args, **kwargs):
                import io
                buffer = io.StringIO()
                kwargs_copy = kwargs.copy()
                kwargs_copy['file'] = buffer
                original_print(*args, **kwargs_copy)
                message = buffer.getvalue().rstrip()
                if message:
                    self.progress.emit(message)
                original_print(*args, **kwargs)
            
            builtins.print = progress_print
            
            try:
                # Run immutable installer
                self.install_progress.emit("Installing", 50)
                success = self.installer.install()
                self.install_progress.emit("Installing", 100)
                return success
            finally:
                builtins.print = original_print
            
        except Exception as e:
            self.progress.emit(f"❌ Installation error: {str(e)}")
            return False
    
    def _verify_installation(self) -> bool:
        """Verify the installation"""
        try:
            # Try importing critical packages
            import torch
            self.progress.emit(f"✓ PyTorch {torch.__version__}")
            
            if torch.cuda.is_available():
                self.progress.emit(f"✓ CUDA available: {torch.cuda.get_device_name(0)}")
            
            try:
                import unsloth
                self.progress.emit("✓ Unsloth available")
            except ImportError:
                self.progress.emit("⚠ Unsloth not available (optional)")
            
            return True
            
        except Exception as e:
            self.progress.emit(f"❌ Verification failed: {str(e)}")
            return False
    
    def stop(self):
        """Stop the setup thread"""
        self.should_stop = True


class FirstRunSetup(QMainWindow):
    """First-run setup wizard window"""
    
    def __init__(self):
        super().__init__()
        self.setWindowTitle("🚀 LLM Fine-tuning Studio - First Time Setup")
        self.setWindowFlags(self.windowFlags() | Qt.WindowStaysOnTopHint)  # Always on top
        self.setMinimumSize(1000, 700)  # Wider for 2-column layout
        
        # Setup state
        self.setup_complete = False
        self.hardware_info = {}
        self.setup_thread = None
        
        self._build_ui()
        self._apply_styles()
        
        # Auto-start setup after UI is shown
        QTimer.singleShot(500, self._start_setup)
    
    def _build_ui(self):
        """Build the setup wizard UI"""
        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        main_layout = QVBoxLayout(central_widget)
        main_layout.setSpacing(20)
        main_layout.setContentsMargins(40, 40, 40, 40)
        
        # Header
        header = QLabel("🚀 LLM Fine-tuning Studio")
        header_font = QFont()
        header_font.setPointSize(32)
        header_font.setBold(True)
        header.setFont(header_font)
        header.setAlignment(Qt.AlignCenter)
        main_layout.addWidget(header)
        
        subtitle = QLabel("First-Time Setup Wizard")
        subtitle_font = QFont()
        subtitle_font.setPointSize(16)
        subtitle.setFont(subtitle_font)
        subtitle.setAlignment(Qt.AlignCenter)
        main_layout.addWidget(subtitle)
        
        main_layout.addSpacing(20)
        
        # Status message
        self.status_label = QLabel("Initializing setup...")
        status_font = QFont()
        status_font.setPointSize(14)
        self.status_label.setFont(status_font)
        self.status_label.setAlignment(Qt.AlignCenter)
        main_layout.addWidget(self.status_label)
        
        # 2-COLUMN LAYOUT
        columns_layout = QHBoxLayout()
        columns_layout.setSpacing(20)
        
        # LEFT COLUMN: Hardware Detection
        left_column = QWidget()
        left_layout = QVBoxLayout(left_column)
        left_layout.setContentsMargins(0, 0, 0, 0)
        
        hardware_frame = QFrame()
        hardware_frame.setObjectName("hardwareFrame")
        hardware_layout = QVBoxLayout(hardware_frame)
        
        hardware_title = QLabel("Hardware Detection")
        hardware_title_font = QFont()
        hardware_title_font.setPointSize(14)
        hardware_title_font.setBold(True)
        hardware_title.setFont(hardware_title_font)
        hardware_layout.addWidget(hardware_title)
        
        self.hardware_display = QLabel("Waiting for detection...")
        self.hardware_display.setWordWrap(True)
        self.hardware_display.setAlignment(Qt.AlignTop | Qt.AlignLeft)
        hardware_display_font = QFont()
        hardware_display_font.setPointSize(12)
        self.hardware_display.setFont(hardware_display_font)
        hardware_layout.addWidget(self.hardware_display)
        hardware_layout.addStretch(1)  # Push content to top
        
        left_layout.addWidget(hardware_frame)
        columns_layout.addWidget(left_column, 1)  # 1 part
        
        # RIGHT COLUMN: Installation Progress + Log
        right_column = QWidget()
        right_layout = QVBoxLayout(right_column)
        right_layout.setContentsMargins(0, 0, 0, 0)
        
        # Progress bar (indeterminate by default)
        self.progress_bar = QProgressBar()
        self.progress_bar.setTextVisible(True)
        self.progress_bar.setMinimumHeight(30)
        self.progress_bar.setRange(0, 0)  # Indeterminate
        right_layout.addWidget(self.progress_bar)
        
        # Download progress bar (for PyTorch downloads)
        self.download_progress = QProgressBar()
        self.download_progress.setTextVisible(True)
        self.download_progress.setMinimumHeight(25)
        self.download_progress.setRange(0, 100)
        self.download_progress.setValue(0)
        self.download_progress.setFormat("Ready to download...")
        self.download_progress.setVisible(False)  # Hidden initially
        right_layout.addWidget(self.download_progress)
        
        # Log viewer with dynamic sizing
        log_frame = QFrame()
        log_frame.setObjectName("logFrame")
        log_layout = QVBoxLayout(log_frame)
        
        log_title = QLabel("Installation Log")
        log_title_font = QFont()
        log_title_font.setPointSize(12)
        log_title_font.setBold(True)
        log_title.setFont(log_title_font)
        log_layout.addWidget(log_title)
        
        self.log_viewer = QTextEdit()
        self.log_viewer.setReadOnly(True)
        self.log_viewer.setLineWrapMode(QTextEdit.LineWrapMode.WidgetWidth)  # Wrap long lines
        self.log_viewer.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)  # No horizontal scroll
        self.log_viewer.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        log_font = QFont("Consolas", 9)  # Slightly smaller for more content
        self.log_viewer.setFont(log_font)
        log_layout.addWidget(self.log_viewer, 1)  # Take all available space
        
        right_layout.addWidget(log_frame, 1)  # Stretch to fill
        columns_layout.addWidget(right_column, 1)  # 1 part (equal width)
        
        main_layout.addLayout(columns_layout, 1)  # Take all remaining vertical space
        
        # Buttons
        button_layout = QHBoxLayout()
        button_layout.addStretch()
        
        self.cancel_btn = QPushButton("Cancel")
        self.cancel_btn.setMinimumSize(120, 40)
        self.cancel_btn.clicked.connect(self._cancel_setup)
        button_layout.addWidget(self.cancel_btn)
        
        self.finish_btn = QPushButton("Launch Application")
        self.finish_btn.setMinimumSize(180, 40)
        self.finish_btn.setEnabled(False)
        self.finish_btn.clicked.connect(self._finish_setup)
        button_layout.addWidget(self.finish_btn)
        
        main_layout.addLayout(button_layout)
    
    def _apply_styles(self):
        """Apply modern styling"""
        self.setStyleSheet("""
            QMainWindow {
                background: qlineargradient(
                    x1:0, y1:0, x2:1, y2:1,
                    stop:0 #0f0f1e, stop:1 #1a1a2e
                );
            }
            QLabel {
                color: #e0e0e0;
            }
            QFrame#hardwareFrame, QFrame#logFrame {
                background-color: rgba(30, 30, 45, 0.8);
                border: 1px solid #3a3a5a;
                border-radius: 12px;
                padding: 15px;
            }
            QProgressBar {
                border: 2px solid #3a3a5a;
                border-radius: 8px;
                background-color: #1a1a2e;
                text-align: center;
                color: #ffffff;
                font-size: 12pt;
            }
            QProgressBar::chunk {
                background: qlineargradient(
                    x1:0, y1:0, x2:1, y2:0,
                    stop:0 #667eea, stop:1 #764ba2
                );
                border-radius: 6px;
            }
            QTextEdit {
                background-color: #0a0a0a;
                color: #00ff00;
                border: 1px solid #3a3a5a;
                border-radius: 8px;
                padding: 8px;
            }
            QPushButton {
                background: qlineargradient(
                    x1:0, y1:0, x2:0, y2:1,
                    stop:0 #667eea, stop:1 #764ba2
                );
                color: white;
                border: none;
                border-radius: 8px;
                font-size: 14pt;
                font-weight: bold;
                padding: 8px 16px;
            }
            QPushButton:hover {
                background: qlineargradient(
                    x1:0, y1:0, x2:0, y2:1,
                    stop:0 #764ba2, stop:1 #667eea
                );
            }
            QPushButton:disabled {
                background-color: #3a3a5a;
                color: #808080;
            }
        """)
    
    def _start_setup(self):
        """Start the setup process"""
        self._log("Starting first-time setup...")
        self._log("This may take 5-15 minutes depending on your hardware and internet speed.")
        
        # Create and start setup thread
        self.setup_thread = SetupThread(self)
        self.setup_thread.progress.connect(self._on_progress)
        self.setup_thread.hardware_detected.connect(self._on_hardware_detected)
        self.setup_thread.install_progress.connect(self._on_install_progress)
        self.setup_thread.install_complete.connect(self._on_install_complete)
        self.setup_thread.start()
    
    def _log(self, message: str):
        """Add message to log viewer"""
        self.log_viewer.append(message)
        # Auto-scroll to bottom
        cursor = self.log_viewer.textCursor()
        cursor.movePosition(QTextCursor.MoveOperation.End)
        self.log_viewer.setTextCursor(cursor)
    
    def _on_progress(self, message: str):
        """Handle progress updates"""
        self.status_label.setText(message)
        self._log(message)
    
    def _on_hardware_detected(self, results: dict):
        """Display hardware detection results"""
        self.hardware_info = results
        
        # Build display text
        lines = []
        
        # Python info
        python = results.get("python", {})
        if python.get("found"):
            lines.append(f"✓ Python {python.get('version')}")
        
        # Hardware info
        hw = results.get("hardware", {})
        if hw:
            lines.append(f"✓ CPU: {hw.get('cpu_name', 'Unknown')}")
            lines.append(f"✓ RAM: {hw.get('ram_gb', 0):.1f} GB")
        
        # GPU info
        cuda = results.get("cuda", {})
        if cuda.get("available"):
            gpus = cuda.get("gpus", [])
            if gpus:
                for i, gpu in enumerate(gpus):
                    gpu_name = gpu.get('name', 'Unknown')
                    # Shorten GPU name for display (remove NVIDIA prefix if present)
                    gpu_name = gpu_name.replace("NVIDIA ", "").replace("GeForce ", "")
                    lines.append(f"✓ GPU {i}: {gpu_name}")
                cuda_ver = cuda.get("cuda_version", "N/A")
                lines.append(f"✓ CUDA: {cuda_ver}")
        else:
            lines.append("ℹ No GPU detected (CPU-only mode)")
        
        # PyTorch info
        pytorch = results.get("pytorch", {})
        if pytorch.get("found"):
            lines.append(f"✓ PyTorch {pytorch.get('version')} already installed")
        else:
            lines.append("ℹ PyTorch will be installed")
        
        self.hardware_display.setText("\n".join(lines))
    
    def _on_install_progress(self, package: str, progress: int):
        """Update progress bar for specific package"""
        if package == "PyTorch":
            # Show download progress bar
            self.download_progress.setVisible(True)
            if progress > 0:
                self.download_progress.setValue(progress)
                self.download_progress.setFormat(f"Downloading PyTorch: {progress}%")
            else:
                self.download_progress.setValue(0)
                self.download_progress.setFormat("Starting download...")
        else:
            # Other packages use main progress bar
            if progress == 0:
                self.progress_bar.setRange(0, 0)  # Indeterminate
                self.status_label.setText(f"Installing {package}...")
            else:
                self.progress_bar.setRange(0, 100)
                self.progress_bar.setValue(progress)
    
    def _on_install_complete(self, success: bool, message: str):
        """Handle installation completion"""
        self._log("\n" + "="*50)
        self._log(message)
        self._log("="*50)
        
        if success:
            self.status_label.setText("✅ Setup Complete!")
            self.progress_bar.setRange(0, 100)
            self.progress_bar.setValue(100)
            self.finish_btn.setEnabled(True)
            self.cancel_btn.setText("Exit")
            self.setup_complete = True
            
            # Save setup state
            self._save_setup_state()
        else:
            self.status_label.setText("❌ Setup Failed")
            self.progress_bar.setRange(0, 100)
            self.progress_bar.setValue(0)
            self.cancel_btn.setText("Retry")
    
    def _save_setup_state(self):
        """Save setup completion state to file"""
        try:
            state = {
                "setup_complete": True,
                "setup_date": datetime.now().isoformat(),
                "hardware": {
                    "cpu": self.hardware_info.get("hardware", {}).get("cpu_name", "Unknown"),
                    "ram_gb": self.hardware_info.get("hardware", {}).get("ram_gb", 0),
                    "gpu": self.hardware_info.get("cuda", {}).get("gpus", [{}])[0].get("name", "N/A") if self.hardware_info.get("cuda", {}).get("available") else "CPU-only",
                    "cuda_driver": self.hardware_info.get("cuda", {}).get("driver_version", "N/A"),
                },
                "installed_versions": {
                    "python": self.hardware_info.get("python", {}).get("version", "Unknown"),
                    "pytorch": self.hardware_info.get("pytorch", {}).get("version", "Unknown"),
                },
                "last_check": datetime.now().isoformat()
            }
            
            # Save to both marker file and state JSON
            state_file = Path(__file__).parent / ".setup_state.json"
            with open(state_file, 'w') as f:
                json.dump(state, f, indent=2)
            
            # Create simple marker file
            marker_file = Path(__file__).parent / ".setup_complete"
            marker_file.touch()
            
            self._log(f"✓ Setup state saved to {state_file}")
            
        except Exception as e:
            self._log(f"⚠ Warning: Could not save setup state: {str(e)}")
    
    def _cancel_setup(self):
        """Cancel the setup"""
        if self.setup_complete:
            # Retry button
            self.setup_complete = False
            self.finish_btn.setEnabled(False)
            self.cancel_btn.setText("Cancel")
            self.log_viewer.clear()
            self._start_setup()
        else:
            # Cancel/stop
            if self.setup_thread and self.setup_thread.isRunning():
                self.setup_thread.stop()
                self.setup_thread.wait(3000)  # Wait up to 3 seconds
            QApplication.quit()
    
    def _finish_setup(self):
        """Finish setup and close wizard"""
        self.close()
        QApplication.quit()


def main():
    """Main entry point for first-run setup"""
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    
    window = FirstRunSetup()
    window.show()
    
    sys.exit(app.exec())


if __name__ == "__main__":
    main()

