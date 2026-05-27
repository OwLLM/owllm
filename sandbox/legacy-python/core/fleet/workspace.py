"""Workspace primitives — layout, helpers, and backward-compat shims.

The agent's physical workspace looks like::

    <claim.workspace_path>/
        AGENT_CONTEXT.md      ← scope, modules, resources, lifecycle hints
        clone/                ← `git clone <claim.target_repo>` here, on
                                a freshly created `claim.branch`

The context file lives at the workspace root, NOT inside ``clone/``,
so it never lands in the target repo's git history.

Slice 3a moved the *lifecycle* logic (clone, branch, push, teardown)
into :mod:`core.fleet.runtime` behind the :class:`Runtime` interface.
This module now keeps:

* the layout dataclass (:class:`WorkspaceLayout`),
* helpers reused across runtime implementations
  (``_run_git``, ``_rmtree_force``, ``_open_pr``, ``_render_context``,
  the AGENT_CONTEXT template),
* and thin :func:`setup_workspace` / :func:`teardown_workspace`
  shims that delegate to :func:`core.fleet.runtime.default_runtime`,
  so existing call sites (the CLI, the desktop service, tests) keep
  working with no diff.

Containers, capability mounts, and any other isolation enforcement
live behind a custom :class:`Runtime`, not in this module.
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


def setup_workspace(
    claim: Claim, *, base_branch: str = "main",
) -> WorkspaceLayout:
    """Backward-compat shim — delegates to the default :class:`Runtime`.

    Existed before slice 3a as the canonical implementation; today
    the logic lives in :class:`core.fleet.runtime.WorktreeRuntime`.
    Call sites that want to pin a specific runtime (e.g. tests or
    container installations) should call ``runtime.setup`` directly
    instead of this shim.
    """
    # Lazy import — avoids workspace ↔ runtime cycle at module load.
    from core.fleet.runtime import default_runtime
    return default_runtime().setup(claim, base_branch=base_branch)


def teardown_workspace(
    claim: Claim,
    *,
    push: bool = True,
    open_pr: bool = False,
    pr_title: str = "",
    pr_body: str = "",
) -> Optional[str]:
    """Backward-compat shim — delegates to the default :class:`Runtime`."""
    from core.fleet.runtime import default_runtime
    return default_runtime().teardown(
        claim,
        push=push,
        open_pr=open_pr,
        pr_title=pr_title,
        pr_body=pr_body,
    )


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
