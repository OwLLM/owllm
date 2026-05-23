"""Drive TwinForge's web_adapter to capture every Models / Home / Chat /
Train / Agents page in both dark and light themes against the live vite
dev server. Output goes to twinforge_loop_out/<page>/<mode>.png.

Run after `cd apps/owllm-desktop && npm run dev` is up at
http://localhost:5173. Uses the bundled python_runtime's playwright.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

_LLM_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_LLM_ROOT))

from playwright.sync_api import sync_playwright

OUT_ROOT = Path(__file__).resolve().parent.parent.parent / "twinforge_loop_out" / "theme-check"
OUT_ROOT.mkdir(parents=True, exist_ok=True)

PAGES = ["home", "models", "chat", "train", "agents"]
MODES = ["dark", "light"]

VIEWPORT = {"width": 1456, "height": 908}


def snap(page_key: str, mode: str) -> None:
    out_dir = OUT_ROOT / page_key
    out_dir.mkdir(parents=True, exist_ok=True)
    out_png = out_dir / f"{mode}.png"

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport=VIEWPORT)
        # Seed localStorage BEFORE the page loads so bootstrapTheme()
        # picks up the requested mode on first paint — same path the
        # real app uses, no race with React mount.
        ctx.add_init_script(
            f"""window.localStorage.setItem('owllm:theme:mode', '{mode}');
                window.localStorage.setItem('owllm:theme:accent', 'indigo');"""
        )
        page = ctx.new_page()
        url = f"http://localhost:5173/?page={page_key}"
        page.goto(url, timeout=30000)
        page.wait_for_timeout(2500)
        page.screenshot(path=str(out_png), full_page=False)
        browser.close()
    print(f"  OK {page_key}/{mode} -> {out_png}")


def main() -> None:
    print(f"OUT_ROOT = {OUT_ROOT}")
    for pg in PAGES:
        for md in MODES:
            try:
                snap(pg, md)
            except Exception as e:
                print(f"  FAIL {pg}/{md}: {e!r}")


if __name__ == "__main__":
    main()
