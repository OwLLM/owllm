from __future__ import annotations

import os
import sqlite3
import subprocess
from pathlib import Path


def _read_running_servers(db_path: Path) -> list[dict]:
    con = sqlite3.connect(str(db_path))
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "SELECT model_id, pid, port, status FROM servers WHERE status IN ('RUNNING','STARTING')"
    ).fetchall()
    return [dict(r) for r in rows]


def _taskkill_pid(pid: int) -> bool:
    try:
        subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, timeout=10)
        return True
    except Exception:
        return False


def _pids_listening_on_port(port: int) -> set[int]:
    pids: set[int] = set()
    try:
        r = subprocess.run(["netstat", "-ano"], capture_output=True, text=True, timeout=10)
        port_str = f":{int(port)}"
        for line in (r.stdout or "").splitlines():
            if ("LISTENING" in line) and (port_str in line):
                parts = line.split()
                if parts and parts[-1].isdigit():
                    pids.add(int(parts[-1]))
    except Exception:
        pass
    return pids


def main() -> int:
    repo_root = Path(__file__).resolve().parents[2]  # .../LLM/tools -> repo root
    db_path = repo_root / "LLM" / "data" / "owllm_state.db"
    if not db_path.exists():
        print(f"[free_vram_now] State DB not found: {db_path}")
        return 1

    servers = _read_running_servers(db_path)
    print(f"[free_vram_now] running/starting servers: {len(servers)}")
    killed_pids: set[int] = set()

    # Kill by recorded PID first
    for s in servers:
        pid = s.get("pid")
        if pid:
            try:
                pid_i = int(pid)
            except Exception:
                continue
            if pid_i > 0 and pid_i not in killed_pids:
                if _taskkill_pid(pid_i):
                    killed_pids.add(pid_i)

    # Kill by recorded port (PID may be missing/stale)
    for s in servers:
        port = s.get("port")
        if not port:
            continue
        try:
            port_i = int(port)
        except Exception:
            continue
        if port_i <= 0:
            continue
        for pid_i in sorted(_pids_listening_on_port(port_i)):
            if pid_i not in killed_pids:
                if _taskkill_pid(pid_i):
                    killed_pids.add(pid_i)

    print(f"[free_vram_now] force-killed PIDs: {sorted(killed_pids)}")

    # Show remaining GPU compute apps (may include GUI apps on WDDM; still useful for python/server PIDs)
    try:
        r = subprocess.run(
            ["nvidia-smi", "--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if r.returncode == 0:
            print("[free_vram_now] nvidia-smi compute apps:")
            print((r.stdout or "").strip())
    except Exception:
        pass

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

