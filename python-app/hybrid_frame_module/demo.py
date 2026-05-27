
import sys
from PySide6.QtWidgets import QApplication, QLabel
from PySide6.QtCore import Qt
from hybrid_frame import HybridFrameWindow, FrameAssets


def main():
    app = QApplication(sys.argv)

    assets = FrameAssets(
        corner_tl="assets/corner_tl.png",
        corner_tr="assets/corner_tr.png",
        corner_bl="assets/corner_bl.png",
        corner_br="assets/corner_br.png",
        top_center="assets/top_center.png",
    )

    frame = HybridFrameWindow(assets, corner_size=110, border_thickness=12)

    # Example content (replace with your existing main widget)
    content = QLabel("YOUR APP UI GOES HERE")
    content.setAlignment(Qt.AlignCenter)
    content.setStyleSheet("background: rgba(20, 20, 20, 180); border-radius: 12px; color: white;")

    frame.set_content_widget(content)
    frame.resize(900, 560)
    frame.show()

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
