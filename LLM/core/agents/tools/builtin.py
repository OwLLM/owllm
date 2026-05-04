"""Built-in tools every agent gets by default.

Surface:
    read_file(path,
              offset=0, limit=2000)  -- line-numbered file read; supports slicing
    write_file_with_diff(path,
                         content)    -- whole-file write (gated, returns diff)
    edit_file(path, old_string,
              new_string,
              replace_all=False)     -- precise string replacement (gated,
                                       requires read_file first)
    list_dir(path, depth=1)          -- list directory entries
    glob_files(pattern, path=None,
               head_limit=100)       -- file pattern match, sorted by mtime desc
    grep(pattern, path=None,
         glob=None, output_mode=...,
         case_insensitive=False,
         context=0, head_limit=50)   -- regex search across files (ripgrep w/ fallback)
    todo_write(todos)                -- record/update structured task list
    shell(cmd, cwd=None,
          timeout=60)                -- run a shell command (gated)
    http_get(url, timeout=30)        -- read-only HTTP GET
    ssh_exec(host, cmd,
             timeout=60)             -- run a shell command on a remote host (gated)
    ssh_upload(host, local,
               remote)               -- scp a file UP to a remote host (gated)
    ssh_download(host, remote,
                 local)              -- scp a file DOWN from a remote host (gated)

Approval-gated tools: write_file_with_diff, edit_file, shell, ssh_exec,
ssh_upload, ssh_download. The registry routes them through ApprovalGate
before invocation.

read_file → edit_file ordering is enforced by ToolRegistry.invoke: an
agent can't edit_file a path it hasn't successfully read this goal. This
guards against the most common hallucinated-edit failure mode.

The SSH tools shell out to the system's OpenSSH client so ``~/.ssh/config``
host aliases and key-based auth work transparently. We force ``BatchMode=yes``
so a missing key surfaces as a clean error instead of a hung password prompt.
"""
from __future__ import annotations

import difflib
import fnmatch
import json
import os
import re
import shutil
import subprocess
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Mapping, Optional

from core.agents.tools.base import ArgSpec, Tool, ToolError, ToolRegistry


_MAX_READ_BYTES = 200 * 1024
_MAX_OUTPUT_CHARS = 32_000


def _truncate(text: str) -> str:
    if len(text) <= _MAX_OUTPUT_CHARS:
        return text
    head = text[:_MAX_OUTPUT_CHARS]
    return head + f"\n\n... [truncated, {len(text) - _MAX_OUTPUT_CHARS} more chars]"


# ---------------------------------------------------------------------------
# read_file
# ---------------------------------------------------------------------------


def _read_file(args: Mapping[str, Any]) -> str:
    path = Path(str(args["path"])).expanduser()
    if not path.exists():
        raise ToolError(f"no such file: {path}")
    if not path.is_file():
        raise ToolError(f"not a file: {path}")

    # Optional offset/limit for partial reads — needed on multi-MB log
    # files where a full read would blow context. Mirrors Claude Code's
    # Read semantics: 1-based line numbers, default 2000-line window,
    # offset is 0-based "skip N lines before reading".
    try:
        offset = int(args.get("offset", 0)) if args.get("offset") not in (None, "") else 0
    except (TypeError, ValueError):
        raise ToolError("offset must be an integer")
    try:
        limit = int(args.get("limit", 2000)) if args.get("limit") not in (None, "") else 2000
    except (TypeError, ValueError):
        raise ToolError("limit must be an integer")
    offset = max(0, offset)
    limit = max(1, min(limit, 10000))

    size = path.stat().st_size
    # Soft cap only when reading whole file. With offset/limit the user is
    # opting in to a slice, so we let them slice into very large files.
    full_read = (offset == 0 and args.get("limit") in (None, ""))
    if full_read and size > _MAX_READ_BYTES:
        raise ToolError(
            f"file too large ({size} bytes > {_MAX_READ_BYTES}); pass offset/limit "
            f"to read in chunks"
        )

    # Stream by line so a 50 MB log doesn't materialize fully in memory.
    out_lines: list = []
    line_no = 0
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for raw in f:
            line_no += 1
            if line_no <= offset:
                continue
            if line_no > offset + limit:
                break
            # Strip trailing newline for clean cat -n style output.
            display = raw.rstrip("\n").rstrip("\r")
            out_lines.append(f"{line_no:6d}\t{display}")

    if not out_lines:
        return f"(empty range: file has {line_no} lines, offset={offset})"

    body = "\n".join(out_lines)
    return _truncate(body)


