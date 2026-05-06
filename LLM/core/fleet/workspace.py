"""Per-agent workspace setup and teardown.

Slice 1a gave us atomic *claims* over fleet resources. This module
gives the claim *physical form*: a directory tree with a fresh clone
of the target repo, an agent-owned branch checked out, and an
``AGENT_CONTEXT.md`` describing the claim's scope so the agent (or a
human reading over its shoulder) knows the rules.

Layout produced by :func:`setup_workspace`::

    <claim.workspace_path>/
        AGENT_CONTEXT.md      ← scope, modules, resources, lifecycle hints
        clone/                ← `git clone <claim.target_repo>` here, on
                                a freshly created `claim.branch`

The context file lives at the workspace root, NOT inside ``clone/``,
so it never lands in the target repo's git history.

Container/sandbox enforcement is a later slice. Today the workspace is
a plain directory; the agent is trusted to obey its own
``AGENT_CONTEXT.md``. The manifest still prevents two agents from
*claiming* the same files; this module's job is to make the claim
runnable.
"""
from __future__ import annotations

import logging
import os
import shutil
import stat
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from core.fleet.manifest import Claim

logger = logging.getLogger(__name__)


CLONE_SUBDIR = "clone"
CONTEXT_FILE = "AGENT_CONTEXT.md"


class WorkspaceError(RuntimeError):
    """Raised on any git or filesystem failure during setup/teardown."""


@dataclass(frozen=True)
class WorkspaceLayout:
    """Resolved paths inside one agent's workspace."""

    root: Path
    clone: Path
    context_file: Path

    @classmethod
    def for_claim(cls, claim: Claim) -> "WorkspaceLayout":
        root = Path(claim.workspace_path)
        return cls(
            root=root,
            clone=root / CLONE_SUBDIR,
            context_file=root / CONTEXT_FILE,
        )


def _rmtree_force(path: Path) -> None:
    """Remove a directory tree even when files carry read-only flags.

    Git on Windows packs objects with the read-only attribute set
    (``.git/objects/pack/*.pack``); plain ``shutil.rmtree`` errors on
    those and either raises or, with ``ignore_errors=True``, silently
    leaves the tree behind. The latter is worse — callers think
    teardown succeeded and the next spawn collides on the dir. This
    helper resets permissions and retries.
    """
    if not path.exists():
        return

    def _retry(func, target, _exc_info):
        try:
            os.chmod(target, stat.S_IWRITE)
            func(target)
        except Exception:
            logger.warning("could not remove %s", target, exc_info=True)

    # Python 3.12 deprecated ``onerror`` in favour of ``onexc``.
    try:
        shutil.rmtree(str(path), onexc=_retry)  # type: ignore[call-arg]
    except TypeError:
        shutil.rmtree(str(path), onerror=_retry)


def _run_git(*args: str, cwd: Optional[Path] = None) -> str:
    cmd = ["git", *args]
    logger.debug("running %s in %s", cmd, cwd)
    result = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise WorkspaceError(f"git {' '.join(args)} failed: {detail}")
    return result.stdout


def setup_workspace(claim: Claim, *, base_branch: str = "main") -> WorkspaceLayout:
    """Build the agent's physical workspace.

    Creates ``<workspace_path>/clone/`` containing a fresh clone of
    ``claim.target_repo`` checked out to a freshly-created
    ``claim.branch`` based on ``origin/<base_branch>``, and writes
    ``AGENT_CONTEXT.md`` at the workspace root.

    Raises :class:`WorkspaceError` on any git or filesystem failure;
    on failure, removes the partially-constructed workspace dir so
    the broker isn't left with a dangling claim pointing at corrupt
    state.
    """
    layout = WorkspaceLayout.for_claim(claim)
    if layout.root.exists():
        raise WorkspaceError(
            f"workspace already exists: {layout.root} "
            "(broker should have prevented this; investigate stale state)"
        )
    layout.root.mkdir(parents=True)

    try:
        _run_git("clone", claim.target_repo, str(layout.clone))
        _run_git(
            "checkout", "-b", claim.branch, f"origin/{base_branch}",
            cwd=layout.clone,
        )
        layout.context_file.write_text(_render_context(claim), encoding="utf-8")
    except Exception:
        _rmtree_force(layout.root)
        raise

    logger.info("workspace ready for %s at %s", claim.agent_id, layout.root)
    return layout


