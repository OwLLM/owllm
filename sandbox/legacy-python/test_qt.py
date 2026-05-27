"""
Minimal Qt test - does PySide6 work at all?
"""
import sys
import os

# CRITICAL FIX for RDP sessions - set Qt platform before importing Qt
os.environ['QT_QPA_PLATFORM'] = 'windows'
# Force Qt to stay in the current session
os.environ['QT_AUTO_SCREEN_SCALE_FACTOR'] = '1'

from PySide6.QtWidgets import QApplication, QMainWindow, QLabel, QPushButton, QVBoxLayout, QWidget
from PySide6.QtCore import Qt

def main():
    print("="*60)
    print("Qt Test Starting...")
    print(f"Python: {sys.executable}")
    print(f"Session: {os.environ.get('SESSIONNAME', 'Unknown')}")
    print("="*60)
    
    print("\n[1/5] Creating QApplication...")
    sys.stdout.flush()
    app = QApplication(sys.argv)
    print("      OK - QApplication created")
    sys.stdout.flush()
    
    print("\n[2/5] Creating window...")
    sys.stdout.flush()
    window = QMainWindow()
    window.setWindowTitle("Qt Test - If you see this, Qt works!")
    window.resize(600, 400)
    print("      OK - Window created")
    sys.stdout.flush()
    
    print("\n[3/5] Adding widgets...")
    sys.stdout.flush()
    central = QWidget()
    layout = QVBoxLayout()
    
    label = QLabel("SUCCESS! Qt is working!\n\nIf you see this window, everything is fine.")
    label.setAlignment(Qt.AlignCenter)
    label.setStyleSheet("font-size: 20px; padding: 30px;")
    
    button = QPushButton("Click me to exit")
    button.clicked.connect(app.quit)
    button.setStyleSheet("font-size: 16px; padding: 10px;")
    
    layout.addWidget(label)
    layout.addWidget(button)
    central.setLayout(layout)
    window.setCentralWidget(central)
    print("      OK - Widgets added")
    sys.stdout.flush()
    
    print("\n[4/5] Showing window...")
    sys.stdout.flush()
    window.show()
    window.raise_()
    window.activateWindow()
    print("      OK - Window.show() called")
    print(f"      Window visible: {window.isVisible()}")
    print(f"      Window active: {window.isActiveWindow()}")
    sys.stdout.flush()
    
    print("\n[5/5] Entering event loop...")
    print("      Waiting for user to close window...")
    print("      (If you don't see a window, there's a display issue)")
    sys.stdout.flush()
    
    result = app.exec()
    
    print(f"\n[DONE] Event loop exited with code: {result}")
    sys.stdout.flush()
    return result

if __name__ == "__main__":
    try:
        exit_code = main()
        print(f"\nExiting with code: {exit_code}")
        sys.exit(exit_code)
    except Exception as e:
        print(f"\n[ERROR] Exception: {e}")
        import traceback
        traceback.print_exc()
        input("\nPress Enter to exit...")
        sys.exit(1)

