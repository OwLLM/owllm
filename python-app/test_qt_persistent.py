"""
Force Qt window to STAY OPEN - test if you can see it
"""
import sys
import os

os.environ['QT_QPA_PLATFORM'] = 'windows'

from PySide6.QtWidgets import QApplication, QMainWindow, QLabel, QTextEdit, QVBoxLayout, QWidget
from PySide6.QtCore import Qt, QTimer

class TestWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("DO YOU SEE THIS WINDOW?")
        self.resize(800, 600)
        self.setWindowFlags(Qt.Window | Qt.WindowStaysOnTopHint)
        
        central = QWidget()
        layout = QVBoxLayout()
        
        label = QLabel("If you see this, the window is working!")
        label.setStyleSheet("font-size: 24px; font-weight: bold; padding: 20px; background: green; color: white;")
        label.setAlignment(Qt.AlignCenter)
        
        self.log = QTextEdit()
        self.log.setReadOnly(True)
        self.log.setStyleSheet("font-size: 14px; font-family: monospace;")
        
        layout.addWidget(label)
        layout.addWidget(self.log)
        central.setLayout(layout)
        self.setCentralWidget(central)
        
        # Update log every second to prove window is alive
        self.counter = 0
        self.timer = QTimer()
        self.timer.timeout.connect(self.update_log)
        self.timer.start(1000)
        
        self.update_log()
    
    def update_log(self):
        self.counter += 1
        self.log.append(f"[{self.counter}] Window is alive and updating...")
        if self.counter == 1:
            self.log.append(f"Session: {os.environ.get('SESSIONNAME', 'Unknown')}")
            self.log.append(f"Python: {sys.executable}")
            self.log.append("")
            self.log.append("This window will stay open.")
            self.log.append("Close it with Alt+F4 or taskbar.")
    
    def closeEvent(self, event):
        self.log.append("\n[CLOSING] User requested close")
        event.accept()

def main():
    print("Creating QApplication...")
    app = QApplication(sys.argv)
    
    print("Creating persistent window...")
    window = TestWindow()
    window.show()
    window.raise_()
    window.activateWindow()
    
    print("Window is open - check your screen!")
    print("The window should stay open until you close it.")
    print(f"Window visible: {window.isVisible()}")
    
    return app.exec()

if __name__ == "__main__":
    sys.exit(main())