def teardown_workspace(
    claim: Claim,
    *,
    push: bool = True,
    open_pr: bool = False,
    pr_title: str = "",
    pr_body: str = "",
) -> Optional[str]:
    """Push the branch (optionally open a PR), then remove the workspace.

    Returns the PR URL when ``open_pr`` is True and ``gh pr create``
    succeeded; ``None`` otherwise.

    A missing workspace is treated as a no-op (returns ``None``) — the
    broker may legitimately call this on an agent that already crashed
    and got cleaned up by something else.

    The workspace dir is removed in the ``finally`` clause regardless
    of push/PR outcome — leaving stale dirs behind is a worse failure
    mode than losing the diff (which is still in the pushed branch if
    push succeeded).
    """
    layout = WorkspaceLayout.for_claim(claim)
    if not layout.clone.exists():
        return None

    pr_url: Optional[str] = None
    try:
        if push:
            _run_git(
                "push", "-u", "origin", claim.branch, cwd=layout.clone,
            )
        if open_pr:
            pr_url = _open_pr(layout.clone, claim, pr_title, pr_body)
    finally:
        _rmtree_force(layout.root)

    return pr_url


def _open_pr(
    clone: Path, claim: Claim, title: str, body: str,
) -> Optional[str]:
    """Open a PR via ``gh pr create``. Failure is non-fatal — the branch
    is already pushed; the user can open one manually.
    """
    if shutil.which("gh") is None:
        logger.info("gh CLI not on PATH; skipping PR creation")
        return None
    final_title = title or f"agent: {claim.reason or claim.branch}"
    final_body = body or _default_pr_body(claim)
    result = subprocess.run(
        [
            "gh", "pr", "create",
            "--title", final_title,
            "--body", final_body,
            "--head", claim.branch,
        ],
        cwd=str(clone),
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        logger.warning("gh pr create failed: %s", detail)
        return None
    for line in reversed(result.stdout.splitlines()):
        line = line.strip()
        if line.startswith("http"):
            return line
    return None


def _render_context(claim: Claim) -> str:
    owns = "\n".join(f"- `{m}`" for m in claim.owns_modules) or \
        "- (none — read-only role)"
    reads = "\n".join(f"- `{m}`" for m in claim.reads_modules) or "- (none)"
    return AGENT_CONTEXT_TEMPLATE.format(
        agent_id=claim.agent_id,
        target_repo=claim.target_repo,
        branch=claim.branch,
        reason=claim.reason or "(unspecified)",
        owns=owns,
        reads=reads,
        port=claim.port if claim.port is not None else "(unallocated)",
        gpu=(f"slot {claim.gpu_slot} ({claim.gpu_mode})"
             if claim.gpu_slot is not None else "(none)"),
        started=claim.started_at,
        ttl=claim.ttl_seconds,
    )


def _default_pr_body(claim: Claim) -> str:
    owns = "\n".join(f"- `{m}`" for m in claim.owns_modules) or "- (none)"
    return (
        f"## Summary\n\n"
        f"Agent task: {claim.reason or '(unspecified)'}\n\n"
        f"Owned modules:\n{owns}\n\n"
        f"Generated by OWLLM fleet agent `{claim.agent_id}`\n"
    )


AGENT_CONTEXT_TEMPLATE = """# Agent context — `{agent_id}`

You are a fleet agent. Your work is constrained to the modules listed
below. Operate inside the `clone/` subdirectory; that is your sandbox.

## Task
{reason}

## Target
- repo: `{target_repo}`
- branch: `{branch}`

## Modules you OWN (rw)
{owns}

## Modules you may READ (ro)
{reads}

## Resources
- port: {port}
- gpu: {gpu}
- started: {started}
- ttl: {ttl}s — call `python -m core.fleet heartbeat {agent_id}` to extend

## Lifecycle
- Edit only files under your owned modules.
- Commit early and often inside `clone/`; the work lives on your
  agent-owned branch.
- When done, run `python -m core.fleet finish {agent_id}` from any
  shell. That pushes your branch, optionally opens a PR (`--pr`),
  and releases your claim.
- If you crash without finishing, the broker reaps your claim once
  TTL expires; another agent can re-spawn on a fresh branch.
"""
