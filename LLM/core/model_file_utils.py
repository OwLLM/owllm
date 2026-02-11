"""
Model file utilities for deterministic per-file downloads.
Replaces snapshot_download to avoid hangs and provide real progress.
"""
import os
import sys
import time
import requests
from pathlib import Path
from typing import List, Dict, Optional, Callable
from urllib.parse import quote
import logging

logger = logging.getLogger(__name__)

# Windows subprocess flags to prevent CMD window flashing
SUBPROCESS_FLAGS = {}
if sys.platform == 'win32':
    import subprocess
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startupinfo.wShowWindow = subprocess.SW_HIDE
    SUBPROCESS_FLAGS = {
        'startupinfo': startupinfo,
        'creationflags': subprocess.CREATE_NO_WINDOW
    }


class ModelDirLockedError(RuntimeError):
    """Raised when a model directory cannot be deleted because files are locked by another process."""
    def __init__(self, model_dir: Path, message: str = None):
        self.model_dir = Path(model_dir)
        if message is None:
            message = f"Cannot clean {model_dir} - files are locked by another process."
        super().__init__(message)


def list_repo_files(repo_id: str, token: Optional[str] = None) -> List[Dict]:
    """
    List all files in a Hugging Face repository using REST API.
    
    Args:
        repo_id: Model repository ID (e.g., "unsloth/Qwen2.5-7B-Instruct-bnb-4bit")
        token: Optional Hugging Face token for private/gated repos
        
    Returns:
        List of file dicts with keys: 'rfilename', 'size', 'lfs', etc.
        
    Raises:
        RuntimeError: If API call fails or repo not found
    """
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    
    url = f"https://huggingface.co/api/models/{quote(repo_id, safe='/')}"
    
    try:
        resp = requests.get(
            url,
            params={"files_metadata": "true"},
            headers=headers,
            timeout=(5.0, 15.0)
        )
        resp.raise_for_status()
        data = resp.json()
        siblings = data.get("siblings", [])
        
        if not siblings:
            raise RuntimeError(f"Repository {repo_id} has no files or is empty")
        
        return siblings
    except requests.exceptions.HTTPError as e:
        if e.response.status_code == 401:
            raise RuntimeError(
                f"Repository {repo_id} requires authentication. "
                "Please set HF_TOKEN (or HUGGINGFACE_HUB_TOKEN) environment variable."
            )
        elif e.response.status_code == 403:
            raise RuntimeError(
                f"Repository {repo_id} is private/gated. "
                "Please request access/accept the model terms on Hugging Face, then set HF_TOKEN (or HUGGINGFACE_HUB_TOKEN)."
            )
        elif e.response.status_code == 404:
            raise RuntimeError(f"Repository {repo_id} not found on Hugging Face")
        else:
            raise RuntimeError(f"Failed to list files for {repo_id}: HTTP {e.response.status_code}")
    except requests.exceptions.Timeout:
        raise RuntimeError(f"Timeout connecting to Hugging Face API for {repo_id}")
    except requests.exceptions.RequestException as e:
        raise RuntimeError(f"Network error listing files for {repo_id}: {e}")


def clean_download_locks(dest_dir: Path, remove_incomplete: bool = False) -> None:
    """
    Aggressively clean all HuggingFace download locks and incomplete files.
    Call this before attempting to delete/redownload a model.
    """
    logger.info(f"Cleaning locks in {dest_dir}")
    try:
        cache_dir = dest_dir / ".cache" / "huggingface" / "download"
        if cache_dir.exists():
            import time
            import sys
            import subprocess
            patterns = ["*.lock"]
            if remove_incomplete:
                patterns.append("*.incomplete")
            for pattern in patterns:
                for lockfile in cache_dir.glob(pattern):
                    try:
                        if sys.platform == "win32":
                            # Clear read-only attribute if present
                            subprocess.run(["attrib", "-R", str(lockfile)], capture_output=True, timeout=2, **SUBPROCESS_FLAGS)
                        lockfile.unlink(missing_ok=True)
                        logger.debug(f"Removed {lockfile.name}")
                    except Exception as e:
                        logger.warning(f"Could not remove {lockfile.name}: {e}")
                        # Wait a bit and try again
                        time.sleep(0.5)
                        try:
                            if sys.platform == "win32":
                                subprocess.run(["attrib", "-R", str(lockfile)], capture_output=True, timeout=2, **SUBPROCESS_FLAGS)
                            lockfile.unlink(missing_ok=True)
                        except Exception:
                            pass
    except Exception as cleanup_error:
        logger.warning(f"Lock cleanup failed: {cleanup_error}")


