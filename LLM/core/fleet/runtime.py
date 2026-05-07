"""Pluggable isolation backend for the fleet.

Slices 1–2 produced a workspace by cloning the target repo into a
plain directory. That's fine for trusted code, useless as a security
boundary. Slice 3 splits the workspace lifecycle behind a
:class:`Runtime` interface so a future Docker-based
``ContainerRuntime`` can slot in without changing call sites:

    setup_workspace(claim)   # ← shim
        ↓
    default_runtime().setup(claim)
        ↓ (today)
    WorktreeRuntime.setup(claim)        # plain git clone, no isolation

A custom runtime can be installed via :func:`set_default_runtime`,
either by an installation that prefers containers everywhere or by
tests that want to stub out git.

The Runtime contract is intentionally small in slice 3a:
``setup`` materializes the claim into a runnable
:class:`WorkspaceLayout` and ``teardown`` reverses it. Process
launch + supervision is a separate concern that will hang off this
module in a later slice — keeping the interface narrow now means we
don't have to migrate it later.
"""
from __future__ import annotations

import logging
import threading
from abc import ABC, abstractmethod
from typing import Optional

from core.fleet.manifest import Claim
from core.fleet.workspace import (
    AGENT_CONTEXT_TEMPLATE,
    WorkspaceError,
    WorkspaceLayout,
    _open_pr,
    _render_context,
    _rmtree_force,
    _run_git,
)

logger = logging.getLogger(__name__)


class Runtime(ABC):
    """Abstract isolation backend.

    Implementations:

    * :class:`WorktreeRuntime` — today's plain-directory model.
    * (future) ``ContainerRuntime`` — Docker container with declared
      mount table; the container *is* the boundary.
    """

    @abstractmethod
    def setup(
        self,
        claim: Claim,
        *,
        base_branch: str = "main",
    ) -> WorkspaceLayout:
        """Materialize the claim into a runnable workspace."""

    @abstractmethod
    def teardown(
        self,
        claim: Claim,
        *,
        push: bool = True,
        open_pr: bool = False,
        pr_title: str = "",
        pr_body: str = "",
    ) -> Optional[str]:
        """Tear down the workspace; return PR URL on success or ``None``."""


class WorktreeRuntime(Runtime):
    """Plain-directory runtime — git clone in a folder, no enforcement.

    The agent is trusted to obey its own ``AGENT_CONTEXT.md``; the
    manifest still prevents two agents from *claiming* the same files
    or branches. Real enforcement (filesystem/network/GPU isolation)
    is a future ``ContainerRuntime``'s job.
    """

    def setup(
        self,
        claim: Claim,
        *,
        base_branch: str = "main",
    ) -> WorkspaceLayout:
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
                "checkout", "-b", claim.branch,
                f"origin/{base_branch}",
                cwd=layout.clone,
            )
            layout.context_file.write_text(
                _render_context(claim), encoding="utf-8",
            )
        except Exception:
            # Roll back the partial dir so the broker isn't left
            # holding a claim that points at corrupt state.
            _rmtree_force(layout.root)
            raise

        logger.info(
            "workspace ready for %s at %s", claim.agent_id, layout.root,
        )
        return layout

    def teardown(
        self,
        claim: Claim,
        *,
        push: bool = True,
        open_pr: bool = False,
        pr_title: str = "",
        pr_body: str = "",
    ) -> Optional[str]:
        layout = WorkspaceLayout.for_claim(claim)
        if not layout.clone.exists():
            # Nothing to do — already gone (crashed agent, manual rm,
            # double finish). Treat as a no-op so callers don't have
            # to special-case missing state.
            return None

        pr_url: Optional[str] = None
        try:
            if push:
                _run_git(
                    "push", "-u", "origin", claim.branch,
                    cwd=layout.clone,
                )
            if open_pr:
                pr_url = _open_pr(layout.clone, claim, pr_title, pr_body)
        finally:
            # Removed unconditionally: a stale dir poisons the next
            # spawn worse than a missing diff (which is still in the
            # pushed branch if push succeeded).
            _rmtree_force(layout.root)

        return pr_url


# ---------------------------------------------------------------------------
# Default-runtime registry
# ---------------------------------------------------------------------------


_DEFAULT_LOCK = threading.Lock()
_default_runtime: Optional[Runtime] = None


def default_runtime() -> Runtime:
    """Return the process-wide default runtime (lazy-init).

    Currently :class:`WorktreeRuntime`. Tests and alternative
    installations can override via :func:`set_default_runtime`.
    """
    global _default_runtime
    if _default_runtime is None:
        with _DEFAULT_LOCK:
            if _default_runtime is None:
                _default_runtime = WorktreeRuntime()
    return _default_runtime


def set_default_runtime(runtime: Optional[Runtime]) -> None:
    """Replace the default runtime (or pass ``None`` to reset to lazy).

    Useful for tests (``set_default_runtime(StubRuntime())``) and for
    installations that want every fleet operation to use a different
    backend by default. The change is process-wide; pair with a
    teardown that resets to ``None`` so test isolation holds.
    """
    global _default_runtime
    with _DEFAULT_LOCK:
        _default_runtime = runtime


# Re-export the context template so callers that want to render a
# preview of an AGENT_CONTEXT.md without invoking setup don't have to
# reach into the workspace module's privates.
__all__ = [
    "AGENT_CONTEXT_TEMPLATE",
    "Runtime",
    "WorktreeRuntime",
    "default_runtime",
    "set_default_runtime",
]
