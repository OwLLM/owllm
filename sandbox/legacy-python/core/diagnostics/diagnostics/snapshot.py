"""OWLLM state-snapshot — dumps a portable zip for offline analysis.

Inventory captured (when present on disk):

* ``LLM/data/`` — owllm_state.db (+ -shm/-wal), agent_memory.sqlite,
  agent_definitions/, team_templates/, skills/
* ``LLM/configs/`` — llm_backends.yaml and any other top-level YAML
* ``LLM/logs/`` — recent ``*.log`` files (last N days, capped per file)
* ``~/.owllm/`` — bridge_config.json (REDACTED), fleet/audit.log.jsonl,
  owllm-launch.log
* ``system/processes.json`` — OWLLM-related running processes
* ``system/host.json`` — OS, Python, working directory, time
* ``system/agent_setup.json`` — :func:`core.agents.setup.check_agent_setup`
  output (Docker / claude / codex prerequisite probe state)
* ``system/wer_crashes.json`` — recent ``python.exe`` Windows Error
  Reporting entries (Windows-only)

Output: a zip with ``manifest.json`` at the root listing every included
file + size + sha256 + redaction summary. Designed to be inspected with
``unzip + cat manifest.json`` and individual files extracted as needed.

Redaction
---------

Plain-text files (``.json``, ``.yaml``, ``.yml``, ``.log``, ``.jsonl``,
``.txt``) are passed through a regex set before zipping:

* Telegram bot tokens (``\\d{8,12}:[A-Za-z0-9_-]{30,}``)
* ``token|api_key|secret|password|bearer`` field values in JSON-ish
  contexts
* Long base64-ish runs (40+ chars) outside JSON
* User home path replaced with ``${HOME}``

SQLite databases are included verbatim — they're binary and our regex
set won't catch in-row secrets. The manifest warns about this; users
can pass ``--no-dbs`` for max privacy.

CLI
---

::

    python -m core.diagnostics.snapshot --out ~/Desktop/owllm.zip
    python -m core.diagnostics.snapshot --no-redact --no-dbs
    python -m core.diagnostics.snapshot --logs-days 3
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Constants — inventory + redaction
# ---------------------------------------------------------------------------


# File extensions whose body we'll redact before zipping. Anything not on
# this list is included verbatim (binary or already-binary-ish).
_REDACTABLE_EXTENSIONS = {".json", ".yaml", ".yml", ".log", ".jsonl", ".txt", ".cfg", ".ini"}

# Per-file cap for log files — logs can get into the hundreds of MB and
# blow up the zip. Take the tail.
_PER_LOG_TAIL_BYTES = 512 * 1024  # 512 KB

# Hard ceiling on a single file inside the zip — protects against
# accidentally pulling in a 4 GB cuda_detection.log.
_PER_FILE_HARD_CAP = 5 * 1024 * 1024  # 5 MB

# JSON keys whose value should always be redacted (case-insensitive,
# substring match). Conservative — false positives are fine, false
# negatives are not.
_SECRET_KEY_PATTERNS = {
    "token", "api_key", "apikey", "secret", "password", "passwd",
    "bearer", "auth", "credential", "private_key", "client_secret",
    "session", "cookie",
}

# Regex set applied to text bodies.
_REDACTION_REGEXES: List[Tuple[re.Pattern[str], str]] = [
    # Telegram bot tokens: 8-12 digit numeric id, colon, 30+ url-safe chars.
    (re.compile(r"\b\d{8,12}:[A-Za-z0-9_\-]{30,}\b"), "***REDACTED-TELEGRAM-TOKEN***"),
    # Anthropic / OpenAI key shapes.
    (re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}"), "***REDACTED-ANTHROPIC-KEY***"),
    (re.compile(r"sk-[A-Za-z0-9]{20,}"), "***REDACTED-OPENAI-KEY***"),
    # Bare JWT-ish tokens (3 base64 segments). Cheap heuristic.
    (
        re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b"),
        "***REDACTED-JWT***",
    ),
    # GitHub PATs.
    (re.compile(r"\bghp_[A-Za-z0-9]{30,}\b"), "***REDACTED-GITHUB-PAT***"),
]


# ---------------------------------------------------------------------------
# Result dataclass
# ---------------------------------------------------------------------------


@dataclass
class SnapshotResult:
    """What the snapshotter produced."""

    out_path: Path
    """Path to the written zip."""

    file_count: int
    """Number of files inside the zip (excluding the manifest itself)."""

    total_size: int
    """Sum of compressed-file sizes inside the zip."""

    redactions: int
    """Count of regex hits across all files."""

    warnings: List[str] = field(default_factory=list)
    """Notes about excluded sources, partial reads, or privacy caveats."""

    skipped: List[str] = field(default_factory=list)
    """Files that were inventoried but skipped (e.g. exceeded hard cap)."""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _llm_root() -> Path:
    """Resolve the ``LLM/`` directory regardless of CWD."""
    return Path(__file__).resolve().parents[2]


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _normalize_path(p: str | Path, home: Path) -> str:
    """Replace user home with ``${HOME}`` for portability + privacy."""
    text = str(p)
    home_str = str(home)
    if text.startswith(home_str):
        return "${HOME}" + text[len(home_str):].replace("\\", "/")
    return text.replace("\\", "/")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _redact_text(text: str) -> Tuple[str, int]:
    """Apply the regex set + JSON-key-name redaction to a text body.

    Returns ``(redacted_text, hit_count)``. The JSON pass first replaces
    values inside ``"key": "value"`` patterns when the key matches one
    of :data:`_SECRET_KEY_PATTERNS`; the regex pass then catches
    standalone occurrences (e.g. tokens in log lines).
    """
    hits = 0

    # Pass 1a: JSON-style "secret_key": "value" or "secret_key" = "value"
    def _kv_quoted_sub(match: re.Match[str]) -> str:
        nonlocal hits
        key = match.group("key").strip('"\'').lower()
        if any(pat in key for pat in _SECRET_KEY_PATTERNS):
            hits += 1
            return f'{match.group("prefix")}"***REDACTED***"'
        return match.group(0)

    kv_quoted_re = re.compile(
        r'(?P<prefix>["\']?(?P<key>[A-Za-z0-9_\-]+)["\']?\s*[:=]\s*)'
        r'"(?P<value>[^"\n]{1,4096})"'
    )
    text = kv_quoted_re.sub(_kv_quoted_sub, text)

    # Pass 1b: YAML / .ini-style unquoted ``key: value`` where the value
    # is a single non-whitespace run of 8+ chars. Threshold avoids
    # redacting short flags like ``debug: true``.
    def _kv_unquoted_sub(match: re.Match[str]) -> str:
        nonlocal hits
        key = match.group("key").lower()
        if any(pat in key for pat in _SECRET_KEY_PATTERNS):
            hits += 1
            return f'{match.group("prefix")}***REDACTED***'
        return match.group(0)

    kv_unquoted_re = re.compile(
        r'(?P<prefix>(?:^|\n)\s*(?P<key>[A-Za-z][A-Za-z0-9_\-]*)\s*[:=]\s*)'
        r'(?P<value>[^\s\n"\'{},\[\]]{8,4096})'
    )
    text = kv_unquoted_re.sub(_kv_unquoted_sub, text)

    # Pass 2: regex set.
    for pat, replacement in _REDACTION_REGEXES:
        text, n = pat.subn(replacement, text)
        hits += n
    return text, hits


def _read_bounded(path: Path, *, max_bytes: int) -> Tuple[bytes, bool]:
    """Read a file, returning the tail if it exceeds ``max_bytes``.

    Tail (not head) because we want the *recent* log content, which is
    the relevant data for diagnostics. The boolean second element flags
    whether truncation happened so the manifest can record it.
    """
    size = path.stat().st_size
    if size <= max_bytes:
        return path.read_bytes(), False
    with path.open("rb") as f:
        f.seek(size - max_bytes)
        return f.read(), True


def _process_snapshot() -> List[Dict[str, Any]]:
    """List OWLLM-related running processes. Cross-platform; never raises.

    On Windows uses ``Get-CimInstance Win32_Process`` for parent PIDs
    + command lines; elsewhere falls back to ``ps -ef``. Both filtered
    to the names we care about (python, claude, codex, node, docker,
    llama-server).
    """
    keep_re = re.compile(r"python|claude|codex|node|docker|llama", re.IGNORECASE)
    rows: List[Dict[str, Any]] = []

    if os.name == "nt":
        cmd = [
            "powershell", "-NoProfile", "-Command",
            "Get-CimInstance Win32_Process | "
            "Select-Object Name, ProcessId, ParentProcessId, "
            "CreationDate, CommandLine | ConvertTo-Json -Depth 2",
        ]
    else:
        cmd = ["ps", "-eo", "pid,ppid,comm,args"]
    try:
        creationflags = 0x08000000 if os.name == "nt" else 0
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=15,
            creationflags=creationflags,
        )
        out = proc.stdout
    except (FileNotFoundError, subprocess.SubprocessError, OSError) as exc:
        return [{"_error": f"process probe failed: {exc}"}]

    if os.name == "nt":
        try:
            data = json.loads(out) if out.strip() else []
            if isinstance(data, dict):
                data = [data]
            for entry in data:
                name = str(entry.get("Name") or "")
                if not keep_re.search(name):
                    continue
                rows.append({
                    "name": name,
                    "pid": entry.get("ProcessId"),
                    "ppid": entry.get("ParentProcessId"),
                    "started": str(entry.get("CreationDate") or ""),
                    "argv": str(entry.get("CommandLine") or ""),
                })
        except (json.JSONDecodeError, TypeError):
            return [{"_error": "could not parse Win32_Process output"}]
    else:
        for line in out.splitlines()[1:]:  # skip header
            if not keep_re.search(line):
                continue
            parts = line.split(None, 3)
            if len(parts) >= 4:
                rows.append({
                    "pid": parts[0], "ppid": parts[1],
                    "name": parts[2], "argv": parts[3],
                })
    return rows


def _wer_crashes() -> List[Dict[str, Any]]:
    """Recent python.exe Windows Error Reporting entries (last 7 days).

    Windows-only. Returns ``[]`` on any other platform or on failure —
    crash forensics are nice-to-have, not load-bearing.
    """
    if os.name != "nt":
        return []
    ps = (
        "Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000; "
        "StartTime=(Get-Date).AddDays(-7)} -ErrorAction SilentlyContinue | "
        "Where-Object { $_.Message -match 'python.exe' } | "
        "Select-Object TimeCreated, Id, "
        "@{N='Msg'; E={$_.Message.Substring(0, [Math]::Min(800, $_.Message.Length))}} | "
        "ConvertTo-Json -Depth 2"
    )
    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            capture_output=True, text=True, timeout=20,
            creationflags=0x08000000,
        )
        if not proc.stdout.strip():
            return []
        data = json.loads(proc.stdout)
        if isinstance(data, dict):
            data = [data]
        return [
            {
                "time": str(e.get("TimeCreated") or ""),
                "id": e.get("Id"),
                "message": str(e.get("Msg") or ""),
            }
            for e in data
        ]
    except (FileNotFoundError, subprocess.SubprocessError,
            json.JSONDecodeError, OSError):
        return []


def _host_info() -> Dict[str, Any]:
    """OS / Python / time / hostname. No identifying info beyond hostname."""
    return {
        "platform": sys.platform,
        "os_name": os.name,
        "python_version": sys.version.split()[0],
        "python_executable": sys.executable,
        "hostname": socket.gethostname(),
        "cwd": str(Path.cwd()),
        "captured_at_utc": _now_iso(),
    }


def _agent_setup_info() -> Dict[str, Any]:
    """Snapshot of ``check_agent_setup()`` — Docker / claude / codex state.

    Caught broadly so a probe failure doesn't kill the snapshot run.
    """
    try:
        from core.agents.setup import check_agent_setup
        s = check_agent_setup()
        return {
            "state": s.state.value if hasattr(s.state, "value") else str(s.state),
            "docker_installed": s.docker_installed,
            "docker_running": s.docker_running,
            "claude_cli_on_host": s.claude_cli_on_host,
            "claude_logged_in": s.claude_logged_in,
            "codex_cli_on_host": s.codex_cli_on_host,
            "codex_logged_in": s.codex_logged_in,
            "recommendations": list(s.recommendations),
        }
    except Exception as exc:  # noqa: BLE001
        return {"_error": f"agent_setup probe failed: {exc}"}


# ---------------------------------------------------------------------------
# Inventory + bundle
# ---------------------------------------------------------------------------


def _inventory(
    *,
    include_logs: bool,
    include_dbs: bool,
    logs_days: int,
) -> List[Tuple[Path, str]]:
    """Build the (source_path, archive_path) list for everything that should
    go into the zip. Excludes anything that isn't on disk; never raises.

    ``archive_path`` is the path inside the zip — flat, forward-slash,
    relative to the zip root.
    """
    root = _llm_root()
    home = Path.home()
    items: List[Tuple[Path, str]] = []

    data_dir = root / "data"
    if data_dir.exists():
        if include_dbs:
            for name in ("owllm_state.db", "owllm_state.db-shm",
                         "owllm_state.db-wal", "agent_memory.sqlite"):
                p = data_dir / name
                if p.exists() and p.is_file():
                    items.append((p, f"state/{name}"))
        for sub in ("agent_definitions", "team_templates", "skills"):
            d = data_dir / sub
            if d.exists() and d.is_dir():
                for f in d.rglob("*"):
                    if f.is_file():
                        rel = f.relative_to(d).as_posix()
                        items.append((f, f"state/{sub}/{rel}"))

    configs_dir = root / "configs"
    if configs_dir.exists():
        for f in configs_dir.glob("*"):
            if f.is_file():
                items.append((f, f"configs/{f.name}"))

    if include_logs:
        logs_dir = root / "logs"
        cutoff = time.time() - (logs_days * 86400)
        if logs_dir.exists():
            for f in logs_dir.glob("*"):
                if not f.is_file():
                    continue
                try:
                    if f.stat().st_mtime < cutoff:
                        continue
                except OSError:
                    continue
                items.append((f, f"logs/{f.name}"))

    home_owllm = home / ".owllm"
    if home_owllm.exists():
        for name in ("bridge_config.json", "owllm-launch.log"):
            p = home_owllm / name
            if p.exists() and p.is_file():
                items.append((p, f"home_dotowllm/{name}"))
        audit = home_owllm / "fleet" / "audit.log.jsonl"
        if audit.exists() and audit.is_file():
            items.append((audit, "home_dotowllm/fleet/audit.log.jsonl"))

    return items


def _write_file_to_zip(
    zf: zipfile.ZipFile,
    src: Path,
    arcname: str,
    *,
    redact: bool,
) -> Tuple[Dict[str, Any], int]:
    """Add a single file to the zip with bounded read + optional redaction.

    Returns the manifest entry + redaction count.
    """
    suffix = src.suffix.lower()
    is_log = arcname.startswith("logs/") or suffix in {".log", ".jsonl"}
    is_redactable_text = suffix in _REDACTABLE_EXTENSIONS
    cap = _PER_LOG_TAIL_BYTES if is_log else _PER_FILE_HARD_CAP

    try:
        data, truncated = _read_bounded(src, max_bytes=cap)
    except OSError as exc:
        return {
            "path": arcname, "error": f"read failed: {exc}",
            "size": 0, "sha256": "",
        }, 0

    redactions = 0
    notes: List[str] = []
    if truncated:
        notes.append(f"truncated to last {cap} bytes")

    if redact and is_redactable_text:
        try:
            decoded = data.decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            decoded = None
        if decoded is not None:
            decoded, redactions = _redact_text(decoded)
            data = decoded.encode("utf-8")
            if redactions:
                notes.append(f"{redactions} redactions applied")

    zf.writestr(arcname, data)
    return {
        "path": arcname,
        "size": len(data),
        "sha256": _sha256(data),
        "notes": notes,
    }, redactions


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def create_snapshot(
    out_path: Path | str,
    *,
    redact: bool = True,
    include_logs: bool = True,
    include_dbs: bool = True,
    logs_days: int = 1,
) -> SnapshotResult:
    """Write a snapshot zip and return the result.

    ``out_path`` is created (or overwritten). The zip is built in a
    temp file first then moved into place so a failed run never leaves
    a half-written zip behind.
    """
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    home = Path.home()
    manifest: Dict[str, Any] = {
        "format": "owllm-snapshot/1",
        "created_at_utc": _now_iso(),
        "host": _host_info(),
        "options": {
            "redact": redact,
            "include_logs": include_logs,
            "include_dbs": include_dbs,
            "logs_days": logs_days,
        },
        "warnings": [],
        "files": [],
    }
    warnings: List[str] = []
    skipped: List[str] = []
    total_redactions = 0

    if include_dbs:
        warnings.append(
            "SQLite databases included verbatim — may contain user-typed goal "
            "text. Inspect before sharing if you ever typed credentials as a goal."
        )

    items = _inventory(
        include_logs=include_logs,
        include_dbs=include_dbs,
        logs_days=logs_days,
    )

    fd, tmp_name = tempfile.mkstemp(suffix=".zip", prefix="owllm_snapshot_")
    os.close(fd)
    tmp_path = Path(tmp_name)
    try:
        with zipfile.ZipFile(
            tmp_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6,
        ) as zf:
            # File payloads first.
            for src, arc in items:
                entry, n = _write_file_to_zip(zf, src, arc, redact=redact)
                manifest["files"].append(entry)
                total_redactions += n

            # System probes — written directly as JSON into the zip.
            proc_data = json.dumps(_process_snapshot(), indent=2, default=str)
            zf.writestr("system/processes.json", proc_data)
            manifest["files"].append({
                "path": "system/processes.json",
                "size": len(proc_data),
                "sha256": _sha256(proc_data.encode("utf-8")),
                "notes": ["generated"],
            })

            host_data = json.dumps(_host_info(), indent=2)
            zf.writestr("system/host.json", host_data)
            manifest["files"].append({
                "path": "system/host.json",
                "size": len(host_data),
                "sha256": _sha256(host_data.encode("utf-8")),
                "notes": ["generated"],
            })

            agent_data = json.dumps(_agent_setup_info(), indent=2)
            zf.writestr("system/agent_setup.json", agent_data)
            manifest["files"].append({
                "path": "system/agent_setup.json",
                "size": len(agent_data),
                "sha256": _sha256(agent_data.encode("utf-8")),
                "notes": ["generated"],
            })

            wer_data = json.dumps(_wer_crashes(), indent=2)
            zf.writestr("system/wer_crashes.json", wer_data)
            manifest["files"].append({
                "path": "system/wer_crashes.json",
                "size": len(wer_data),
                "sha256": _sha256(wer_data.encode("utf-8")),
                "notes": ["generated"],
            })

            manifest["warnings"] = warnings
            manifest["redactions_total"] = total_redactions
            manifest["file_count"] = len(manifest["files"])
            zf.writestr(
                "manifest.json",
                json.dumps(manifest, indent=2, default=str),
            )

        # Atomic-ish move into place.
        if out_path.exists():
            out_path.unlink()
        shutil.move(str(tmp_path), str(out_path))
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass

    total_size = sum(int(f.get("size", 0)) for f in manifest["files"])
    return SnapshotResult(
        out_path=out_path,
        file_count=len(manifest["files"]),
        total_size=total_size,
        redactions=total_redactions,
        warnings=warnings,
        skipped=skipped,
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _cli(argv: Optional[List[str]] = None) -> int:
    import argparse
    p = argparse.ArgumentParser(
        prog="python -m core.diagnostics.snapshot",
        description="Bundle OWLLM state (DBs, configs, logs, processes) into a zip for offline analysis.",
    )
    default_out = Path.home() / "Desktop" / f"owllm_snapshot_{int(time.time())}.zip"
    p.add_argument("--out", type=Path, default=default_out, help=f"output zip path (default: {default_out})")
    p.add_argument("--no-redact", action="store_true", help="skip text-body redaction (use for trusted local analysis only)")
    p.add_argument("--no-logs", action="store_true", help="skip log files (smaller archive)")
    p.add_argument("--no-dbs", action="store_true", help="skip SQLite databases (max privacy)")
    p.add_argument("--logs-days", type=int, default=1, help="include log files modified in the last N days (default: 1)")
    args = p.parse_args(argv)

    result = create_snapshot(
        args.out,
        redact=not args.no_redact,
        include_logs=not args.no_logs,
        include_dbs=not args.no_dbs,
        logs_days=args.logs_days,
    )

    print(f"OWLLM snapshot written: {result.out_path}")
    print(f"  Files:       {result.file_count}")
    print(f"  Total size:  {result.total_size / 1024:.1f} KB")
    print(f"  Redactions:  {result.redactions}")
    if result.warnings:
        print("Warnings:")
        for w in result.warnings:
            print(f"  - {w}")
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
