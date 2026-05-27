"""Git tools — proper structured wrappers vs shelled-out parsing.

Why these exist as first-class tools instead of letting agents drive
``shell``: agents that parse free-form ``git`` output are flaky. They
forget ``--no-pager``, choke on color codes, get tripped up by line
endings, and can't tell ``not a git repo`` from ``no commits yet`` from
``detached HEAD``. These wrappers run git with deterministic flags,
sanitize output, and surface errors as ToolErrors the agent can act on.

All git tools are read-only and don't require approval — they don't
modify the working tree or history. For destructive git operations
(commit, push, reset) the agent should use ``shell``, where the user
sees the exact command and can approve or reject.

The tools auto-detect the git repo root from the working directory
unless the caller passes an explicit ``repo`` arg. ``shutil.which("git")``
is checked once per call so a missing git binary surfaces a clean
"install git" message instead of a FileNotFoundError stack trace.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any, List, Mapping, Optional

from core.agents.tools.base import ArgSpec, Tool, ToolError


_MAX_OUTPUT_CHARS = 32_000


def _truncate(text: str) -> str:
    if len(text) <= _MAX_OUTPUT_CHARS:
        return text
    return text[:_MAX_OUTPUT_CHARS] + f"\n\n... [truncated, {len(text) - _MAX_OUTPUT_CHARS} more chars]"


def _resolve_git() -> str:
    exe = shutil.which("git")
    if exe is None:
        raise ToolError(
            "git not on PATH. Install Git from https://git-scm.com or your "
            "OS package manager."
        )
    return exe


def _resolve_repo(arg: Any) -> Path:
    """Pick a repo root. Explicit arg wins; otherwise use cwd.

    We don't auto-walk up looking for ``.git`` — git itself does that and
    will surface a clear ``not a git repository`` error if the cwd is
    outside any repo. Doing it ourselves would risk picking a parent repo
    the agent didn't mean.
    """
    if arg in (None, ""):
        p = Path.cwd()
    else:
        p = Path(str(arg)).expanduser()
    if not p.exists() or not p.is_dir():
        raise ToolError(f"repo path is not a directory: {p}")
    return p


def _run_git(args: List[str], *, cwd: Path, timeout: int = 30) -> str:
    """Run a git subcommand and return stdout. Raises ToolError on failure.

    ``--no-pager`` and ``-c color.ui=never`` make output deterministic —
    no terminal-control codes leaking into agent context, no half-page
    interactive paging.
    """
    git = _resolve_git()
    full = [git, "--no-pager", "-c", "color.ui=never", *args]
    try:
        proc = subprocess.run(
            full,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise ToolError(f"git {args[0] if args else ''} timed out after {timeout}s")
    except OSError as exc:
        raise ToolError(f"git invocation failed: {exc}")

    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        raise ToolError(f"git {' '.join(args)} failed (exit {proc.returncode}): {err}")
    return proc.stdout or ""


# ---------------------------------------------------------------------------
# git_status
# ---------------------------------------------------------------------------


def _git_status(args: Mapping[str, Any]) -> str:
    repo = _resolve_repo(args.get("repo"))
    # --porcelain=v1 gives stable, parseable output; -uno avoids the slow
    # untracked-files walk on huge trees by default. Caller can pass
    # show_untracked=true to opt back in.
    show_untracked = bool(args.get("show_untracked", False))
    cmd = ["status", "--porcelain=v1"]
    cmd.append("-uall" if show_untracked else "-uno")
    out = _run_git(cmd, cwd=repo)
    if not out.strip():
        # Mirror what `git status` would say in plain mode.
        branch_out = _run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=repo).strip()
        return f"clean working tree (branch: {branch_out})"
    branch = ""
    try:
        branch = _run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=repo).strip()
    except ToolError:
        pass
    header = f"branch: {branch}\n" if branch else ""
    return _truncate(header + out.rstrip())


git_status = Tool(
    name="git_status",
    description=(
        "Show the working tree status in porcelain format. Skips untracked "
        "files by default (faster on large repos); pass show_untracked=true "
        "to include them. Returns 'clean working tree' when nothing's modified."
    ),
    args=[
        ArgSpec("repo", "string", "Repo root path (default: cwd).", required=False),
        ArgSpec("show_untracked", "boolean", "Include untracked files.", required=False),
    ],
    func=_git_status,
    requires_approval=False,
)


# ---------------------------------------------------------------------------
# git_diff
# ---------------------------------------------------------------------------


def _git_diff(args: Mapping[str, Any]) -> str:
    repo = _resolve_repo(args.get("repo"))
    base = args.get("base")
    head = args.get("head")
    staged = bool(args.get("staged", False))
    path = args.get("path")
    stat = bool(args.get("stat", False))

    cmd: List[str] = ["diff"]
    if stat:
        cmd.append("--stat")
    if staged:
        cmd.append("--cached")
    if base:
        if head:
            cmd.append(f"{base}...{head}")
        else:
            cmd.append(str(base))
    if path:
        cmd.append("--")
        cmd.append(str(path))

    out = _run_git(cmd, cwd=repo, timeout=60)
    if not out.strip():
        return "(no diff)"
    return _truncate(out)


git_diff = Tool(
    name="git_diff",
    description=(
        "Show a git diff. Without args: unstaged changes. With staged=true: "
        "staged changes. With base (and optional head): three-dot range diff "
        "(base...head, or base...HEAD if head omitted). Pass stat=true for "
        "the file-level summary instead of full hunks. Pass path to filter."
    ),
    args=[
        ArgSpec("repo", "string", "Repo root path (default: cwd).", required=False),
        ArgSpec("base", "string", "Base ref (branch / commit / tag).", required=False),
        ArgSpec("head", "string", "Head ref. Default HEAD if base provided.", required=False),
        ArgSpec("staged", "boolean", "Show staged changes (--cached).", required=False),
        ArgSpec("path", "string", "Limit to one path or pathspec.", required=False),
        ArgSpec("stat", "boolean", "Summary mode (--stat) instead of hunks.", required=False),
    ],
    func=_git_diff,
    requires_approval=False,
)


# ---------------------------------------------------------------------------
# git_log
# ---------------------------------------------------------------------------


def _git_log(args: Mapping[str, Any]) -> str:
    repo = _resolve_repo(args.get("repo"))
    try:
        limit = int(args.get("limit", 20))
    except (TypeError, ValueError):
        raise ToolError("limit must be an integer")
    limit = max(1, min(limit, 500))

    path = args.get("path")
    rev = args.get("rev")  # e.g. "main..HEAD" or a single commit
    grep = args.get("grep")
    author = args.get("author")
    oneline = bool(args.get("oneline", True))

    cmd = ["log", f"-n{limit}"]
    if oneline:
        cmd.extend(["--pretty=format:%h %s (%an, %ar)"])
    else:
        cmd.extend(["--pretty=format:commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n    %s%n"])
    if grep:
        cmd.append(f"--grep={grep}")
    if author:
        cmd.append(f"--author={author}")
    if rev:
        cmd.append(str(rev))
    if path:
        cmd.append("--")
        cmd.append(str(path))

    out = _run_git(cmd, cwd=repo)
    if not out.strip():
        return "(no commits matched)"
    return _truncate(out)


git_log = Tool(
    name="git_log",
    description=(
        "Show commit history. Default: last 20 commits, oneline format. "
        "Filter with grep (commit message regex), author, path, or rev "
        "range like 'main..HEAD'. Pass oneline=false for full body."
    ),
    args=[
        ArgSpec("repo", "string", "Repo root path (default: cwd).", required=False),
        ArgSpec("limit", "integer", "Max commits (default 20, max 500).", required=False),
        ArgSpec("oneline", "boolean", "Compact format (default true).", required=False),
        ArgSpec("rev", "string", "Revision range or single ref.", required=False),
        ArgSpec("grep", "string", "Filter by commit-message regex.", required=False),
        ArgSpec("author", "string", "Filter by author name/email.", required=False),
        ArgSpec("path", "string", "Limit to commits touching this path.", required=False),
    ],
    func=_git_log,
    requires_approval=False,
)


# ---------------------------------------------------------------------------
# git_blame
# ---------------------------------------------------------------------------


def _git_blame(args: Mapping[str, Any]) -> str:
    repo = _resolve_repo(args.get("repo"))
    path = args.get("path")
    if not path:
        raise ToolError("path required")

    line_start = args.get("line_start")
    line_end = args.get("line_end")

    cmd = ["blame", "--line-porcelain"]
    # Porcelain format is verbose but stable. We collapse it to one line
    # per source line for agent consumption — author + short hash + line.
    if line_start:
        try:
            ls = int(line_start)
            le = int(line_end) if line_end else ls
        except (TypeError, ValueError):
            raise ToolError("line_start and line_end must be integers")
        if le < ls:
            raise ToolError("line_end must be >= line_start")
        cmd.append(f"-L{ls},{le}")
    cmd.append("--")
    cmd.append(str(path))

    raw = _run_git(cmd, cwd=repo, timeout=60)
    return _truncate(_summarize_blame(raw))


def _summarize_blame(porcelain: str) -> str:
    """Collapse --line-porcelain output to ``hash author lineno: content``."""
    out_lines: List[str] = []
    cur: dict = {}
    for line in porcelain.splitlines():
        if not line:
            continue
        if line.startswith("\t"):
            # The actual source line. Flush.
            content = line[1:]
            sha = cur.get("sha", "")[:8]
            author = cur.get("author", "?")
            lineno = cur.get("lineno", "?")
            out_lines.append(f"{sha} ({author:<20s}) {lineno:>5}| {content}")
            cur = {}
            continue
        # Header line. First header per source-line is "<sha> <orig-lineno> <final-lineno> <count>".
        parts = line.split(" ", 3)
        if len(parts) >= 3 and len(parts[0]) == 40 and all(c in "0123456789abcdef" for c in parts[0]):
            cur["sha"] = parts[0]
            cur["lineno"] = parts[2]
        elif line.startswith("author "):
            cur["author"] = line[len("author "):]
    return "\n".join(out_lines) or "(empty blame)"


git_blame = Tool(
    name="git_blame",
    description=(
        "Show 'who last changed each line' for a file or line range. "
        "Output: <short-sha> (<author>) <lineno>| <content>. "
        "Pass line_start/line_end to scope to a region — strongly recommended "
        "for big files."
    ),
    args=[
        ArgSpec("path", "string", "Path inside the repo."),
        ArgSpec("repo", "string", "Repo root path (default: cwd).", required=False),
        ArgSpec("line_start", "integer", "First line to blame (1-based).", required=False),
        ArgSpec("line_end", "integer", "Last line to blame (defaults to line_start).", required=False),
    ],
    func=_git_blame,
    requires_approval=False,
)


# ---------------------------------------------------------------------------
# git_show — inspect a single commit / ref
# ---------------------------------------------------------------------------


def _git_show(args: Mapping[str, Any]) -> str:
    repo = _resolve_repo(args.get("repo"))
    rev = str(args.get("rev", "HEAD")).strip() or "HEAD"
    stat = bool(args.get("stat", False))
    cmd = ["show"]
    if stat:
        cmd.append("--stat")
    cmd.extend(["--pretty=format:commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n    %s%n", rev])
    out = _run_git(cmd, cwd=repo, timeout=60)
    return _truncate(out or "(empty)")


git_show = Tool(
    name="git_show",
    description=(
        "Show a single commit's metadata + diff. Default rev=HEAD. "
        "Pass stat=true for the file-level summary instead of full hunks."
    ),
    args=[
        ArgSpec("rev", "string", "Commit SHA, ref, or HEAD~N. Default HEAD.", required=False),
        ArgSpec("repo", "string", "Repo root path (default: cwd).", required=False),
        ArgSpec("stat", "boolean", "Summary mode.", required=False),
    ],
    func=_git_show,
    requires_approval=False,
)


# ---------------------------------------------------------------------------
# Registration helper — called by builtin_registry
# ---------------------------------------------------------------------------


GIT_TOOLS = (git_status, git_diff, git_log, git_blame, git_show)
