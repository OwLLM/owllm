"""CLI entry: `python -m core.ui_agent compare ...`.

Lets a user (or shell script) run the agent without writing Python. The
command is platform-blind: pass `--source-adapter qt --source-page agents`
to capture the OWLLM Qt app, `--target-adapter web --target-url path.html`
to capture a web replica, then the diff core does the rest.

Adding a new adapter is a single dispatch entry in `_ADAPTERS` below.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from core.ui_agent import agent
from core.ui_agent.adapters import qt_adapter, web_adapter


def _capture_qt(target: str, out_png: str, out_tree: str,
                width: int, height: int, **kw):
    return qt_adapter.capture(
        page=target, out_png=out_png, out_tree=out_tree,
        width=width, height=height,
        wait_seconds=float(kw.get("wait_seconds", 5.0)),
        include_frame=bool(kw.get("include_frame", True)),
    )


def _capture_web(target: str, out_png: str, out_tree: str,
                 width: int, height: int, **kw):
    return web_adapter.capture(
        url_or_path=target, out_png=out_png, out_tree=out_tree,
        width=width, height=height,
        wait_ms=int(kw.get("wait_ms", 2500)),
    )


_ADAPTERS = {"qt": _capture_qt, "web": _capture_web}


def _cmd_compare(args: argparse.Namespace) -> int:
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    if args.source_adapter not in _ADAPTERS:
        print(f"unknown source adapter: {args.source_adapter}; "
              f"choices: {sorted(_ADAPTERS)}", file=sys.stderr)
        return 2
    if args.target_adapter not in _ADAPTERS:
        print(f"unknown target adapter: {args.target_adapter}; "
              f"choices: {sorted(_ADAPTERS)}", file=sys.stderr)
        return 2

    print(f"[capture] {args.source_adapter} ← {args.source_target}")
    src = _ADAPTERS[args.source_adapter](
        target=args.source_target,
        out_png=str(out / "source.png"),
        out_tree=str(out / "source_tree.json"),
        width=args.source_width, height=args.source_height,
    )
    print(f"[capture] {args.target_adapter} ← {args.target_target}")
    tgt = _ADAPTERS[args.target_adapter](
        target=args.target_target,
        out_png=str(out / "target.png"),
        out_tree=str(out / "target_tree.json"),
        width=args.target_width, height=args.target_height,
    )
    print("[diff] running region-aware comparison…")
    result = agent.compare(
        src, tgt,
        report_path=str(out / "report.txt"),
        overlay_path=str(out / "overlay.png"),
        tile_grid_path=str(out / "tile_grid.png"),
        html_report_path=str(out / "report.html"),
        title=args.title or "UI Agent · diff report",
    )
    print(f"[done] overall pixel diff: {result['overall_pct']:.2f}%; "
          f"{len(result['regions'])} matched regions")
    print(f"       report.html : {out / 'report.html'}")
    print(f"       tile_grid   : {out / 'tile_grid.png'}")
    print(f"       overlay     : {out / 'overlay.png'}")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m core.ui_agent")
    sub = parser.add_subparsers(dest="cmd", required=True)

    cmp_ = sub.add_parser("compare", help="diff two captures")
    cmp_.add_argument("--source-adapter", default="qt",
                      choices=sorted(_ADAPTERS), help="adapter for the source")
    cmp_.add_argument("--source-target", required=True,
                      help="page name (qt) or URL/path (web)")
    cmp_.add_argument("--source-width", type=int, default=1600)
    cmp_.add_argument("--source-height", type=int, default=960)
    cmp_.add_argument("--target-adapter", default="web",
                      choices=sorted(_ADAPTERS), help="adapter for the target")
    cmp_.add_argument("--target-target", required=True,
                      help="page name (qt) or URL/path (web)")
    cmp_.add_argument("--target-width", type=int, default=1700)
    cmp_.add_argument("--target-height", type=int, default=1100)
    cmp_.add_argument("--out-dir", default="ui_agent_out",
                      help="where to write screenshots, trees, and the report")
    cmp_.add_argument("--title", default=None,
                      help="title for the generated HTML report")

    args = parser.parse_args(argv)
    if args.cmd == "compare":
        return _cmd_compare(args)
    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