read_file = Tool(
    name="read_file",
    description=(
        "Read a UTF-8 text file with line numbers. Default reads first 2000 lines; "
        "pass offset/limit to slice large files. Whole-file reads cap at 200 KB."
    ),
    args=[
        ArgSpec("path", "string", "Absolute or user-relative file path."),
        ArgSpec("offset", "integer", "1-based line to start at (skip first N lines).", required=False),
        ArgSpec("limit", "integer", "Max lines to return (default 2000, max 10000).", required=False),
    ],
    func=_read_file,
    requires_approval=False,
)


# ---------------------------------------------------------------------------
# write_file_with_diff
# ---------------------------------------------------------------------------


def _write_file_with_diff(args: Mapping[str, Any]) -> str:
    path = Path(str(args["path"])).expanduser()
    new_content = str(args["content"])

    old_content = ""
    if path.exists():
        if not path.is_file():
            raise ToolError(f"not a file: {path}")
        old_content = path.read_text(encoding="utf-8", errors="replace")

    diff = "".join(
        difflib.unified_diff(
            old_content.splitlines(keepends=True),
            new_content.splitlines(keepends=True),
            fromfile=f"a/{path.name}",
            tofile=f"b/{path.name}",
        )
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(new_content, encoding="utf-8")
    return _truncate(f"wrote {path}\n\n{diff or '(no diff — content unchanged)'}")


write_file_with_diff = Tool(
    name="write_file_with_diff",
    description=(
        "Write a UTF-8 file. Creates parent dirs if missing. Returns the unified "
        "diff vs the previous contents. Requires user approval."
    ),
    args=[
        ArgSpec("path", "string", "Absolute or user-relative file path."),
        ArgSpec("content", "string", "Full new file contents."),
    ],
    func=_write_file_with_diff,
    requires_approval=True,
)


# ---------------------------------------------------------------------------
# list_dir
# ---------------------------------------------------------------------------


def _list_dir(args: Mapping[str, Any]) -> str:
    path = Path(str(args["path"])).expanduser()
    if not path.exists():
        raise ToolError(f"no such path: {path}")
    if not path.is_dir():
        raise ToolError(f"not a directory: {path}")

    try:
        depth = int(args.get("depth", 1))
    except (TypeError, ValueError):
        raise ToolError("depth must be an integer")
    depth = max(1, min(depth, 4))

    lines: list = []

    def walk(p: Path, current_depth: int):
        try:
            entries = sorted(p.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
        except PermissionError:
            lines.append(f"{p}/  [permission denied]")
            return
        for entry in entries:
            if entry.name.startswith("."):
                continue
            indent = "  " * (current_depth - 1)
            suffix = "/" if entry.is_dir() else ""
            lines.append(f"{indent}{entry.name}{suffix}")
            if entry.is_dir() and current_depth < depth:
                walk(entry, current_depth + 1)

    walk(path, 1)
    return _truncate("\n".join(lines) or "(empty)")


list_dir = Tool(
    name="list_dir",
    description="List directory entries. Hidden files skipped. Depth 1-4.",
    args=[
        ArgSpec("path", "string", "Directory path."),
        ArgSpec("depth", "integer", "How many levels to recurse (1-4).", required=False),
    ],
    func=_list_dir,
    requires_approval=False,
)


# ---------------------------------------------------------------------------
# shell
# ---------------------------------------------------------------------------


def _shell(args: Mapping[str, Any]) -> str:
    cmd = str(args["cmd"])
    cwd = args.get("cwd")
    if cwd:
        cwd_path = Path(str(cwd)).expanduser()
        if not cwd_path.is_dir():
            raise ToolError(f"cwd does not exist: {cwd_path}")
        cwd_str = str(cwd_path)
    else:
        cwd_str = None

    try:
        timeout = int(args.get("timeout", 60))
    except (TypeError, ValueError):
        raise ToolError("timeout must be an integer (seconds)")
    timeout = max(1, min(timeout, 600))

    try:
        proc = subprocess.run(
            cmd,
            shell=True,
            cwd=cwd_str,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise ToolError(f"shell command timed out after {timeout}s")

    out = proc.stdout or ""
    err = proc.stderr or ""
    parts = [f"$ {cmd}", f"exit={proc.returncode}"]
    if out:
        parts.append(f"--- stdout ---\n{out.rstrip()}")
    if err:
        parts.append(f"--- stderr ---\n{err.rstrip()}")
    return _truncate("\n".join(parts))


shell = Tool(
    name="shell",
    description=(
        "Run a shell command. Returns exit code, stdout, stderr. Requires "
        "user approval. Default timeout 60s, max 600s."
    ),
    args=[
        ArgSpec("cmd", "string", "Shell command line."),
        ArgSpec("cwd", "string", "Working directory.", required=False),
        ArgSpec("timeout", "integer", "Timeout in seconds (1-600).", required=False),
    ],
    func=_shell,
    requires_approval=True,
)


# ---------------------------------------------------------------------------
# http_get
# ---------------------------------------------------------------------------


def _http_get(args: Mapping[str, Any]) -> str:
    url = str(args["url"])
    if not (url.startswith("http://") or url.startswith("https://")):
        raise ToolError("url must start with http:// or https://")
    try:
        timeout = int(args.get("timeout", 30))
    except (TypeError, ValueError):
        raise ToolError("timeout must be an integer (seconds)")
    timeout = max(1, min(timeout, 120))

    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            data = resp.read(_MAX_READ_BYTES)
            charset = resp.headers.get_content_charset() or "utf-8"
            text = data.decode(charset, errors="replace")
            return _truncate(f"HTTP {resp.status}\n\n{text}")
    except urllib.error.HTTPError as exc:
        return _truncate(f"HTTP {exc.code} {exc.reason}")
    except urllib.error.URLError as exc:
        raise ToolError(f"network error: {exc.reason}")


http_get = Tool(
    name="http_get",
    description="GET a URL. Returns status + first 200 KB of body. http/https only.",
    args=[
        ArgSpec("url", "string", "Full URL."),
        ArgSpec("timeout", "integer", "Timeout in seconds (1-120).", required=False),
    ],
    func=_http_get,
    requires_approval=False,
)


# ---------------------------------------------------------------------------
# ssh_exec / ssh_upload / ssh_download
# ---------------------------------------------------------------------------


# Common SSH options applied to every call:
#   BatchMode=yes               — never prompt; missing key fails fast.
#   ConnectTimeout=10           — bound the dial phase.
#   StrictHostKeyChecking=accept-new — first-use TOFU, then strict.
#   ServerAliveInterval=15      — keep long-running commands alive across NAT.
#
# Users who need password auth or a one-off key can reach for an
# ``~/.ssh/config`` Host entry; those settings flow in automatically.
_SSH_BASE_OPTS = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ServerAliveInterval=15",
]


def _resolve_ssh_bin(name: str) -> str:
    """Find ``ssh`` / ``scp`` on PATH and surface a clear error if missing.

    Windows users who haven't installed OpenSSH typically don't have these
    on PATH, and the resulting FileNotFoundError is opaque. We translate
    it into a one-liner that says where to install from.
    """
    exe = shutil.which(name)
    if exe is None:
        raise ToolError(
            f"'{name}' client not on PATH. On Windows install via 'Optional Features → "
            f"OpenSSH Client'; on macOS/Linux it's in the OS or via your package manager."
        )
    return exe


def _ssh_exec(args: Mapping[str, Any]) -> str:
    host = str(args.get("host", "")).strip()
    if not host:
        raise ToolError("host required (e.g. 'user@server' or an ~/.ssh/config alias)")
    cmd = str(args.get("cmd", ""))
    if not cmd:
        raise ToolError("cmd required")

    try:
        timeout = int(args.get("timeout", 60))
    except (TypeError, ValueError):
        raise ToolError("timeout must be an integer (seconds)")
    timeout = max(1, min(timeout, 600))

    ssh = _resolve_ssh_bin("ssh")
    full = [ssh, *_SSH_BASE_OPTS, host, cmd]

    try:
        proc = subprocess.run(
            full,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            encoding="utf-8",
            errors="replace",
        )
    except subprocess.TimeoutExpired:
        raise ToolError(f"ssh to {host} timed out after {timeout}s")
    except OSError as exc:
        raise ToolError(f"ssh invocation failed: {exc}")

    parts = [f"$ ssh {host} {cmd!r}", f"exit={proc.returncode}"]
    out = (proc.stdout or "").rstrip()
    err = (proc.stderr or "").rstrip()
    if out:
        parts.append(f"--- stdout ---\n{out}")
    if err:
        parts.append(f"--- stderr ---\n{err}")
    return _truncate("\n".join(parts))


ssh_exec = Tool(
    name="ssh_exec",
    description=(
        "Run a shell command on a remote host via OpenSSH. Uses your system's "
        "ssh client so ~/.ssh/config aliases and key-based auth work as-is. "
        "Forces BatchMode (no password prompts). Requires user approval."
    ),
    args=[
        ArgSpec("host", "string", "Remote host. Either 'user@hostname' or an alias from ~/.ssh/config."),
        ArgSpec("cmd", "string", "Shell command to run remotely."),
        ArgSpec("timeout", "integer", "Timeout in seconds (1-600). Default 60.", required=False),
    ],
    func=_ssh_exec,
    requires_approval=True,
)


def _scp(args: Mapping[str, Any], *, direction: str) -> str:
    """Shared body for ssh_upload / ssh_download.

    direction == "up"   → local_path -> host:remote_path
    direction == "down" → host:remote_path -> local_path
    """
    host = str(args.get("host", "")).strip()
    if not host:
        raise ToolError("host required")
    local_path = str(args.get("local_path", "")).strip()
    remote_path = str(args.get("remote_path", "")).strip()
    if not local_path or not remote_path:
        raise ToolError("local_path and remote_path required")

    try:
        timeout = int(args.get("timeout", 120))
    except (TypeError, ValueError):
        raise ToolError("timeout must be an integer (seconds)")
    timeout = max(1, min(timeout, 1800))

    scp = _resolve_ssh_bin("scp")

    if direction == "up":
        local_resolved = Path(local_path).expanduser()
        if not local_resolved.exists():
            raise ToolError(f"local file not found: {local_resolved}")
        src = str(local_resolved)
        dst = f"{host}:{remote_path}"
    elif direction == "down":
        src = f"{host}:{remote_path}"
        local_resolved = Path(local_path).expanduser()
        local_resolved.parent.mkdir(parents=True, exist_ok=True)
        dst = str(local_resolved)
    else:
        raise ToolError(f"unknown direction: {direction}")

    full = [scp, *_SSH_BASE_OPTS, src, dst]

    try:
        proc = subprocess.run(
            full,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            encoding="utf-8",
            errors="replace",
        )
    except subprocess.TimeoutExpired:
        raise ToolError(f"scp to/from {host} timed out after {timeout}s")
    except OSError as exc:
        raise ToolError(f"scp invocation failed: {exc}")

    parts = [f"$ scp {src} {dst}", f"exit={proc.returncode}"]
    err = (proc.stderr or "").rstrip()
    if proc.returncode == 0:
        if direction == "up":
            parts.append(f"uploaded {local_resolved} → {host}:{remote_path}")
        else:
            parts.append(f"downloaded {host}:{remote_path} → {local_resolved}")
    if err:
        parts.append(f"--- stderr ---\n{err}")
    return _truncate("\n".join(parts))


def _ssh_upload(args: Mapping[str, Any]) -> str:
    return _scp(args, direction="up")


def _ssh_download(args: Mapping[str, Any]) -> str:
    return _scp(args, direction="down")


ssh_upload = Tool(
    name="ssh_upload",
    description=(
        "Copy a local file UP to a remote host via scp. Same auth rules as "
        "ssh_exec. Requires user approval."
    ),
    args=[
        ArgSpec("host", "string", "Remote host (alias or user@host)."),
        ArgSpec("local_path", "string", "Local file path."),
        ArgSpec("remote_path", "string", "Destination path on the remote."),
        ArgSpec("timeout", "integer", "Timeout in seconds (1-1800). Default 120.", required=False),
    ],
    func=_ssh_upload,
    requires_approval=True,
)


ssh_download = Tool(
    name="ssh_download",
    description=(
        "Copy a file DOWN from a remote host via scp. Same auth rules as "
        "ssh_exec. Requires user approval."
    ),
    args=[
        ArgSpec("host", "string", "Remote host (alias or user@host)."),
        ArgSpec("remote_path", "string", "Source path on the remote."),
        ArgSpec("local_path", "string", "Local destination path."),
        ArgSpec("timeout", "integer", "Timeout in seconds (1-1800). Default 120.", required=False),
    ],
    func=_ssh_download,
    requires_approval=True,
)


# ---------------------------------------------------------------------------
# edit_file — precise old→new string replacement
# ---------------------------------------------------------------------------


def _edit_file(args: Mapping[str, Any]) -> str:
    """Replace one (or all) occurrences of ``old_string`` with ``new_string``.

    Refuses if the path doesn't exist (use ``write_file_with_diff`` to
    create new files), if ``old_string`` doesn't appear, or if it appears
    more than once when ``replace_all`` is false. The registry enforces
    a separate read-before-edit precondition.
    """
    path = Path(str(args["path"])).expanduser()
    if not path.exists():
        raise ToolError(
            f"no such file: {path}. Use write_file_with_diff to create new files."
        )
    if not path.is_file():
        raise ToolError(f"not a file: {path}")

    old_string = str(args.get("old_string", ""))
    new_string = str(args.get("new_string", ""))
    if old_string == "":
        raise ToolError("old_string must not be empty")
    if old_string == new_string:
        raise ToolError("old_string and new_string are identical; nothing to do")

    replace_all = bool(args.get("replace_all", False))

    text = path.read_text(encoding="utf-8", errors="replace")
    count = text.count(old_string)
    if count == 0:
        raise ToolError(
            "old_string not found in file. Re-read the file and copy the exact "
            "bytes you want to replace (whitespace and newlines matter)."
        )
    if count > 1 and not replace_all:
        raise ToolError(
            f"old_string appears {count} times — provide more surrounding context "
            f"to make the match unique, or pass replace_all=true."
        )

    new_text = text.replace(old_string, new_string) if replace_all else text.replace(old_string, new_string, 1)

    diff = "".join(
        difflib.unified_diff(
            text.splitlines(keepends=True),
            new_text.splitlines(keepends=True),
            fromfile=f"a/{path.name}",
            tofile=f"b/{path.name}",
        )
    )
    path.write_text(new_text, encoding="utf-8")
    n = count if replace_all else 1
    return _truncate(f"edited {path} ({n} replacement{'s' if n != 1 else ''})\n\n{diff}")


edit_file = Tool(
    name="edit_file",
    description=(
        "Edit a file by replacing exact ``old_string`` with ``new_string``. "
        "Fails unless ``old_string`` matches exactly once (or pass replace_all=true). "
        "You must read_file the path first; the registry enforces this. "
        "Whitespace and indentation must match the file byte-for-byte. "
        "Requires user approval."
    ),
    args=[
        ArgSpec("path", "string", "Absolute or user-relative file path."),
        ArgSpec("old_string", "string", "Exact text to find. Must match the file's bytes verbatim."),
        ArgSpec("new_string", "string", "Replacement text."),
        ArgSpec("replace_all", "boolean", "Replace every occurrence instead of requiring uniqueness.", required=False),
    ],
    func=_edit_file,
    requires_approval=True,
)


# ---------------------------------------------------------------------------
# glob_files — fast file-pattern matching
# ---------------------------------------------------------------------------


# Directories we never want to walk into. Same set ripgrep skips by
# default; mirrored here so the Python fallback agrees.
_GLOB_SKIP_DIRS = frozenset({
    ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv",
    "env", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", "dist",
    "build", ".next", ".nuxt", ".cache", ".idea", ".vscode",
})


def _glob_files(args: Mapping[str, Any]) -> str:
    pattern = str(args.get("pattern", "")).strip()
    if not pattern:
        raise ToolError("pattern required (e.g. '**/*.py' or 'src/**/*.tsx')")
    base = args.get("path")
    base_path = Path(str(base)).expanduser() if base else Path.cwd()
    if not base_path.exists() or not base_path.is_dir():
        raise ToolError(f"path is not a directory: {base_path}")

    try:
        head_limit = int(args.get("head_limit", 100))
    except (TypeError, ValueError):
        raise ToolError("head_limit must be an integer")
    head_limit = max(1, min(head_limit, 5000))

    matches: list = []
    # pathlib.Path.glob handles ** properly and respects symlinks safely.
    for p in base_path.glob(pattern):
        if not p.is_file():
            continue
        if any(part in _GLOB_SKIP_DIRS for part in p.relative_to(base_path).parts):
            continue
        try:
            mtime = p.stat().st_mtime
        except OSError:
            continue
        matches.append((mtime, str(p)))

    matches.sort(key=lambda t: t[0], reverse=True)
    if not matches:
        return f"(no files matched {pattern!r} under {base_path})"

    truncated = len(matches) > head_limit
    matches = matches[:head_limit]
    body = "\n".join(p for _m, p in matches)
    if truncated:
        body += f"\n\n... [truncated to first {head_limit} of many matches; narrow your pattern]"
    return _truncate(body)


glob_files = Tool(
    name="glob_files",
    description=(
        "Find files by glob pattern (e.g. '**/*.py', 'src/**/*.{ts,tsx}'). "
        "Returns absolute paths sorted by modification time (newest first). "
        "Skips .git, node_modules, __pycache__, build/dist directories."
    ),
    args=[
        ArgSpec("pattern", "string", "Glob pattern."),
        ArgSpec("path", "string", "Directory to search under (default: cwd).", required=False),
        ArgSpec("head_limit", "integer", "Max results (default 100, max 5000).", required=False),
    ],
    func=_glob_files,
    requires_approval=False,
)


# ---------------------------------------------------------------------------
# grep — regex search across files (ripgrep with Python fallback)
# ---------------------------------------------------------------------------


_GREP_MODES = {"content", "files_with_matches", "count"}


def _grep_with_ripgrep(
    rg: str,
    pattern: str,
    base: Path,
    glob_filter: Optional[str],
    mode: str,
    case_insensitive: bool,
    context: int,
    head_limit: int,
) -> Optional[str]:
    """Run ripgrep and return its output. None means rg ran but found nothing."""
    cmd = [rg, "--no-config"]
    if mode == "files_with_matches":
        cmd.append("-l")
    elif mode == "count":
        cmd.append("-c")
    else:
        cmd.append("-n")
        if context > 0:
            cmd.extend(["-C", str(context)])
    if case_insensitive:
        cmd.append("-i")
    if glob_filter:
        cmd.extend(["--glob", glob_filter])
    cmd.extend(["--", pattern, str(base)])

    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=60,
            encoding="utf-8", errors="replace",
        )
    except subprocess.TimeoutExpired:
        raise ToolError("grep timed out after 60s; narrow your pattern or path")
    except OSError as exc:
        raise ToolError(f"ripgrep invocation failed: {exc}")

    # rg exits 1 when there are no matches — that's not an error.
    if proc.returncode not in (0, 1):
        err = (proc.stderr or "").strip()
        raise ToolError(f"ripgrep failed (exit {proc.returncode}): {err}")

    out = proc.stdout or ""
    if not out.strip():
        return None
    lines = out.splitlines()
    truncated = len(lines) > head_limit
    if truncated:
        lines = lines[:head_limit]
        lines.append(f"... [truncated to first {head_limit} lines]")
    return "\n".join(lines)


def _grep_python_fallback(
    pattern: str,
    base: Path,
    glob_filter: Optional[str],
    mode: str,
    case_insensitive: bool,
    context: int,
    head_limit: int,
) -> Optional[str]:
    """Pure-Python fallback when ripgrep isn't available.

    Slower, no fancy heuristics, but correct on the common cases.
    Limits itself to <=2 MB per file so a stray binary doesn't stall.
    """
    flags = re.IGNORECASE if case_insensitive else 0
    try:
        rx = re.compile(pattern, flags)
    except re.error as exc:
        raise ToolError(f"invalid regex: {exc}")

    out_lines: list = []
    files_seen: set = set()

    for p in base.rglob("*"):
        if not p.is_file():
            continue
        rel_parts = p.relative_to(base).parts
        if any(part in _GLOB_SKIP_DIRS for part in rel_parts):
            continue
        if glob_filter and not fnmatch.fnmatch(p.name, glob_filter):
            continue
        try:
            if p.stat().st_size > 2 * 1024 * 1024:
                continue
        except OSError:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            continue

        lines = text.splitlines()
        match_idxs = [i for i, ln in enumerate(lines) if rx.search(ln)]
        if not match_idxs:
            continue

        if mode == "files_with_matches":
            out_lines.append(str(p))
        elif mode == "count":
            out_lines.append(f"{p}:{len(match_idxs)}")
        else:  # content
            files_seen.add(str(p))
            for i in match_idxs:
                lo = max(0, i - context)
                hi = min(len(lines), i + context + 1)
                for j in range(lo, hi):
                    sep = ":" if j == i else "-"
                    out_lines.append(f"{p}:{j + 1}{sep}{lines[j]}")
            if context > 0:
                out_lines.append("--")

        if len(out_lines) >= head_limit * 2:
            break

    if not out_lines:
        return None
    truncated = len(out_lines) > head_limit
    if truncated:
        out_lines = out_lines[:head_limit]
        out_lines.append(f"... [truncated to first {head_limit} lines]")
    return "\n".join(out_lines)


def _grep(args: Mapping[str, Any]) -> str:
    pattern = str(args.get("pattern", "")).strip()
    if not pattern:
        raise ToolError("pattern required (regex)")
    base = args.get("path")
    base_path = Path(str(base)).expanduser() if base else Path.cwd()
    if not base_path.exists():
        raise ToolError(f"no such path: {base_path}")
    if base_path.is_file():
        # Allow grepping a single file by passing it as path.
        base_path = base_path
    elif not base_path.is_dir():
        raise ToolError(f"path is neither file nor directory: {base_path}")

    mode = str(args.get("output_mode", "files_with_matches")).strip()
    if mode not in _GREP_MODES:
        raise ToolError(f"output_mode must be one of {sorted(_GREP_MODES)}")
    case_insensitive = bool(args.get("case_insensitive", False))
    glob_filter = args.get("glob")
    glob_filter = str(glob_filter).strip() if glob_filter else None

    try:
        context = int(args.get("context", 0)) if args.get("context") not in (None, "") else 0
    except (TypeError, ValueError):
        raise ToolError("context must be an integer")
    context = max(0, min(context, 20))

    try:
        head_limit = int(args.get("head_limit", 50)) if args.get("head_limit") not in (None, "") else 50
    except (TypeError, ValueError):
        raise ToolError("head_limit must be an integer")
    head_limit = max(1, min(head_limit, 1000))

    rg = shutil.which("rg")
    result: Optional[str]
    if rg:
        result = _grep_with_ripgrep(
            rg, pattern, base_path, glob_filter, mode,
            case_insensitive, context, head_limit,
        )
    else:
        result = _grep_python_fallback(
            pattern, base_path, glob_filter, mode,
            case_insensitive, context, head_limit,
        )

    if result is None:
        return f"(no matches for {pattern!r} under {base_path})"
    return _truncate(result)


grep = Tool(
    name="grep",
    description=(
        "Regex search across files (ripgrep when available, Python fallback otherwise). "
        "Modes: 'files_with_matches' (default — file paths only), 'content' (matched lines "
        "with file:line: prefix; supports context lines), 'count' (matches per file). "
        "Filter file types with the ``glob`` arg, e.g. '*.py'. Skips git/node_modules/build "
        "dirs. Caps at 50 results by default; raise head_limit if needed."
    ),
    args=[
        ArgSpec("pattern", "string", "Regex pattern (ripgrep-flavored, PCRE-lite)."),
        ArgSpec("path", "string", "File or directory to search (default: cwd).", required=False),
        ArgSpec("glob", "string", "Filename glob filter (e.g. '*.py').", required=False),
        ArgSpec("output_mode", "string", "'files_with_matches' | 'content' | 'count'.", required=False),
        ArgSpec("case_insensitive", "boolean", "Case-insensitive search.", required=False),
        ArgSpec("context", "integer", "Lines of context (content mode, 0-20).", required=False),
        ArgSpec("head_limit", "integer", "Max output lines/results (default 50, max 1000).", required=False),
    ],
    func=_grep,
    requires_approval=False,
)


# ---------------------------------------------------------------------------
# todo_write — structured task list
# ---------------------------------------------------------------------------


# Stored per-process in memory. Multi-agent jobs each get their own list
# keyed by (agent_name, goal_id) but the tool function only sees the args
# dict, so we expose ``set_todo_context`` that the orchestrator can call
# before dispatching a turn. Without context, all writes share the
# default key — that's fine for single-agent use.
_TODOS_LOCK = threading.Lock()
_TODOS: dict = {}
_TODO_CONTEXT = threading.local()


def set_todo_context(agent: str, goal_id: str) -> None:
    """Pin the todo list for the calling thread to (agent, goal_id).

    The orchestrator calls this before invoking a tool round-trip so each
    agent's todos stay isolated. Threading.local means cross-thread agent
    workers don't trample each other.
    """
    _TODO_CONTEXT.key = (agent, goal_id)


def _todo_key() -> tuple:
    return getattr(_TODO_CONTEXT, "key", ("default", "default"))


_TODO_STATES = {"pending", "in_progress", "completed"}


def _todo_write(args: Mapping[str, Any]) -> str:
    raw = args.get("todos")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ToolError(f"todos must be JSON array; parse error: {exc}")
    if not isinstance(raw, list):
        raise ToolError("todos must be an array of {content, status, activeForm} objects")

    cleaned: list = []
    in_progress_seen = 0
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ToolError(f"todos[{i}] must be an object")
        content = str(item.get("content", "")).strip()
        status = str(item.get("status", "")).strip()
        active = str(item.get("activeForm", "")).strip()
        if not content:
            raise ToolError(f"todos[{i}].content is required")
        if status not in _TODO_STATES:
            raise ToolError(f"todos[{i}].status must be one of {sorted(_TODO_STATES)}")
        if not active:
            active = content
        if status == "in_progress":
            in_progress_seen += 1
        cleaned.append({"content": content, "status": status, "activeForm": active})

    if in_progress_seen > 1:
        raise ToolError(
            f"only one task may be in_progress at a time (found {in_progress_seen})"
        )

    key = _todo_key()
    with _TODOS_LOCK:
        _TODOS[key] = cleaned

    # Render a compact summary the agent can see in the tool result.
    glyph = {"pending": "○", "in_progress": "◐", "completed": "●"}
    rendered = "\n".join(f"  {glyph[t['status']]} {t['content']}" for t in cleaned)
    return f"updated todo list ({len(cleaned)} items):\n{rendered or '  (empty)'}"


def get_todos(agent: str = "default", goal_id: str = "default") -> list:
    """Read-only accessor for the UI to render the agent's current todos."""
    with _TODOS_LOCK:
        return list(_TODOS.get((agent, goal_id), []))


todo_write = Tool(
    name="todo_write",
    description=(
        "Record / update a structured task list for the current goal. Pass the FULL "
        "list each call (not a delta). Each item: {content, status, activeForm}. "
        "status ∈ {pending, in_progress, completed}. Exactly one item may be in_progress. "
        "Use for any job with 3+ steps to stay coherent across many tool calls."
    ),
    args=[
        ArgSpec("todos", "string", "JSON array of todo objects, or the array itself."),
    ],
    func=_todo_write,
    requires_approval=False,
)


# ---------------------------------------------------------------------------
# Default registry
# ---------------------------------------------------------------------------


def builtin_registry() -> ToolRegistry:
    """Fresh registry preloaded with all built-in tools.

    Each call returns a new ``ToolRegistry`` with its own ``ApprovalGate`` —
    callers that want a shared gate (e.g. one UI per process) should wire
    that explicitly via the ``Agent`` plumbing later.
    """
    from core.agents.tools.git_tools import GIT_TOOLS

    reg = ToolRegistry()
    reg.register(read_file)
    reg.register(write_file_with_diff)
    reg.register(edit_file)
    reg.register(list_dir)
    reg.register(glob_files)
    reg.register(grep)
    reg.register(todo_write)
    reg.register(shell)
    reg.register(http_get)
    reg.register(ssh_exec)
    reg.register(ssh_upload)
    reg.register(ssh_download)
    for t in GIT_TOOLS:
        reg.register(t)
    return reg