def kill_processes_locking_directory(dest_dir: Path) -> None:
    """
    Kill any processes that might be locking files in the given directory.
    On Windows, finds Python processes that might have file handles open.
    """
    import sys
    import subprocess
    import time
    
    if sys.platform != "win32":
        return
    
    try:
        dest_dir = Path(dest_dir)
        dir_name = dest_dir.name
        
        # Find Python processes that might be downloading to this directory
        # Use wmic to find processes with the directory name in command line
        try:
            cmd = f'wmic process where "CommandLine like \'%{dir_name}%\' or CommandLine like \'%huggingface%\'" get ProcessId,CommandLine /format:list'
            result = subprocess.run(
                cmd,
                shell=True,
                capture_output=True,
                text=True,
                timeout=5,
                **SUBPROCESS_FLAGS
            )
            
            # Parse PIDs and kill them
            current_pid = os.getpid()
            for line in result.stdout.split('\n'):
                if 'ProcessId=' in line:
                    try:
                        pid_str = line.split('=')[1].strip()
                        if pid_str:
                            pid = int(pid_str)
                            # Don't kill ourselves
                            if pid != current_pid and pid > 0:
                                logger.info(f"Killing process {pid} that may be locking files in {dir_name}")
                                subprocess.run(
                                    ['taskkill', '/F', '/PID', str(pid)],
                                    capture_output=True,
                                    timeout=3
                                )
                    except (ValueError, IndexError):
                        pass
        except Exception as e:
            logger.debug(f"Could not find/kill locking processes: {e}")
        
        # Also try to kill any huggingface_hub related processes more aggressively
        try:
            # Kill any python.exe processes (be more aggressive)
            # But only if we're sure they're related to downloads
            time.sleep(0.5)  # Brief delay for handles to release
        except Exception:
            pass
    except Exception as e:
        logger.warning(f"Error killing locking processes: {e}")


def purge_hf_repo_cache(repo_id: str, cache_dir: Optional[Path] = None) -> bool:
    """
    Purge the Hugging Face cache entry for a specific repo_id.
    Used during model repair so corrupted same-size shards are not reused.

    HF cache layout: <cache_base>/models--<namespace>--<repo-name>/ (refs/, blobs/, snapshots/).
    If cache_dir is the app root (e.g. LLM/hf_cache), we check both cache_dir and cache_dir/hub.

    Args:
        repo_id: Hugging Face repo ID (e.g. "unsloth/Llama-3.2-11B-Vision-Instruct-bnb-4bit").
        cache_dir: Optional cache root (e.g. app's hf_cache). If None, uses HF_HUB_CACHE or default.

    Returns:
        True if the entry was purged or did not exist; False if purge failed (best-effort, does not raise).
    """
    import shutil
    import subprocess

    repo_id = (repo_id or "").strip()
    if not repo_id:
        return True

    folder_name = f"models--{repo_id.replace('/', '--')}"

    # Resolve cache base directory
    if cache_dir is not None:
        cache_dir = Path(cache_dir)
        # Check both direct (cache_dir/models--...) and hub subdir (cache_dir/hub/models--...)
        candidates = [
            cache_dir / folder_name,
            cache_dir / "hub" / folder_name,
        ]
    else:
        base = os.environ.get("HF_HUB_CACHE") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")
        candidates = [Path(base) / folder_name]

    entry_path = None
    for c in candidates:
        if c.exists():
            entry_path = c
            break

    if entry_path is None:
        logger.debug(f"HF cache entry not found for {repo_id} (checked {[str(p) for p in candidates]})")
        return True

    logger.info(f"Purging HF cache entry for {repo_id}: {entry_path}")

    try:
        if sys.platform == "win32":
            kill_processes_locking_directory(entry_path)
            time.sleep(1)
            try:
                subprocess.run(
                    ["attrib", "-R", str(entry_path), "/S", "/D"],
                    capture_output=True,
                    timeout=10,
                    **SUBPROCESS_FLAGS
                )
            except Exception:
                pass
            for attempt in range(3):
                try:
                    subprocess.run(
                        ["cmd", "/c", "rmdir", "/S", "/Q", str(entry_path)],
                        capture_output=True,
                        timeout=15,
                        **SUBPROCESS_FLAGS
                    )
                    if not entry_path.exists():
                        logger.info(f"Purged HF cache entry: {folder_name}")
                        return True
                    if attempt >= 1:
                        subprocess.run(
                            ["powershell", "-Command", f'Remove-Item -Path "{entry_path}" -Recurse -Force -ErrorAction SilentlyContinue'],
                            capture_output=True,
                            timeout=15,
                            **SUBPROCESS_FLAGS
                        )
                        if not entry_path.exists():
                            logger.info(f"Purged HF cache entry: {folder_name}")
                            return True
                    time.sleep(1)
                except Exception as e:
                    logger.debug(f"Purge attempt {attempt + 1} failed: {e}")
            try:
                shutil.rmtree(entry_path, ignore_errors=True)
                if not entry_path.exists():
                    logger.info(f"Purged HF cache entry: {folder_name}")
                    return True
            except Exception:
                pass
        else:
            shutil.rmtree(entry_path, ignore_errors=True)
            if not entry_path.exists():
                logger.info(f"Purged HF cache entry: {folder_name}")
                return True
    except Exception as e:
        logger.warning(f"Error purging HF cache for {repo_id}: {e}")

    if entry_path.exists():
        logger.warning(f"Could not fully purge cache entry: {entry_path} (files may be locked)")
        return False
    return True


