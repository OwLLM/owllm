import pytest
import sys
from PySide6.QtWidgets import QApplication
from desktop_app.pages.characters_3d_page import Characters3DPage

@pytest.fixture(scope="session")
def qapp():
    app = QApplication.instance()
    if app is None:
        app = QApplication(sys.argv)
    yield app

def test_characters_page_initialization(qapp, qtbot):
    """
    Test that the Characters3DPage initializes without crashing and lazy-loads properly.
    """
    page = Characters3DPage()
    qtbot.addWidget(page)
    
    assert page.web_view is not None
    assert len(page.char_combos) == 3
    assert "A" in page.char_combos
    
    # Check circuit breaker logic
    assert page.web_view.url().isEmpty() == False or "Scene Init Failed" in page.web_view.page().toHtml(lambda x: x)
