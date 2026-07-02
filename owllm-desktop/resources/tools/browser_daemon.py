#!/usr/bin/env python3
"""OWLLM Browser Control daemon — a long-lived Playwright (sync API) child.

The Rust side (`src-tauri/src/browser.rs`) spawns exactly ONE of these and
talks to it over stdio: it writes newline-delimited JSON requests
`{"action": "...", "params": {...}}` to our stdin and reads exactly one
newline-delimited JSON reply `{"ok": bool, "output": "<text>"}` per request
from our stdout.

Why a persistent daemon instead of a one-shot subprocess: we launch a
PERSISTENT browser context (`launch_persistent_context`) pinned to a profile
directory, so cookies / logins survive across actions and across app runs.
The agent can log into a site once and keep using it.

Environment:
  * OWLLM_BROWSER_HEADLESS=1   -> run Chromium headless (default: headed).
  * OWLLM_BROWSER_PROFILE=<dir> -> profile dir (default: a stable app dir so
    logins persist). The Rust side normally sets this to the app's user-data
    root; the default here is the fallback when launched standalone.

Actions (all also documented in the frozen contract the frontend calls):
  navigate {url}        click {index}      back {}
  snapshot {}           fill {index,text}  reload {}
  get_text {}           press {key}        screenshot {}
  select {index,value}  close {}

`snapshot` / `get_text` return the page's interactive elements indexed
0..N (or the visible text). `click` / `fill` / `select` resolve their
{index} against the element map from the LATEST snapshot, so the normal
flow is: snapshot -> read indices -> click/fill by index.
"""

import json
import os
import sys
import time


# Interactive elements we index in a snapshot. Kept deliberately broad so the
# agent can reach menu items and custom widgets, not just native controls.
INTERACTIVE_SELECTOR = (
    "a, button, input, select, textarea, "
    "[role=button], [role=link], [role=checkbox], [role=radio], "
    "[role=tab], [role=menuitem], [role=option], [contenteditable=true], "
    "[onclick]"
)


def default_profile_dir() -> str:
    """A stable per-OS profile dir so logins survive between runs."""
    name = "OwLLM Desktop"
    if sys.platform.startswith("win"):
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
        return os.path.join(base, name, "browser_profile")
    if sys.platform == "darwin":
        return os.path.join(
            os.path.expanduser("~"), "Library", "Application Support", name, "browser_profile"
        )
    base = os.environ.get("XDG_DATA_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "share"
    )
    return os.path.join(base, name, "browser_profile")


def current_page(context):
    """The page the user/agent is currently looking at — the last open one,
    or a fresh page if the context has none (e.g. all tabs closed)."""
    pages = [p for p in context.pages if not p.is_closed()]
    if pages:
        return pages[-1]
    return context.new_page()


def _best_effort_settle(page):
    """Wait a SHORT beat for a load to settle, but never fail on timeout.

    A click frequently opens a menu / modal / same-page widget that triggers
    no navigation at all. Unconditionally waiting for `domcontentloaded`
    (Playwright's 30s default) would turn every such click into a false
    30-second failure. So we wait briefly and swallow the timeout."""
    try:
        page.wait_for_load_state("domcontentloaded", timeout=1500)
    except Exception:
        pass


def _label_for(handle) -> str:
    """A short human label for an element, best-effort across widget types."""
    label = ""
    try:
        label = (handle.inner_text() or "").strip()
    except Exception:
        label = ""
    if not label:
        for attr in ("aria-label", "placeholder", "value", "name", "title", "alt"):
            try:
                v = handle.get_attribute(attr)
            except Exception:
                v = None
            if v:
                label = v.strip()
                break
    return " ".join(label.split())[:120]


def build_snapshot(page):
    """Query the page for interactive, visible elements; return (elmap, text).

    elmap[i] = {"handle": ElementHandle, "tag": str, "label": str} so a later
    click/fill/select {index:i} resolves against the SAME element the agent
    saw. text is the indexed, human-readable listing we send back."""
    elmap = []
    lines = []
    try:
        handles = page.query_selector_all(INTERACTIVE_SELECTOR)
    except Exception:
        handles = []
    for h in handles:
        try:
            if not h.is_visible():
                continue
        except Exception:
            continue
        try:
            tag = h.evaluate("el => el.tagName.toLowerCase()")
        except Exception:
            tag = "?"
        label = _label_for(h)
        i = len(elmap)
        elmap.append({"handle": h, "tag": tag, "label": label})
        lines.append(f"[{i}] <{tag}> {label}".rstrip())
    header = f"{safe_url(page)}\n{safe_title(page)}"
    body = "\n".join(lines) if lines else "(no interactive elements found)"
    return elmap, f"{header}\n{body}"


def safe_url(page) -> str:
    try:
        return page.url
    except Exception:
        return "about:blank"


def safe_title(page) -> str:
    try:
        return page.title()
    except Exception:
        return ""


def resolve_index(elmap, params):
    """Return the ElementHandle for params['index'], or raise a helpful error."""
    idx = params.get("index")
    try:
        idx = int(idx)
    except (TypeError, ValueError):
        raise ValueError(f"'index' must be an integer, got {idx!r}")
    if not elmap:
        raise ValueError("no element map yet — run 'snapshot' first")
    if idx < 0 or idx >= len(elmap):
        raise ValueError(f"index {idx} out of range 0..{len(elmap) - 1} — re-run 'snapshot'")
    return elmap[idx]["handle"]