def force_clean_model_dir(dest_dir: Path) -> bool:
    """
    AGGRESSIVE force-clean: Delete files individually, kill processes, use Windows tools.
    Returns True if directory is gone (even if some files failed to delete).
    """
    import shutil
    import time
    import sys
    import subprocess
    
    dest_dir = Path(dest_dir)
    if not dest_dir.exists():
        return True
    
    logger.info(f"AGGRESSIVE force-cleaning {dest_dir}")
    
    # STEP 1: Kill ALL Python processes that might be locking (nuclear option)
    if sys.platform == "win32":
        try:
            # Kill ALL python.exe and pythonw.exe processes (except ourselves)
            current_pid = os.getpid()
            result = subprocess.run(
                ['wmic', 'process', 'where', 'name="python.exe" or name="pythonw.exe"', 'get', 'ProcessId', '/format:list'],
                capture_output=True,
                text=True,
                timeout=5,
                **SUBPROCESS_FLAGS
            )
            for line in result.stdout.split('\n'):
                if 'ProcessId=' in line:
                    try:
                        pid = int(line.split('=')[1].strip())
                        if pid != current_pid and pid > 0:
                            logger.info(f"Killing Python process {pid}")
                            subprocess.run(['taskkill', '/F', '/PID', str(pid)], capture_output=True, timeout=2, **SUBPROCESS_FLAGS)
                    except (ValueError, IndexError):
                        pass
            time.sleep(2)
        except Exception as e:
            logger.warning(f"Error killing Python processes: {e}")
    
    # STEP 2: Delete files INDIVIDUALLY (even if some fail) - FAST PATH
    deleted_count = 0
    failed_count = 0
    
    # FIRST: Try to delete the whole thing with Windows native (fastest)
    if sys.platform == "win32" and dest_dir.exists():
        try:
            logger.info("Trying fast Windows native delete...")
            result = subprocess.run(
                ['cmd', '/c', 'rmdir', '/S', '/Q', str(dest_dir)], 
                capture_output=True, 
                timeout=15,
                **SUBPROCESS_FLAGS
            )
            if not dest_dir.exists():
                logger.info("✓ Fast delete succeeded!")
                return True
        except Exception as e:
            logger.debug(f"Fast delete failed: {e}")
    
    # If fast delete failed, delete files individually
    try:
        logger.info("Deleting files individually...")
        total_files = sum(len(files) for root, dirs, files in os.walk(dest_dir))
        processed = 0
        
        # Walk directory and delete files one by one
        for root, dirs, files in os.walk(dest_dir, topdown=False):
            # Delete files first
            for file in files:
                file_path = Path(root) / file
                processed += 1
                if processed % 50 == 0:
                    logger.info(f"Deleted {processed}/{total_files} files...")
                
                try:
                    # Try direct delete first (fastest)
                    file_path.unlink()
                    deleted_count += 1
                except Exception:
                    # Try Windows native delete
                    if sys.platform == "win32":
                        try:
                            subprocess.run(['cmd', '/c', 'del', '/F', '/Q', f'"{file_path}"'], 
                                         shell=True, capture_output=True, timeout=1, **SUBPROCESS_FLAGS)
                            deleted_count += 1
                        except Exception:
                            failed_count += 1
            
            # Then delete directories
            for dir_name in dirs:
                dir_path = Path(root) / dir_name
                try:
                    dir_path.rmdir()
                    deleted_count += 1
                except Exception:
                    # Try Windows native
                    if sys.platform == "win32":
                        try:
                            subprocess.run(['cmd', '/c', 'rmdir', '/Q', f'"{dir_path}"'], 
                                         shell=True, capture_output=True, timeout=1, **SUBPROCESS_FLAGS)
                        except Exception:
                            pass
    except Exception as e:
        logger.warning(f"Error during individual file deletion: {e}")
    
    logger.info(f"Deleted {deleted_count} items, {failed_count} failed")
    
    # STEP 3: Try to delete the root directory itself
    if dest_dir.exists():
        # Kill processes again
        kill_processes_locking_directory(dest_dir)
        time.sleep(1)
        
        # Try multiple methods
        methods = [
            lambda: shutil.rmtree(dest_dir, ignore_errors=True),
            lambda: subprocess.run(['cmd', '/c', 'rmdir', '/S', '/Q', str(dest_dir)], 
                                 capture_output=True, timeout=10, **SUBPROCESS_FLAGS) if sys.platform == "win32" else None,
            lambda: subprocess.run(['powershell', '-Command', f'Remove-Item -Path "{dest_dir}" -Recurse -Force -ErrorAction SilentlyContinue'],
                                 capture_output=True, timeout=10, **SUBPROCESS_FLAGS) if sys.platform == "win32" else None,
        ]
        
        for method in methods:
            if method is None:
                continue
            try:
                method()
                if not dest_dir.exists():
                    break
            except Exception:
                pass
    
    # STEP 4: If still exists, try to rename it (sometimes works when delete doesn't)
    if dest_dir.exists() and sys.platform == "win32":
        try:
            import random
            temp_name = dest_dir.parent / f"__DELETE_ME_{random.randint(1000, 9999)}"
            dest_dir.rename(temp_name)
            # Try to delete the renamed folder
            subprocess.run(['cmd', '/c', 'rmdir', '/S', '/Q', str(temp_name)], 
                         capture_output=True, timeout=10, **SUBPROCESS_FLAGS)
        except Exception:
            pass
    
    # Return True if directory is gone (even if we had some failures)
    result = not dest_dir.exists()
    if result:
        logger.info(f"✓ Directory deleted (deleted {deleted_count} items)")
    else:
        logger.warning(f"⚠ Directory still exists after aggressive cleanup ({deleted_count} items deleted, {failed_count} failed)")
    
    return result


