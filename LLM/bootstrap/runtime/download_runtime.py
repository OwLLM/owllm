"""Download the bundled supervisor runtime artifacts.

Fetches:
  - llama-server.exe  (or llama-server on POSIX)  -- llama.cpp release build
  - gemma-4-E2B-it-Q4_K_M.gguf                    -- ~1.5 GB

into LLM/bootstrap/runtime/. Run once on a dev machine before flipping
the supervisor master switch on:

    python LLM/bootstrap/runtime/download_runtime.py

The download URLs are configurable via env vars so you can point at a
mirror or a pinned release without editing source:

    LOCALLLM_LLAMA_SERVER_URL    -- direct .exe / binary URL
    LOCALLLM_GEMMA_GGUF_URL      -- direct .gguf URL
    LOCALLLM_LLAMA_SERVER_SHA256 -- optional checksum
    LOCALLLM_GEMMA_GGUF_SHA256   -- optional checksum

Production installer ships these files pre-extracted by the stub
installer (NSIS). This script is the dev/CI fallback.

The default URLs target Hugging Face for the GGUF and the official
llama.cpp GitHub releases for the binary. Both URLs may rot over time;
the Hugging Face mirror in particular re-publishes Q4_K_M variants
under slightly different paths -- if a download 404s, set the env var
and re-run.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import platform
import shutil
import sys
import urllib.request
from pathlib import Path
from typing import Optional


# --- defaults -------------------------------------------------------------

# Default URLs. CHANGE WITH RELEASE PINNING -- they're sensible starting
# points, not eternal truths. Environment variables override.
DEFAULT_LLAMA_SERVER_URL_WIN = (
    "https://github.com/ggerganov/llama.cpp/releases/latest/download/"
    "llama-bin-win-cpu-x64.zip"
)
DEFAULT_LLAMA_SERVER_URL_LINUX = (
    "https://github.com/ggerganov/llama.cpp/releases/latest/download/"
    "llama-bin-linux-cpu-x64.zip"
)
DEFAULT_GGUF_URL = (
    "https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/"
    "gemma-4-E2B-it-Q4_K_M.gguf"
)


HERE = Path(__file__).resolve().parent  # LLM/bootstrap/runtime/


# --- helpers --------------------------------------------------------------


def _download(url: str, dest: Path, expected_sha256: Optional[str] = None) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    print(f"  downloading {url}\n          -> {dest}")
    with urllib.request.urlopen(url) as resp, tmp.open("wb") as out:
        total = int(resp.getheader("Content-Length") or 0)
        read = 0
        chunk = 1024 * 256
        while True:
            data = resp.read(chunk)
            if not data:
                break
            out.write(data)
            read += len(data)
            if total:
                pct = 100 * read / total
                print(f"\r  {read/1e6:.1f} / {total/1e6:.1f} MB  ({pct:.1f}%)",
                      end="", flush=True)
        print()
    if expected_sha256:
        actual = _sha256(tmp)
        if actual.lower() != expected_sha256.lower():
            tmp.unlink(missing_ok=True)
            raise RuntimeError(
                f"sha256 mismatch for {dest.name}: "
                f"expected {expected_sha256}, got {actual}"
            )
    tmp.replace(dest)


def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _have_llama_server() -> Optional[Path]:
    """Return the path to an existing llama-server binary, if any."""
    if os.name == "nt":
        candidates = [HERE / "llama-server.exe"]
    else:
        candidates = [HERE / "llama-server"]
    for c in candidates:
        if c.exists() and c.stat().st_size > 0:
            return c
    return None


def _have_model() -> Optional[Path]:
    p = HERE / "gemma-4-E2B-it-Q4_K_M.gguf"
    return p if p.exists() and p.stat().st_size > 0 else None


def _extract_llama_server_from_zip(zip_path: Path) -> Path:
    """llama.cpp publishes its binaries inside a zip. Extract just
    llama-server[.exe] and discard the rest -- we only need the one tool."""
    import zipfile
    with zipfile.ZipFile(zip_path) as zf:
        target_name = "llama-server.exe" if os.name == "nt" else "llama-server"
        members = [m for m in zf.namelist() if m.endswith(target_name)]
        if not members:
            raise RuntimeError(
                f"{target_name} not found in {zip_path.name}. "
                "Set LOCALLLM_LLAMA_SERVER_URL to a direct binary URL "
                "if your llama.cpp release packages it differently."
            )
        # Pick the shallowest match (top-level binary, not nested).
        members.sort(key=lambda m: m.count("/"))
        member = members[0]
        with zf.open(member) as src, (HERE / target_name).open("wb") as dst:
            shutil.copyfileobj(src, dst)
        if os.name != "nt":
            (HERE / target_name).chmod(0o755)
    zip_path.unlink(missing_ok=True)
    return HERE / target_name


# --- driver ---------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true",
                    help="re-download even if files exist")
    ap.add_argument("--server-only", action="store_true",
                    help="only fetch llama-server, not the GGUF")
    ap.add_argument("--model-only", action="store_true",
                    help="only fetch the GGUF, not llama-server")
    args = ap.parse_args()

    print(f"target dir: {HERE}")
    print(f"platform:   {platform.system()} {platform.machine()}")

    if not args.model_only:
        existing = _have_llama_server()
        if existing and not args.force:
            print(f"  llama-server already present at {existing} -- skipping "
                  "(--force to re-download)")
        else:
            url = os.environ.get("LOCALLLM_LLAMA_SERVER_URL") or (
                DEFAULT_LLAMA_SERVER_URL_WIN if os.name == "nt"
                else DEFAULT_LLAMA_SERVER_URL_LINUX
            )
            sha = os.environ.get("LOCALLLM_LLAMA_SERVER_SHA256")
            if url.endswith(".zip"):
                tmp_zip = HERE / "_llama_release.zip"
                _download(url, tmp_zip, sha)
                bin_path = _extract_llama_server_from_zip(tmp_zip)
                print(f"  extracted -> {bin_path}")
            else:
                target = HERE / ("llama-server.exe" if os.name == "nt" else "llama-server")
                _download(url, target, sha)
                if os.name != "nt":
                    target.chmod(0o755)

    if not args.server_only:
        existing = _have_model()
        if existing and not args.force:
            print(f"  GGUF model already present at {existing} -- skipping "
                  "(--force to re-download)")
        else:
            url = os.environ.get("LOCALLLM_GEMMA_GGUF_URL") or DEFAULT_GGUF_URL
            sha = os.environ.get("LOCALLLM_GEMMA_GGUF_SHA256")
            target = HERE / "gemma-4-E2B-it-Q4_K_M.gguf"
            _download(url, target, sha)

    print("\ndone. To enable the supervisor on this machine:")
    if os.name == "nt":
        print(r"  $flags = \"$env:LOCALAPPDATA\OWLLM\feature_flags.json\"")
    else:
        print('  flags="$HOME/.config/owllm/feature_flags.json"')
    print('  set supervisor.enabled = true and supervisor.shadow_mode = true')
    print("see LLM/docs/supervisor/ROLLOUT.md for the full flow.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