def main():
    headless = os.environ.get("OWLLM_BROWSER_HEADLESS", "").strip().lower() in ("1", "true", "yes")
    profile = os.environ.get("OWLLM_BROWSER_PROFILE") or default_profile_dir()

    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:
        # No JSON loop yet; emit one error line so the Rust side surfaces a
        # precise, actionable reason at browser_start rather than a bare EOF.
        emit({"ok": False, "output": (
            "Playwright is not installed for this Python. Install it:\n"
            "  python -m pip install playwright && python -m playwright install chromium\n"
            f"import error: {e}"
        )})
        sys.exit(1)

    try:
        os.makedirs(profile, exist_ok=True)
    except Exception as e:
        emit({"ok": False, "output": f"could not create profile dir {profile!r}: {e}"})
        sys.exit(1)

    with sync_playwright() as pw:
        try:
            context = pw.chromium.launch_persistent_context(
                profile,
                headless=headless,
                args=["--no-first-run", "--no-default-browser-check"],
            )
        except Exception as e:
            emit({"ok": False, "output": (
                "failed to launch Chromium. If the browser binary is missing, run:\n"
                "  python -m playwright install chromium\n"
                f"launch error: {e}"
            )})
            sys.exit(1)

        page = current_page(context)
        elmap = []
        # Startup handshake: one reply line the Rust side reads on browser_start
        # to confirm the daemon is live (and to surface a launch error above).
        emit({"ok": True, "output": f"browser daemon ready (headless={headless}, profile={profile})"})

        for raw in sys.stdin:
            line = raw.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except Exception as e:
                emit({"ok": False, "output": f"bad JSON request: {e}"})
                continue
            action = (req.get("action") or "").strip()
            params = req.get("params") or {}
            if action == "close":
                emit({"ok": True, "output": "closing browser"})
                break
            try:
                page, elmap, output = dispatch(context, page, elmap, action, params)
                emit({"ok": True, "output": output})
            except Exception as e:
                emit({"ok": False, "output": f"{action}: {e}"})

        try:
            context.close()
        except Exception:
            pass


def dispatch(context, page, elmap, action, params):
    """Run one action. Returns (page, elmap, output_text).

    page/elmap are threaded back because navigation actions swap the active
    page and rebuild the element map."""
    if action == "navigate":
        url = params.get("url")
        if not url:
            raise ValueError("missing 'url'")
        page = current_page(context)
        page.goto(url, wait_until="domcontentloaded")
        elmap, text = build_snapshot(page)
        return page, elmap, text

    if action == "snapshot":
        page = current_page(context)
        elmap, text = build_snapshot(page)
        return page, elmap, text

    if action == "get_text":
        page = current_page(context)
        try:
            text = page.inner_text("body")
        except Exception:
            text = page.content()
        return page, elmap, f"{safe_url(page)}\n{safe_title(page)}\n\n{text}"

    if action == "click":
        handle = resolve_index(elmap, params)
        handle.click()
        # A click may open a menu/modal (no navigation) OR trigger a load.
        # Wait briefly, ignore a timeout, then re-bind to the active page in
        # case the click opened/switched a tab.
        _best_effort_settle(page)
        page = current_page(context)
        elmap, text = build_snapshot(page)
        return page, elmap, f"clicked. now:\n{text}"

    if action == "fill":
        handle = resolve_index(elmap, params)
        text = params.get("text", "")
        handle.fill(text)
        return page, elmap, f"filled index {params.get('index')} with {text!r}"

    if action == "press":
        key = params.get("key")
        if not key:
            raise ValueError("missing 'key'")
        page = current_page(context)
        page.keyboard.press(key)
        _best_effort_settle(page)
        page = current_page(context)
        return page, elmap, f"pressed {key!r}"

    if action == "select":
        handle = resolve_index(elmap, params)
        value = params.get("value")
        if value is None:
            raise ValueError("missing 'value'")
        try:
            chosen = handle.select_option(value=str(value))
        except Exception:
            # Fall back to matching by visible label when value doesn't match.
            chosen = handle.select_option(label=str(value))
        return page, elmap, f"selected {value!r} (matched {chosen})"

    if action == "back":
        page = current_page(context)
        page.go_back(wait_until="domcontentloaded")
        elmap, text = build_snapshot(page)
        return page, elmap, text

    if action == "reload":
        page = current_page(context)
        page.reload(wait_until="domcontentloaded")
        elmap, text = build_snapshot(page)
        return page, elmap, text

    if action == "screenshot":
        page = current_page(context)
        # Save the PNG to a `screenshots/` dir beside the profile dir and
        # return only a short note + the file path. Inlining base64 (>100 KB)
        # would be truncated by the frontend into a non-decodable data URI and
        # would flood the model's context on every call.
        profile = os.environ.get("OWLLM_BROWSER_PROFILE") or default_profile_dir()
        shots_dir = os.path.join(os.path.dirname(profile), "screenshots")
        os.makedirs(shots_dir, exist_ok=True)
        path = os.path.abspath(os.path.join(shots_dir, f"screenshot-{time.time_ns()}.png"))
        png = page.screenshot(path=path, full_page=False)
        note = f"screenshot captured: {len(png)} bytes, {safe_url(page)}"
        return page, elmap, f"{note}\nSaved screenshot: {path}"

    raise ValueError(f"unknown action {action!r}")


def emit(obj):
    """Write one newline-delimited JSON reply and flush immediately."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