def download_repo_files(
    repo_id: str,
    dest_dir: Path,
    token: Optional[str] = None,
    allow_patterns: Optional[List[str]] = None,
    resume: bool = True,
    timeout_s: int = 300,
    max_retries: int = 3,
    progress_callback: Optional[Callable[[int, int], None]] = None,
    status_callback: Optional[Callable[[str, int, int, int], None]] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
    clean_locks: bool = False,
    force_fresh: bool = False,
    cache_dir: Optional[Path] = None
) -> Path:
    """
    Download all files from a Hugging Face repository deterministically, one file at a time.
    
    Args:
        repo_id: Model repository ID
        dest_dir: Destination directory (will be created if missing)
        token: Optional Hugging Face token
        allow_patterns: Optional list of filename patterns to download (e.g., ["*.json", "*.safetensors"])
        resume: If True, skip files that already exist locally
        timeout_s: Per-file download timeout in seconds (unused - kept for compatibility)
        max_retries: Maximum retries per file on failure
        progress_callback: Optional callback(bytes_done, bytes_total) for progress updates
        status_callback: Optional callback(filename, file_idx, total_files, attempt) called before each file download
        should_cancel: Optional callback() -> bool to check if download should be cancelled
        clean_locks: If True, force-clean all lock/incomplete files before starting
        force_fresh: If True, delete everything and redownload from scratch
        cache_dir: Optional central cache directory for HF downloads (keeps locks out of model folders)
        
    Returns:
        Path to destination directory
        
    Raises:
        RuntimeError: If download fails with specific file and reason
    """
    from huggingface_hub import hf_hub_download
    
    if should_cancel and should_cancel():
        raise RuntimeError("Download cancelled")
    
    # Ensure destination exists
    dest_dir = Path(dest_dir)
    
    # Force fresh download: delete everything first
    if force_fresh and dest_dir.exists():
        logger.info(f"Force fresh download: cleaning {dest_dir}")
        if not force_clean_model_dir(dest_dir):
            raise ModelDirLockedError(
                dest_dir,
                f"Cannot clean {dest_dir} - files are locked by another process. "
                "App will restart to clean automatically."
            )
    
    dest_dir.mkdir(parents=True, exist_ok=True)
    
    # Clean up locks if requested (for repair operations)
    if clean_locks:
        # Preserve resumable partials during resume-mode repairs/downloads.
        clean_download_locks(dest_dir, remove_incomplete=(force_fresh or (not resume)))
    
    # Get file list
    siblings = list_repo_files(repo_id, token)
    
    # Filter by patterns if specified
    if allow_patterns:
        import fnmatch
        filtered = []
        for sib in siblings:
            rfilename = sib.get("rfilename", "")
            if any(fnmatch.fnmatch(rfilename, pattern) for pattern in allow_patterns):
                filtered.append(sib)
        siblings = filtered
    
    if not siblings:
        raise RuntimeError(f"No files match patterns {allow_patterns} in {repo_id}")
    
    # Calculate total size (use actual file sizes, not API-reported sizes which can be 0)
    # For progress tracking, we'll track actual downloaded bytes vs estimated total
    total_size = sum(int(s.get("size", 0)) for s in siblings)
    # If total is 0 (all files report 0), estimate based on file count (rough: ~100MB per weight file)
    if total_size == 0 and siblings:
        # Rough estimate: assume weight files are large
        weight_files = [s for s in siblings if any(s.get("rfilename", "").endswith(ext) for ext in [".safetensors", ".bin", ".pt", ".pth"])]
        if weight_files:
            total_size = len(weight_files) * 100 * 1024 * 1024  # Estimate 100MB per weight file
    downloaded_bytes = 0
    
    # Track which files exist locally for resume
    existing_files = set()
    if resume:
        for sib in siblings:
            rfilename = sib.get("rfilename", "")
            local_path = dest_dir / rfilename
            if local_path.exists():
                local_size = local_path.stat().st_size
                remote_size = int(sib.get("size", 0))
                if local_size == remote_size:
                    existing_files.add(rfilename)
                    downloaded_bytes += local_size
                    logger.debug(f"Skipping existing file: {rfilename} ({local_size} bytes)")
    
    # Sort: metadata files first, then by size (smallest first for faster initial progress)
    def _file_priority(sib):
        rfilename = sib.get("rfilename", "")
        if rfilename in existing_files:
            return (2, 0)  # Skip existing
        if any(rfilename.endswith(ext) for ext in [".json", ".txt", ".md", ".model", ".tiktoken"]):
            return (0, int(sib.get("size", 0)))  # Metadata first, then by size
        return (1, int(sib.get("size", 0)))  # Then weights, by size
    
    siblings_sorted = sorted(siblings, key=_file_priority)
    
    # Download each file
    last_file = None
    last_error = None
    
    # Count files that will actually be downloaded (excluding existing ones if resume=True)
    files_to_download = [s for s in siblings_sorted if not (resume and s.get("rfilename", "") in existing_files)]
    total_files = len(files_to_download)
    
    try:
        file_idx = 0
        for idx, sib in enumerate(siblings_sorted):
            if should_cancel and should_cancel():
                raise RuntimeError("Download cancelled")
            rfilename = sib.get("rfilename", "")
            file_size = int(sib.get("size", 0))
            
            # Skip if already exists and resume=True
            if resume and rfilename in existing_files:
                continue
            
            file_idx += 1  # Track position in files_to_download
            last_file = rfilename
            local_path = dest_dir / rfilename
            local_path.parent.mkdir(parents=True, exist_ok=True)
            
            # Retry loop for this file
            for attempt in range(max_retries):
                try:
                    if should_cancel and should_cancel():
                        raise RuntimeError("Download cancelled")
                    
                    # Call status callback before downloading
                    if status_callback:
                        status_callback(rfilename, file_idx, total_files, attempt + 1)
                    
                    logger.info(f"Downloading {rfilename} ({file_size} bytes) - attempt {attempt + 1}/{max_retries}")
                    
                    # Download file (always resumes automatically in newer huggingface_hub)
                    download_kwargs = {
                        "repo_id": repo_id,
                        "filename": rfilename,
                        "local_dir": str(dest_dir),
                        "token": token,
                        "force_download": (not resume),  # Only force new download if resume=False
                    }
                    # Add cache_dir if provided (keeps locks out of model folder)
                    if cache_dir:
                        download_kwargs["cache_dir"] = str(cache_dir)
                    
                    downloaded_path = hf_hub_download(**download_kwargs)
                    
                    # Verify file was written
                    if not Path(downloaded_path).exists():
                        raise RuntimeError(f"File {rfilename} was not written to disk")
                    
                    actual_size = Path(downloaded_path).stat().st_size
                    
                    # Size verification: API sometimes reports 0 for text files that have content
                    # Only verify size if API reported non-zero, or if file is empty when API said 0
                    if file_size > 0:
                        # API reported non-zero size - verify it matches
                        if actual_size != file_size:
                            raise RuntimeError(
                                f"File {rfilename} size mismatch: expected {file_size}, got {actual_size}"
                            )
                    elif file_size == 0 and actual_size == 0:
                        # API said 0, file is 0 - that's fine
                        pass
                    # If API said 0 but file has content, that's also fine (common for README.md, etc.)
                    
                    # Use actual size for progress tracking (more accurate)
                    downloaded_bytes += actual_size if actual_size > 0 else file_size
                    
                    # Update progress
                    if progress_callback:
                        progress_callback(downloaded_bytes, total_size)
                    
                    logger.info(f"✓ Downloaded {rfilename} ({actual_size} bytes)")
                    break  # Success, move to next file
                    
                except Exception as e:
                    last_error = e
                    if attempt < max_retries - 1:
                        wait_time = 2 ** attempt  # Exponential backoff
                        logger.warning(f"Retry {attempt + 1}/{max_retries} for {rfilename} after {wait_time}s: {e}")
                        if should_cancel and should_cancel():
                            raise RuntimeError("Download cancelled") from e
                        time.sleep(wait_time)
                    else:
                        # Final attempt failed
                        error_msg = (
                            f"Failed to download {rfilename} from {repo_id} after {max_retries} attempts. "
                            f"Last error: {e}"
                        )
                        logger.error(error_msg)
                        raise RuntimeError(error_msg) from e
        
        logger.info(f"✓ Successfully downloaded all files to {dest_dir}")
        return dest_dir
        
    except Exception as e:
        # Clean up stale lock files; preserve partial chunks in resume mode.
        logger.warning(f"Download failed, cleaning up lock files in {dest_dir}")
        try:
            cache_dir = dest_dir / ".cache" / "huggingface" / "download"
            if cache_dir.exists():
                # Remove .lock always; remove .incomplete only when not resuming.
                patterns = ["*.lock"]
                if not resume:
                    patterns.append("*.incomplete")
                for pattern in patterns:
                    for lockfile in cache_dir.glob(pattern):
                        try:
                            lockfile.unlink(missing_ok=True)
                            logger.debug(f"Removed {lockfile.name}")
                        except Exception:
                            pass
        except Exception as cleanup_error:
            logger.warning(f"Cleanup failed: {cleanup_error}")
        
        # Write debug info on failure
        debug_path = dest_dir / "download_debug.txt"
        try:
            with open(debug_path, "w", encoding="utf-8") as f:
                f.write(f"Download failed for: {repo_id}\n")
                f.write(f"Destination: {dest_dir}\n")
                f.write(f"Last file attempted: {last_file}\n")
                f.write(f"Error: {str(e)}\n")
                f.write(f"Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
                if last_error:
                    f.write(f"Last error details: {repr(last_error)}\n")
        except Exception:
            pass  # Don't fail on debug write
        
        raise
