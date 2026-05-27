from __future__ import annotations
from pathlib import Path
from typing import List

def get_app_root() -> Path:
    return Path(__file__).resolve().parents[1]

def list_log_files(log_dir: Path | None = None) -> List[Path]:
    if log_dir is None:
        log_dir = get_app_root()
    patterns = ["*training*.txt", "*log*.txt", "*.log"]
    results: List[Path] = []
    for pat in patterns:
        results.extend(sorted(log_dir.glob(pat)))
    seen=set()
    uniq=[]
    for p in results:
        rp=p.resolve()
        if rp in seen:
            continue
        seen.add(rp)
        uniq.append(p)
    return uniq

def tail_file(path: Path, last_n: int = 4000) -> str:
    try:
        data = path.read_text(encoding="utf-8", errors="replace")
        if len(data) <= last_n:
            return data
        return data[-last_n:]
    except Exception as e:
        return f"[ERROR] Could not read {path}: {e}"
