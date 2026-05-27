
Hybrid Frame Module (PySide6)
============================

What this is
------------
A drop-in frameless window wrapper that:
- draws a hybrid decorative frame (code + optional PNG corner/badge images)
- supports draggable + resizable behavior
- hosts your existing app UI inside a safe content area

Folder contents
---------------
hybrid_frame/
  __init__.py
  hybrid_frame_window.py
assets/
  corner_tl.png
  corner_tr.png
  corner_bl.png
  corner_br.png
  top_center.png
demo.py

How to copy into your project
-----------------------------
Option A: copy the whole `hybrid_frame/` folder into your project and import it.

Example integration
-------------------
1) Create your existing UI widget as usual (your current QMainWindow central widget,
   or your main QWidget).
2) Wrap it:

    from hybrid_frame import HybridFrameWindow, FrameAssets

    assets = FrameAssets(
        corner_tl="path/to/corner_tl.png",
        corner_tr="path/to/corner_tr.png",
        corner_bl="path/to/corner_bl.png",
        corner_br="path/to/corner_br.png",
        top_center="path/to/top_center.png",
    )

    frame = HybridFrameWindow(assets, corner_size=110, border_thickness=12)
    frame.set_content_widget(existing_main_widget)
    frame.show()

Notes
-----
- The images are purely visual; drag/resize is implemented in code.
- Content is inset automatically so it will not overlap the corners/frame.
- If you want a custom title-bar area to drag from, change mousePressEvent logic
  (currently: dragging happens when clicking outside the content area).
