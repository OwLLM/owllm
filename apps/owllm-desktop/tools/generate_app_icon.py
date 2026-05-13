"""Create src-tauri/app-icon.png (1024x1024) for `npm run tauri icon`."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    out = root / "src-tauri" / "app-icon.png"
    im = Image.new("RGBA", (1024, 1024), (26, 60, 140, 255))
    draw = ImageDraw.Draw(im)
    draw.rounded_rectangle([80, 80, 944, 944], radius=140, outline=(255, 255, 255, 90), width=8)
    out.parent.mkdir(parents=True, exist_ok=True)
    im.save(out)
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
