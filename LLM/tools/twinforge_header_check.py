"""Probe what color the SysInfoBlock text actually renders as in each
accent. Without this we're just eyeballing PNGs and guessing whether
black-on-amber actually shipped or whether something is overriding."""
from __future__ import annotations

import sys
from pathlib import Path

_LLM_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_LLM_ROOT))

from playwright.sync_api import sync_playwright

ACCENTS = ["indigo", "amber", "red", "blue", "emerald", "slate"]


def probe(accent: str) -> dict:
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1456, "height": 908})
        ctx.add_init_script(
            f"""window.localStorage.setItem('owllm:theme:mode', 'dark');
                window.localStorage.setItem('owllm:theme:accent', '{accent}');"""
        )
        page = ctx.new_page()
        page.goto("http://localhost:5173/?page=home", timeout=30000)
        page.wait_for_timeout(2000)
        info = page.evaluate(
            """() => {
                const html = document.documentElement;
                const cs = getComputedStyle(html);
                const bgHeaderFg = cs.getPropertyValue('--bg-header-fg').trim();
                const bgHeader = cs.getPropertyValue('--bg-header').trim();
                const accent = cs.getPropertyValue('--accent').trim();
                const sys = document.querySelector('[data-ui=SysInfoBlock]');
                const sysCs = sys ? getComputedStyle(sys) : null;
                const sersLabel = document.querySelector('[data-ui=HeaderServersLabel]');
                const sersCs = sersLabel ? getComputedStyle(sersLabel) : null;
                return {
                    accent,
                    bgHeader,
                    bgHeaderFg,
                    sysColor: sysCs ? sysCs.color : 'NO SysInfoBlock',
                    serversLabelColor: sersCs ? sersCs.color : 'NO label',
                };
            }"""
        )
        browser.close()
    return info


for ac in ACCENTS:
    info = probe(ac)
    print(f"{ac:8s} accent={info['accent']:10s} bg-header={info['bgHeader']:30s} bg-header-fg={info['bgHeaderFg']:10s}  SysInfo.color={info['sysColor']}  Label.color={info['serversLabelColor']}")
