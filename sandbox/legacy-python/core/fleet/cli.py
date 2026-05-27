"""Fleet CLI — drive the broker + workspace runtime from a terminal.

Subcommands::

    spawn      reserve resources, clone target repo, write context
    finish     push branch (optionally open PR via gh), release claim
    list       list active (or all) claims as JSON
    heartbeat  refresh an agent's TTL
    reap       release every claim past its TTL

Default fleet state lives under ``~/.owllm/fleet/`` (manifest.sqlite +
workspaces/). Override with ``--db`` / ``--workspace-root`` or env
vars ``OWLLM_FLEET_DB`` / ``OWLLM_FLEET_ROOT``.

Output is JSON on stdout for every command that returns data, so
callers (UI, scripts, the future Supervisor) can parse without
screen-scraping. Errors go to stderr; non-zero exit codes:

    2  claim refused (overlap or pool exhausted)
    3  workspace setup failed (claim was rolled back)
    4  unknown agent_id
    5  workspace teardown failed
    6  no active claim for that agent_id (heartbeat target gone)
"""
from __future__ import annotations

import argparse
import contextlib
import json
import logging
import shlex
import sys
import uuid
from typing import Iterator, List, Optional

from core.fleet.broker import Broker, PoolConfig, PoolExhausted
from core.fleet.config import (
    DEFAULT_PORT_HIGH,
    DEFAULT_PORT_LOW,
    default_db,
    default_process_index,
    default_workspaces,
)
from core.fleet.manifest import Claim, ClaimConflict, Manifest
from core.fleet.process import ProcessRegistry
from core.fleet.runtime import default_runtime
from core.fleet.workspace import (
    WorkspaceError,
    setup_workspace,
    teardown_workspace,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Broker lifecycle
# ---------------------------------------------------------------------------


@contextlib.contextmanager
def _open_broker(args: argparse.Namespace) -> Iterator[Broker]:
    pool = PoolConfig(
        workspace_root=default_workspaces(args.workspace_root),
        port_range=range(args.port_low, args.port_high),
        gpu_slots=tuple(args.gpu_slots) if args.gpu_slots else (),
    )
    manifest = Manifest(default_db(args.db))
    manifest.open()
    try:
        yield Broker(manifest, pool)
    finally:
        manifest.close()


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_spawn(args: argparse.Namespace) -> int:
    agent_id = args.agent_id or f"agent-{uuid.uuid4().hex[:8]}"
    with _open_broker(args) as broker:
        try:
            claim = broker.spawn_claim(
                agent_id=agent_id,
                target_repo=args.target_repo,
                branch=args.branch,
                owns_modules=args.owns or [],
                reads_modules=args.reads or [],
                ttl_seconds=args.ttl,
                reason=args.reason or "",
                port=args.port,
                gpu_slot=args.gpu_slot,
            )
        except (ClaimConflict, PoolExhausted) as e:
            print(f"refused: {e}", file=sys.stderr)
            return 2

        try:
            layout = setup_workspace(claim, base_branch=args.base_branch)
        except WorkspaceError as e:
            # Roll back the claim — the agent never came alive.
            broker.release(agent_id)
            print(f"workspace setup failed (claim released): {e}",
                  file=sys.stderr)
            return 3

    # Optional: launch the configured CLI inside the workspace and
    # register the resulting handle in the persistent registry so
    # other fleet clients (the UI, ops scripts) can discover it.
    # Failure to launch is non-fatal: the workspace is up, the user
    # can still launch manually.
    process_info: Optional[dict] = None
    if args.launch_command:
        argv = shlex.split(args.launch_command)
        try:
            handle = default_runtime().start(claim, layout, argv)
            ProcessRegistry(default_process_index()).register(handle)
            process_info = handle.to_dict()
        except Exception as e:
            print(f"launch failed (workspace is up): {e}", file=sys.stderr)
            process_info = {"launch_error": str(e)}

    print(json.dumps({
        "agent_id": claim.agent_id,
        "workspace": str(layout.root),
        "clone": str(layout.clone),
        "context_file": str(layout.context_file),
        "target_repo": claim.target_repo,
        "branch": claim.branch,
        "owns_modules": claim.owns_modules,
        "reads_modules": claim.reads_modules,
        "port": claim.port,
        "gpu_slot": claim.gpu_slot,
        "ttl_seconds": claim.ttl_seconds,
        "process": process_info,
    }, indent=2, default=str))
    return 0


def cmd_finish(args: argparse.Namespace) -> int:
    with _open_broker(args) as broker:
        claim = broker.get(args.agent_id)
        if claim is None:
            print(f"unknown agent: {args.agent_id}", file=sys.stderr)
            return 4

        # Stop the registered process FIRST so its file handles release
        # the clone (otherwise rmtree fails on Windows). Use the
        # persistent registry so this works whether the agent was
        # launched by THIS CLI invocation, by a previous one, or by
        # the UI.
        registry = ProcessRegistry(default_process_index())
        handle = registry.pop(args.agent_id)
        if handle is not None:
            try:
                default_runtime().stop(handle)
            except Exception as e:
                print(f"warning: stopping process failed: {e}",
                      file=sys.stderr)

        pr_url: Optional[str] = None
        teardown_failed: Optional[str] = None
        try:
            pr_url = teardown_workspace(
                claim,
                push=not args.no_push,
                open_pr=args.pr,
                pr_title=args.pr_title or "",
                pr_body=args.pr_body or "",
            )
        except WorkspaceError as e:
            teardown_failed = str(e)
        finally:
            broker.release(args.agent_id)

    if teardown_failed is not None:
        print(f"teardown failed (claim released anyway): {teardown_failed}",
              file=sys.stderr)
        return 5

    out = {"agent_id": args.agent_id, "released": True}
    if pr_url:
        out["pr_url"] = pr_url
    print(json.dumps(out, indent=2))
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    with _open_broker(args) as broker:
        claims: List[Claim] = (
            broker.manifest.list_all() if args.all
            else broker.list_active()
        )
    print(json.dumps([_claim_to_dict(c) for c in claims], indent=2))
    return 0


def cmd_heartbeat(args: argparse.Namespace) -> int:
    with _open_broker(args) as broker:
        ok = broker.heartbeat(args.agent_id)
    if ok:
        print(json.dumps({"agent_id": args.agent_id, "heartbeat": "ok"}))
        return 0
    print(f"no active claim for {args.agent_id}", file=sys.stderr)
    return 6


def cmd_reap(args: argparse.Namespace) -> int:
    with _open_broker(args) as broker:
        reaped = broker.reap_stale()
    print(json.dumps(
        {"reaped": [_claim_to_dict(c) for c in reaped]}, indent=2,
    ))
    return 0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _claim_to_dict(c: Claim) -> dict:
    return {
        "agent_id": c.agent_id,
        "target_repo": c.target_repo,
        "branch": c.branch,
        "workspace_path": c.workspace_path,
        "owns_modules": c.owns_modules,
        "reads_modules": c.reads_modules,
        "port": c.port,
        "gpu_slot": c.gpu_slot,
        "gpu_mode": c.gpu_mode,
        "status": c.status,
        "reason": c.reason,
        "started_at": c.started_at,
        "last_heartbeat": c.last_heartbeat,
        "ttl_seconds": c.ttl_seconds,
    }


def _add_global_args(p: argparse.ArgumentParser) -> None:
    p.add_argument(
        "--db",
        help="path to manifest SQLite (env: OWLLM_FLEET_DB; default: ~/.owllm/fleet/manifest.sqlite)",
    )
    p.add_argument(
        "--workspace-root",
        help="root for per-agent workspaces (env: OWLLM_FLEET_ROOT; default: ~/.owllm/fleet/workspaces)",
    )
    p.add_argument("--port-low", type=int, default=DEFAULT_PORT_LOW,
                   help=f"inclusive low end of broker port pool (default: {DEFAULT_PORT_LOW})")
    p.add_argument("--port-high", type=int, default=DEFAULT_PORT_HIGH,
                   help=f"exclusive high end of broker port pool (default: {DEFAULT_PORT_HIGH})")
    p.add_argument("--gpu-slots", type=int, nargs="*", default=None,
                   help="ordered list of GPU slot ids the broker may hand out")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m core.fleet")
    sub = p.add_subparsers(dest="command", required=True)

    sp = sub.add_parser(
        "spawn",
        help="reserve resources, clone target repo, write AGENT_CONTEXT.md",
    )
    _add_global_args(sp)
    sp.add_argument("--target-repo", required=True,
                    help="git URL or local path to clone")
    sp.add_argument("--branch", required=True,
                    help="branch name the agent will work on (must not exist on remote)")
    sp.add_argument("--owns", action="append",
                    help="glob the agent may edit (repeat for multiple)")
    sp.add_argument("--reads", action="append",
                    help="glob the agent may read (advisory)")
    sp.add_argument("--reason", default="",
                    help="short task description, surfaced in context + PR body")
    sp.add_argument("--ttl", type=int, default=3600,
                    help="ttl seconds before reap considers the claim stale")
    sp.add_argument("--port", type=int, default=None,
                    help="pin a specific port (default: pool picks)")
    sp.add_argument("--gpu-slot", type=int, default=None,
                    help="pin a specific gpu slot (default: pool picks if rw)")
    sp.add_argument("--base-branch", default="main",
                    help="branch to fork from (default: main)")
    sp.add_argument("--agent-id", default=None,
                    help="custom id (default: agent-<uuid8>)")
    sp.add_argument(
        "--launch-command", default=None,
        help="shell-style command string to launch inside the workspace, "
             "e.g. --launch-command 'claude -p \"follow AGENT_CONTEXT.md\"'. "
             "shlex-parsed into argv. Empty = workspace only.",
    )
    sp.set_defaults(func=cmd_spawn)

    fp = sub.add_parser(
        "finish",
        help="push branch, optionally open PR, release the claim",
    )
    _add_global_args(fp)
    fp.add_argument("agent_id")
    fp.add_argument("--no-push", action="store_true",
                    help="skip git push (useful for local-only experiments)")
    fp.add_argument("--pr", action="store_true",
                    help="open PR via gh after push (no-op if gh missing)")
    fp.add_argument("--pr-title", default="")
    fp.add_argument("--pr-body", default="")
    fp.set_defaults(func=cmd_finish)

    lp = sub.add_parser("list", help="list active (or all) claims")
    _add_global_args(lp)
    lp.add_argument("--all", action="store_true",
                    help="include released claims (audit view)")
    lp.set_defaults(func=cmd_list)

    hp = sub.add_parser("heartbeat", help="refresh an agent's TTL")
    _add_global_args(hp)
    hp.add_argument("agent_id")
    hp.set_defaults(func=cmd_heartbeat)

    rp = sub.add_parser("reap", help="release every claim past its TTL")
    _add_global_args(rp)
    rp.set_defaults(func=cmd_reap)

    return p


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
