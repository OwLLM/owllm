"""
LLM Server Manager
Manages lifecycle of persistent LLM inference servers.
Handles starting, health checking, and monitoring server processes.

PHASE 1 REFACTOR: Uses StateStore for runtime state instead of rewriting YAML.
YAML is now static config only; ports are allocated at runtime and stored in DB.

THREAD SAFETY FIX: Added threading locks to prevent race conditions when
multiple chat threads access the server manager concurrently.
"""
import yaml
import subprocess
import sys
import requests
import time
import socket
import logging
import os
import threading
from pathlib import Path
from typing import Dict, Optional, Tuple, IO

from core.state_store import get_state_store
from core.envs.env_registry import EnvSpec

logger = logging.getLogger(__name__)


class LLMServerManager:
    """Manages persistent LLM inference servers"""
    
    def __init__(self, config_path: Path):
        """
        Initialize server manager.
        
        Args:
            config_path: Path to llm_backends.yaml configuration file (static config only)
        """
        self.config_path = config_path
        
        if not config_path.exists():
            raise FileNotFoundError(f"Config file not found: {config_path}")
        
        self._config_mtime: Optional[float] = None
        self._load_config()
        
        # StateStore for runtime state (PHASE 1: single source of truth)
        self.state_store = get_state_store()
        
        # Import environment registry
        from core.envs.env_registry import EnvRegistry
        self.env_registry = EnvRegistry()
        
        # Windows subprocess flags to prevent CMD window flashing
        self.subprocess_flags = {}
        if sys.platform == 'win32':
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = subprocess.SW_HIDE
            self.subprocess_flags = {
                'startupinfo': startupinfo,
                'creationflags': subprocess.CREATE_NO_WINDOW
            }
        
        # THREAD SAFETY: Lock for all server operations
        # Prevents race conditions when multiple chat threads access manager
        self._server_lock = threading.RLock()
        
        # Track running server processes
        # Tuple: (process, log_file_handle, log_file_path)
        # log_file_handle and log_file_path are None after successful startup
        self.running_servers: Dict[str, Tuple[subprocess.Popen, Optional[IO], Optional[str]]] = {}
        
        # Warmup timeout (seconds to wait for server to become READY).
        # Large models can take a long time on first load (esp. after install / cold cache).
        self.warmup_timeout = 1800
        try:
            self.warmup_timeout = int(os.getenv("LLM_SERVER_WARMUP_TIMEOUT", str(self.warmup_timeout)))
        except Exception:
            self.warmup_timeout = 1800

    def _load_config(self) -> None:
        """(Re)load llm_backends.yaml into self.config if present/valid."""
        if not self.config_path.exists():
            raise FileNotFoundError(f"Config file not found: {self.config_path}")

        with open(self.config_path, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}

        if "models" not in cfg or not isinstance(cfg["models"], dict):
            raise ValueError(f"Invalid config: 'models' key not found in {self.config_path}")

        self.config = cfg
        try:
            self._config_mtime = self.config_path.stat().st_mtime
        except Exception:
            self._config_mtime = None

    def _reload_config_if_changed(self) -> None:
        """
        Reload config if file changed on disk.
        This prevents stale config when users edit llm_backends.yaml while the app is running.
        """
        try:
            mtime = self.config_path.stat().st_mtime
        except Exception:
            return

        if self._config_mtime is None or mtime != self._config_mtime:
            try:
                self._load_config()
                logger.info(f"Reloaded LLM config from disk: {self.config_path}")
            except Exception as e:
                # Keep previous config if reload fails to avoid breaking running servers.
                logger.warning(f"Failed to reload LLM config: {e}")

    def _save_config(self) -> None:
        """
        PHASE 1: DEPRECATED - YAML is now static config only.
        Runtime state (ports, PIDs) is stored in StateStore.
        This method is kept for backward compatibility but does nothing.
        """
        logger.warning("_save_config() called but YAML rewriting is deprecated. Use StateStore instead.")
        # NO-OP: Do not rewrite YAML at runtime

    def _find_free_port(self, start_port: int, used_ports: Optional[set] = None, max_tries: int = 200) -> Optional[int]:
        """Find a free localhost port not in used_ports."""
        used_ports = used_ports or set()
        p = max(1, int(start_port))
        for _ in range(max_tries):
            if p not in used_ports and self._check_port_available(p):
                return p
            p += 1
        return None
    
    def ensure_server_running(self, model_id: str, log_callback=None) -> str:
        """
        Ensure server is running for given model_id, start if needed.
        THREAD SAFE: Uses lock to prevent concurrent starts.
        
        RUNTIME GATE: Only allows models with onboarding status=READY.
        Does NOT create or repair environments (onboarding must be done separately).
        
        Args:
            model_id: Model identifier from config
            log_callback: Optional function to call with log messages
            
        Returns:
            Base URL of the running server
            
        Raises:
            ValueError: If model_id not found in config
            RuntimeError: If model is not READY (onboarding required) or port/server issues
            TimeoutError: If server doesn't become healthy in time
        """
        # THREAD SAFETY: Acquire lock for entire operation
        with self._server_lock:
            def log(msg):
                if log_callback:
                    log_callback(msg)
                logger.info(msg)

            # Always reload before resolving model_id. The file is small and this avoids
            # Windows timestamp resolution / cached config edge cases.
            try:
                self._load_config()
            except Exception as e:
                logger.warning(f"Failed to reload LLM config before start: {e}")

            if model_id not in self.config["models"]:
                raise ValueError(
                    f"Model '{model_id}' not found in config. "
                    f"Available: {list(self.config['models'].keys())}"
                )
            
            # RUNTIME GATE: Check onboarding status
            from core.model_onboarding import get_onboarding_service
            onboarding = get_onboarding_service()
            status = onboarding.get_onboarding_status(model_id)
            
            if status is None:
                raise RuntimeError(
                    f"Model '{model_id}' has not been onboarded. "
                    f"Please run onboarding first (model download/Add model should trigger this)."
                )
            
            if status != "READY":
                entry = self.state_store.get_onboarding(model_id)
                error_msg = entry.get("last_error", "Unknown error") if entry else "Unknown error"
                raise RuntimeError(
                    f"Model '{model_id}' is not ready for runtime (status={status}). "
                    f"Please complete onboarding or repair the model. "
                    f"Error: {error_msg}"
                )
            
            # Check for duplicate ports and warn
            model_cfg = self.config["models"][model_id]
            preferred_port = model_cfg.get("port", 10500)
            duplicate_models = [
                mid for mid, cfg in self.config["models"].items()
                if mid != model_id and isinstance(cfg, dict) and cfg.get("port") == preferred_port
            ]
            if duplicate_models:
                logger.warning(
                    f"WARNING: Model '{model_id}' shares port {preferred_port} with: {', '.join(duplicate_models)}\n"
                    f"This may cause port conflicts. Consider assigning unique ports in llm_backends.yaml"
                )
            
            # Check if already running and healthy
            if model_id in self.running_servers:
                process, _, _ = self.running_servers[model_id]
                if process.poll() is None:  # Process is alive
                    if self._check_health(model_id):
                        log(f"Server '{model_id}' already running and healthy")
                        return self._get_server_url(model_id)
                    else:
                        log(f"Server '{model_id}' process alive but not healthy, restarting")
                        process.kill()
                        del self.running_servers[model_id]
                else:
                    log(f"Server '{model_id}' process died, restarting")
                    del self.running_servers[model_id]
            
            # Start new server
            self._start_server(model_id, log_callback=log_callback)
            return self._get_server_url(model_id)
    
    def _check_port_available(self, port: int) -> bool:
        """
        Check if port is available.
        
        Args:
            port: Port number to check
            
        Returns:
            True if available, False if in use
        """
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(('127.0.0.1', port))
            sock.close()
            return True
        except OSError:
            sock.close()
            return False
    
    def _start_server(self, model_id: str, log_callback=None):
        """
        Start server in correct environment with warmup polling.
        PHASE 1: Uses StateStore for port allocation instead of rewriting YAML.
        
        Args:
            model_id: Model identifier from config
            log_callback: Optional function to call with log messages
            
        Raises:
            RuntimeError: If port is in use or server process dies
            TimeoutError: If server doesn't become healthy in time
        """
        def log(msg):
            if log_callback:
                log_callback(msg)
            logger.info(msg)

        model_cfg = self.config["models"][model_id]
        base_model = model_cfg["base_model"]
        
        # PHASE 1: Get preferred port from YAML (this is the AUTHORITATIVE port assignment)
        preferred_port = model_cfg.get("port", 10500)  # Default if not specified
        port = preferred_port
        port_has_our_server = False  # Flag: if True, skip starting new server and go to warmup loop
        port_needs_reassignment = False  # Flag: if True, skip retries and search for new port immediately
        
        log(f"Starting server for model '{model_id}' on preferred port {port} (from YAML config)")
        
        # CRITICAL: First check if our server is already running on the PREFERRED port
        # This prevents reassigning when server is already active on the correct port
        try:
            url = f"http://127.0.0.1:{port}/health"
            response = requests.get(url, timeout=2)
            if response.status_code == 200:
                data = response.json()
                status = str(data.get("status", "")).lower().strip()
                reported_model = str(data.get("model", "")).strip()
                
                # If this is definitely our model, check if it's healthy before reusing
                if reported_model == model_id:
                    if status == "ok":
                        log(f"Server already running on preferred port {port} (status=ok), reusing it")
                        self.state_store.upsert_server(model_id, None, port, "RUNNING")
                        return
                    elif status == "loading":
                        log(f"Server on preferred port {port} is loading, will wait for it to become ready")
                        # Don't return - continue to warmup polling loop below which will wait
                        # Mark that we found our server so we don't try to start a new one
                        port_has_our_server = True
                    elif status == "error":
                        log(f"Server on preferred port {port} is in error state, attempting to kill and restart")
                        # Try to kill the existing server so we can start fresh
                        try:
                            server_state = self.state_store.get_server(model_id)
                            pid = None
                            if server_state and server_state.get('pid'):
                                pid = server_state.get('pid')
                            
                            if pid:
                                try:
                                    if os.name == 'nt':  # Windows
                                        subprocess.run(['taskkill', '/F', '/PID', str(pid)], 
                                                     capture_output=True, timeout=5)
                                    else:  # Unix
                                        os.kill(pid, 9)
                                    log(f"Killed server process PID {pid}")
                                    time.sleep(2)  # Wait for port to be released
                                except Exception as e:
                                    log(f"Failed to kill process {pid}: {e}")
                            
                            # If still bound, try to find process using netstat
                            if not self._check_port_available(port) and os.name == 'nt':
                                try:
                                    result = subprocess.run(
                                        ['netstat', '-ano'],
                                        capture_output=True,
                                        text=True,
                                        timeout=5
                                    )
                                    for line in result.stdout.split('\n'):
                                        if f':{port}' in line and 'LISTENING' in line:
                                            parts = line.split()
                                            if len(parts) >= 5:
                                                found_pid = parts[-1]
                                                if found_pid.isdigit():
                                                    subprocess.run(['taskkill', '/F', '/PID', found_pid],
                                                                 capture_output=True, timeout=5)
                                                    log(f"Killed process {found_pid} on port {port}")
                                                    time.sleep(2)
                                                    break
                                except Exception:
                                    pass
                        except Exception as e:
                            log(f"Error killing server on port {port}: {e}")
                        
                        # After kill attempt, continue to start new server
                        # Port should be available now (or will be after TIME_WAIT)
                    else:
                        log(f"Server on preferred port {port} has unknown status '{status}', will wait in warmup loop")
                        # Continue to warmup loop
                        port_has_our_server = True
                # If different model is using this port, treat as conflict and allow reassignment
                elif reported_model and reported_model not in {model_id, "local-llm", ""}:
                    log(
                        f"Port {port} is already in use by model '{reported_model}'. "
                        f"Will search for an available port for '{model_id}'."
                    )
                # If server is healthy and reports generic/local-llm, likely our server
                elif status in {"ok", "loading"}:
                    if not reported_model or reported_model in {"local-llm"}:
                        log(f"Server already running on preferred port {port} (status={status}), reusing it")
                        self.state_store.upsert_server(model_id, None, port, "RUNNING")
                        return
                # If server is in error state but responding, wait for it to recover
                elif status == "error":
                    log(f"Server on port {port} reports error status, waiting for recovery...")
                    # Wait up to 30 seconds for server to recover
                    max_wait = 30
                    waited = 0
                    while waited < max_wait:
                        time.sleep(2)
                        waited += 2
                        try:
                            response = requests.get(url, timeout=2)
                            if response.status_code == 200:
                                data = response.json()
                                new_status = str(data.get("status", "")).lower().strip()
                                if new_status == "ok":
                                    log(f"Server recovered on port {port}, reusing it")
                                    self.state_store.upsert_server(model_id, None, port, "RUNNING")
                                    return
                                elif new_status != "error":
                                    # Status changed (e.g., to "loading") - continue waiting
                                    log(f"Server status changed to {new_status}, continuing to wait...")
                        except Exception:
                            pass
                    # Server didn't recover - will restart below
                    log(f"Server on port {port} did not recover from error state, will restart")
        except RuntimeError:
            # Re-raise configuration conflicts
            raise
        except Exception:
            # Health check failed - server not running on preferred port, continue to start
            pass
        
        # Check port availability (with retry for TIME_WAIT state or server still starting)
        max_retries = 5  # Increased retries to handle slow server startup
        for attempt in range(max_retries):
            # First check if port is available to bind
            if self._check_port_available(port):
                log(f"Port {port} is available")
                break
            
            # Port is bound - check if it's our server (might be starting up or in error state)
            # Retry health check in case server is still initializing
            try:
                url = f"http://127.0.0.1:{port}/health"
                response = requests.get(url, timeout=2)
                if response.status_code == 200:
                    data = response.json()
                    status = str(data.get("status", "")).lower().strip()
                    reported_model = str(data.get("model", "")).strip()
                    
                    # Check if this is our server (by model ID match)
                    if reported_model and reported_model == model_id:
                        if status == "ok":
                            # Server is healthy - reuse it
                            log(f"Found our server on port {port} (status=ok), reusing it")
                            self.state_store.upsert_server(model_id, None, port, "RUNNING")
                            return
                        elif status == "loading":
                            # Server is loading - we'll wait for it in warmup loop
                            log(f"Found our server on port {port} (status=loading), will wait for it to become ready")
                            # Continue to warmup polling loop - don't start a new server
                            # Set flag to skip server startup
                            port_has_our_server = True
                            break
                        elif status == "error":
                            # Server is in error state - try to kill it and restart
                            log(f"Found our server on port {port} in error state, attempting to kill and restart")
                            try:
                                # Try to find and kill the process on this port
                                # Get PID from StateStore if available
                                server_state = self.state_store.get_server(model_id)
                                pid = None
                                if server_state and server_state.get('pid'):
                                    pid = server_state.get('pid')
                                
                                # If we have PID, try to kill it
                                if pid:
                                    try:
                                        if os.name == 'nt':  # Windows
                                            subprocess.run(['taskkill', '/F', '/PID', str(pid)], 
                                                         capture_output=True, timeout=5)
                                        else:  # Unix
                                            os.kill(pid, 9)
                                        log(f"Killed server process PID {pid}")
                                        time.sleep(2)  # Wait for port to be released
                                    except Exception as e:
                                        log(f"Failed to kill process {pid}: {e}")
                                
                                # If we don't have PID or kill failed, try to find process on port
                                if self._check_port_available(port):
                                    log(f"Port {port} is now available after killing process")
                                    break  # Port is free, can start new server
                                else:
                                    # Port still bound - try to find process using netstat (Windows)
                                    if os.name == 'nt':
                                        try:
                                            result = subprocess.run(
                                                ['netstat', '-ano'],
                                                capture_output=True,
                                                text=True,
                                                timeout=5
                                            )
                                            for line in result.stdout.split('\n'):
                                                if f':{port}' in line and 'LISTENING' in line:
                                                    parts = line.split()
                                                    if len(parts) >= 5:
                                                        found_pid = parts[-1]
                                                        if found_pid.isdigit():
                                                            subprocess.run(['taskkill', '/F', '/PID', found_pid],
                                                                         capture_output=True, timeout=5)
                                                            log(f"Killed process {found_pid} on port {port}")
                                                            time.sleep(2)
                                                            break
                                        except Exception:
                                            pass
                                    
                                    # Check again if port is available
                                    if self._check_port_available(port):
                                        log(f"Port {port} is now available")
                                        break  # Can start new server
                                    else:
                                        # Port still bound - will continue to retry or error
                                        log(f"Port {port} still bound after kill attempt, will retry")
                            except Exception as e:
                                log(f"Error attempting to kill server on port {port}: {e}")
                                # Continue - will retry or error out
                        else:
                            # Unknown status - wait for it in warmup loop
                            log(f"Found our server on port {port} (status={status}), will wait for it")
                            break
                    elif reported_model and reported_model not in {model_id, "local-llm", ""}:
                        # Different model is using this port - immediately search for new port
                        log(
                            f"Port {port} is already in use by a different model '{reported_model}'. "
                            f"Searching for an available port for '{model_id}'..."
                        )
                        # Break out of retry loop immediately - don't waste time retrying
                        port_needs_reassignment = True
                        break
                    elif status in {"ok", "loading"}:
                        # Server is healthy and reports generic/local-llm - likely our server
                        log(f"Found server on port {port} (status={status}, model={reported_model or 'generic'}), reusing it")
                        self.state_store.upsert_server(model_id, None, port, "RUNNING")
                        return
                    elif status == "error":
                        # Server is in error state but responding - wait for recovery
                        log(f"Server on port {port} reports error status, waiting for recovery...")
                        # Wait up to 30 seconds for server to recover
                        max_wait = 30
                        waited = 0
                        while waited < max_wait:
                            time.sleep(2)
                            waited += 2
                            try:
                                response = requests.get(url, timeout=2)
                                if response.status_code == 200:
                                    data = response.json()
                                    new_status = str(data.get("status", "")).lower().strip()
                                    if new_status == "ok":
                                        log(f"Server recovered on port {port}, reusing it")
                                        self.state_store.upsert_server(model_id, None, port, "RUNNING")
                                        return
                                    elif new_status != "error":
                                        # Status changed (e.g., to "loading") - continue waiting
                                        log(f"Server status changed to {new_status}, continuing to wait...")
                            except Exception:
                                pass
                        # Server didn't recover - need to kill it before starting new server
                        log(f"Server on port {port} did not recover from error state, killing it to restart")
                        try:
                            # Try to kill the process on this port
                            server_state = self.state_store.get_server(model_id)
                            pid = None
                            if server_state and server_state.get('pid'):
                                pid = server_state.get('pid')
                            
                            if pid:
                                try:
                                    if os.name == 'nt':  # Windows
                                        subprocess.run(['taskkill', '/F', '/PID', str(pid)], 
                                                     capture_output=True, timeout=5)
                                    else:  # Unix
                                        os.kill(pid, 9)
                                    log(f"Killed server process PID {pid}")
                                    time.sleep(2)  # Wait for port to be released
                                except Exception as e:
                                    log(f"Failed to kill process {pid}: {e}")
                            
                            # If still bound, try to find process using netstat
                            if not self._check_port_available(port) and os.name == 'nt':
                                try:
                                    result = subprocess.run(
                                        ['netstat', '-ano'],
                                        capture_output=True,
                                        text=True,
                                        timeout=5
                                    )
                                    for line in result.stdout.split('\n'):
                                        if f':{port}' in line and 'LISTENING' in line:
                                            parts = line.split()
                                            if len(parts) >= 5:
                                                found_pid = parts[-1]
                                                if found_pid.isdigit():
                                                    subprocess.run(['taskkill', '/F', '/PID', found_pid],
                                                                 capture_output=True, timeout=5)
                                                    log(f"Killed process {found_pid} on port {port}")
                                                    time.sleep(2)
                                                    break
                                except Exception:
                                    pass
                        except Exception as e:
                            log(f"Error killing server on port {port}: {e}")
                        
                        # Check if port is now available
                        if self._check_port_available(port):
                            log(f"Port {port} is now available, will start new server")
                            break  # Port is free, can start new server
                        else:
                            log(f"Port {port} still bound after kill attempt, will retry in next iteration")
                            # Continue to next retry iteration
            except RuntimeError:
                # Re-raise configuration conflicts
                raise
            except Exception as e:
                # Health check failed - might be starting, wrong server, or not a server at all
                log(f"Health check on port {port} failed: {e}")
                pass
            
            # Port is bound but not our server (or server not responding)
            # If port needs reassignment (different model), skip retries and search immediately
            if port_needs_reassignment:
                break  # Exit retry loop immediately to search for new port
            
            if attempt < max_retries - 1:
                log(f"Port {port} appears in use, retrying health check in 2 seconds... (attempt {attempt + 1}/{max_retries})")
                time.sleep(2)
        
        # If port needs reassignment or retries exhausted, search for available port
        if port_needs_reassignment or (not port_has_our_server and not self._check_port_available(port)):
            log(f"Port {port} is in use by another process, searching for an available port...")
            
            # Collect all ports used by other models in config
            other_model_ports = set()
            for other_model_id, other_cfg in self.config["models"].items():
                if other_model_id != model_id and isinstance(other_cfg, dict):
                    other_port = other_cfg.get("port")
                    if other_port:
                        other_model_ports.add(other_port)
            
            # Also check ports in the standard range (10500-10600)
            candidate_ports = list(other_model_ports) + list(range(10500, 10601))
            
            # Remove the current preferred port from candidates
            if preferred_port in candidate_ports:
                candidate_ports.remove(preferred_port)
            
            # Try each candidate port
            found_port = None
            for candidate_port in candidate_ports:
                if self._check_port_available(candidate_port):
                    # Also check if it's not being used by a healthy server for a different model
                    try:
                        url = f"http://127.0.0.1:{candidate_port}/health"
                        response = requests.get(url, timeout=1)
                        if response.status_code == 200:
                            data = response.json()
                            reported_model = str(data.get("model", "")).strip()
                            # If it's a different model's server, skip this port
                            if reported_model and reported_model != model_id and reported_model not in {"local-llm", ""}:
                                continue
                    except Exception:
                        # Port is not responding to health checks, assume it's free
                        pass
                    
                    found_port = candidate_port
                    log(f"Found available port: {found_port} (was trying {preferred_port})")
                    port = found_port
                    break
            
            if found_port:
                # Update the port and continue
                log(f"Using port {port} instead of preferred port {preferred_port}")
            else:
                # No available port found
                raise RuntimeError(
                    f"Port {preferred_port} (from YAML config) is in use and no alternative ports are available.\n"
                    f"This port is assigned to model '{model_id}' in llm_backends.yaml.\n"
                    f"Checked {len(candidate_ports)} candidate ports (other models' ports and range 10500-10600).\n"
                    f"Please stop processes using ports 10500-10600 or change the port in the config file.\n"
                    f"Use 'netstat -ano | findstr :105' to find processes using these ports."
                )
        
        # If we found our server in loading state, skip starting a new server and go to warmup polling
        if port_has_our_server:
            log(f"Our server is already running on port {port} (in loading state), will wait for it in warmup loop")
            # Continue to warmup polling loop below - don't start a new server
        else:
            # FINAL CHECK: Ensure port is actually available before starting
            if not self._check_port_available(port):
                log(f"WARNING: Port {port} is still bound, attempting to find process and kill it...")
                try:
                    if os.name == 'nt':  # Windows
                        result = subprocess.run(
                            ['netstat', '-ano'],
                            capture_output=True,
                            text=True,
                            timeout=5
                        )
                        for line in result.stdout.split('\n'):
                            if f':{port}' in line and 'LISTENING' in line:
                                parts = line.split()
                                if len(parts) >= 5:
                                    found_pid = parts[-1]
                                    if found_pid.isdigit():
                                        subprocess.run(['taskkill', '/F', '/PID', found_pid],
                                                     capture_output=True, timeout=5)
                                        log(f"Killed process {found_pid} on port {port}")
                                        time.sleep(2)  # Wait for port release
                                        break
                except Exception as e:
                    log(f"Failed to kill process on port {port}: {e}")
                    # Continue anyway - will fail with clear error if port still bound
            
            # Validate model files exist before starting server
            # Use base_model field (YAML uses base_model, not path)
            model_path_str = model_cfg.get("base_model", "")
            if not model_path_str:
                raise RuntimeError(
                    f"Model path (base_model) not specified in config for '{model_id}'\n"
                    f"Please check the base_model field in llm_backends.yaml"
                )
            
            model_path = Path(model_path_str)
            if not model_path.exists():
                raise RuntimeError(
                    f"Model path does not exist: {model_path}\n"
                    f"Please check the model path in llm_backends.yaml"
                )
            
            # Check for common model file patterns
            model_files = list(model_path.glob("*.safetensors")) + list(model_path.glob("*.bin"))
            if not model_files:
                raise RuntimeError(
                    f"No model files found in {model_path}\n"
                    f"Expected .safetensors or .bin files. The model may not be downloaded correctly."
                )
            
            log(f"Found {len(model_files)} model files, starting server...")
            
            # Get environment for this model
            # RUNTIME: Use existing env only (no creation/repair in runtime path)
            log(f"Getting environment for model: {base_model}")
            
            # Get onboarding entry to find env_key
            onboarding_entry = self.state_store.get_onboarding(model_id)
            if not onboarding_entry:
                raise RuntimeError(
                    f"Model '{model_id}' onboarding entry not found. "
                    f"Please run onboarding first."
                )
            
            env_key = onboarding_entry.get("env_key")
            if not env_key:
                raise RuntimeError(
                    f"Model '{model_id}' has no env_key in onboarding entry. "
                    f"Please re-run onboarding."
                )
            
            # Get env spec (should already exist from onboarding)
            python_exe = self.env_registry._get_env_python_executable(env_key)
            if not python_exe or not python_exe.exists():
                raise RuntimeError(
                    f"Environment '{env_key}' for model '{model_id}' not found. "
                    f"Please re-run onboarding."
                )
            
            env_spec = EnvSpec(
                key=env_key,
                python_executable=python_exe,
                metadata={"env_key": env_key, "status": "READY", "source": "onboarded"}
            )
            log(f"Using environment: {env_spec.key}")
            log(f"Python executable: {env_spec.python_executable}")
            
            # ENVIRONMENT-FIRST: Comprehensive validation and repair BEFORE model load
            log("Validating environment dependencies (environment-first approach)...")
            
            # Check for critical packages required for ALL models
            critical_packages = ["protobuf", "transformers", "tokenizers", "torch", "peft", "accelerate"]
            missing_packages = self.env_registry.check_missing_packages(
                env_spec.python_executable, 
                required_packages=critical_packages
            )
            
            if missing_packages:
                log(f"Missing critical packages detected: {', '.join(missing_packages)}")
                log("Auto-installing missing packages (this ensures environment is ready)...")
                if not self.env_registry.auto_install_missing_packages(
                    env_spec.python_executable, 
                    missing_packages, 
                    log_callback=log_callback
                ):
                    raise RuntimeError(
                        f"Environment validation failed: Could not auto-install required packages: {', '.join(missing_packages)}\n"
                        f"This indicates the environment is not properly configured.\n"
                        f"Please go to the Environment/Requirements tab and run 'Repair Environment' for {env_spec.key}."
                    )
                log("Missing packages installed successfully, re-validating...")
                # Re-check after installation
                still_missing = self.env_registry.check_missing_packages(
                    env_spec.python_executable,
                    required_packages=missing_packages
                )
                if still_missing:
                    raise RuntimeError(
                        f"Environment repair incomplete: Packages still missing after installation: {', '.join(still_missing)}\n"
                        f"Please manually repair the environment: {env_spec.key}"
                    )
                log("Environment dependencies validated - all critical packages present")
            else:
                log("Environment dependencies validated - all critical packages present")
            
            # Additional health check: verify environment can actually import and use transformers
            log("Running environment health check...")
            try:
                import subprocess
                health_code = """
import transformers
import tokenizers
import torch
import peft
import accelerate
print('OK')
"""
                result = subprocess.run(
                    [str(env_spec.python_executable), "-c", health_code],
                    capture_output=True,
                    text=True,
                    timeout=30,
                    **self.subprocess_flags
                )
                if result.returncode != 0 or "OK" not in result.stdout:
                    log(f"Environment health check failed. Output: {result.stdout[:200]}")
                    raise RuntimeError(
                        f"Environment {env_spec.key} failed health check.\n"
                        f"Environment may be corrupted. Please repair it in the Environment/Requirements tab."
                    )
                log("Environment health check passed")
            except Exception as e:
                log(f"Environment health check error: {e}")
                raise RuntimeError(
                    f"Environment {env_spec.key} health check failed: {e}\n"
                    f"Please repair the environment before attempting to load models."
                )
            
            # Get app root for cwd
            from core.inference import get_app_root
            app_root = get_app_root()
            
            # Construct launcher script path
            launcher_script = app_root / "scripts" / "llm_server_start.py"
            
            if not launcher_script.exists():
                raise FileNotFoundError(f"Launcher script not found: {launcher_script}")
            
            # Launch server using environment's python
            log(f"Launching server: {env_spec.python_executable} {launcher_script} {model_id}")
            log(f"Working directory: {app_root}")
            
            # PHASE 1: Record server starting in StateStore
            from datetime import datetime
            self.state_store.upsert_server(
                model_id=model_id,
                pid=None,  # Will update after process starts
                port=port,
                status="STARTING",
                started_at=datetime.utcnow().isoformat()
            )
            
            # Create log directory and file for startup capture
            log_dir = app_root / "logs" / "server_startup"
            log_dir.mkdir(parents=True, exist_ok=True)
            
            # Generate log file path with timestamp
            timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
            safe_model_id = model_id.replace("/", "__").replace("\\", "__")
            log_path = log_dir / f"{safe_model_id}_{timestamp}.log"
            
            # Open log file for writing (will be closed after startup completes or fails)
            log_file = open(log_path, 'w', encoding='utf-8', errors='replace')
            
            # Prepare Windows subprocess flags to hide CMD window
            # CRITICAL: Pass port via environment variable so auto-reassignment works
            env = os.environ.copy()
            env['SERVER_PORT'] = str(port)
            subprocess_kwargs = {
                'cwd': str(app_root),
                # Capture output to log file during startup for debugging
                # After successful startup, we'll close the file and switch to DEVNULL
                'stdout': log_file,
                'stderr': subprocess.STDOUT,  # Merge stderr into stdout
                'text': True,
                'encoding': 'utf-8',
                'errors': 'replace',
                'env': env
            }
            
            # Windows-specific: Hide CMD window and prevent blocking
            if os.name == 'nt':  # Windows
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startupinfo.wShowWindow = subprocess.SW_HIDE
                subprocess_kwargs['startupinfo'] = startupinfo
                subprocess_kwargs['creationflags'] = subprocess.CREATE_NO_WINDOW
            
            try:
                process = subprocess.Popen(
                    [str(env_spec.python_executable), 
                     str(launcher_script), 
                     model_id],
                    **subprocess_kwargs
                )
                # Store process with log file handle and path
                self.running_servers[model_id] = (process, log_file, str(log_path))
                log(f"Server process started with PID: {process.pid}")
                log(f"Startup logs being captured to: {log_path}")
                
                # PHASE 1: Update StateStore with PID
                self.state_store.upsert_server(
                    model_id=model_id,
                    pid=process.pid,
                    port=port,
                    status="STARTING"
                )
            except Exception as e:
                import traceback
                error_msg = f"Failed to launch server process: {e}\n{traceback.format_exc()}"
                logger.error(error_msg)
                # PHASE 1: Record failure in StateStore
                self.state_store.upsert_server(
                    model_id=model_id,
                    pid=None,
                    port=port,
                    status="FAILED",
                    last_error=error_msg[:500]
                )
                raise RuntimeError(error_msg)
        
        # Warmup: poll /health with timeout
        # Use the actual port (may have been reassigned)
        server_url = f"http://127.0.0.1:{port}"
        start_time = time.time()
        last_error = None
        last_progress_update = 0  # Track last progress update time
        
        log(f"Waiting for server to become healthy (timeout: {self.warmup_timeout}s)...")
        log(f"This involves loading the model into GPU memory. Please wait...")
        
        while time.time() - start_time < self.warmup_timeout:
            elapsed = time.time() - start_time
            
            # Progress update every 10 seconds
            if elapsed - last_progress_update >= 10:
                remaining = self.warmup_timeout - elapsed
                log(f"Still waiting for server... ({int(elapsed)}s elapsed, {int(remaining)}s remaining)")
                last_progress_update = elapsed
            
            # Check server logs for errors (every 30 seconds)
            if elapsed >= 30 and elapsed % 30 < 2:  # Check roughly every 30 seconds
                if model_id in self.running_servers:
                    _, log_file_handle, log_file_path = self.running_servers[model_id]
                    if log_file_path and os.path.exists(log_file_path):
                        try:
                            with open(log_file_path, 'r', encoding='utf-8', errors='replace') as f:
                                # Read last 200 lines to capture full tracebacks
                                lines = f.readlines()[-200:]
                                log_text = "".join(lines)
                                
                                # Check for common error patterns
                                if "FileNotFoundError" in log_text or "No such file" in log_text:
                                    # Extract model path from error
                                    import re
                                    match = re.search(r'No such file.*?([^\s]+\.safetensors)', log_text)
                                    if match:
                                        missing_file = match.group(1)
                                        raise RuntimeError(
                                            f"Model file missing: {missing_file}\n"
                                            f"The model download may be incomplete. Please re-download the model."
                                        )
                                elif "error" in log_text.lower() and "traceback" in log_text.lower():
                                    # Extract full error message - look for specific error types
                                    import re
                                    
                                    # First, try to extract the full traceback to find the ROOT CAUSE exception
                                    # Look for the most recent traceback block
                                    traceback_match = re.search(
                                        r'(Traceback\s+\(most recent call last\):.*?)(?=\n\S|\Z)',
                                        log_text,
                                        re.DOTALL
                                    )
                                    if traceback_match:
                                        full_traceback = traceback_match.group(1)
                                        # Extract the actual exception from the traceback (last line)
                                        exception_lines = [l.strip() for l in full_traceback.split('\n') if l.strip() and not l.strip().startswith('File') and not l.strip().startswith('Traceback')]
                                        if exception_lines:
                                            root_exception = exception_lines[-1]  # Last non-empty line is usually the exception
                                            # If we found a root exception that's not our RuntimeError, include it
                                            if 'RuntimeError:' not in root_exception or 'AutoTokenizer.from_pretrained() returned invalid value' not in root_exception:
                                                # This is the actual exception - include full traceback in error
                                                log(f"Root cause exception found in traceback: {root_exception}")
                                    
                                    # Try to extract RuntimeError with full multi-line message
                                    # When RuntimeError is raised with a multi-line string, it may appear in logs as:
                                    # 1. Single line with \n characters: "RuntimeError: line1\nline2\nline3"
                                    # 2. Multiple lines: "RuntimeError: line1\n    line2\n    line3"
                                    # 3. In traceback format with indentation
                                    
                                    # Pattern: Look for RuntimeError and capture until next traceback element, log level, or end
                                    # Stop at: File ", Traceback, INFO:, DEBUG:, WARNING:, ERROR: (new error), or Exception:
                                    runtime_error_match = re.search(
                                        r'RuntimeError:\s*((?:[^\n]|\n(?!\s*(?:File\s|Traceback|INFO:|DEBUG:|WARNING:|ERROR:|Exception:|\w+Error:)))+)', 
                                        log_text, 
                                        re.MULTILINE
                                    )
                                    if runtime_error_match:
                                        error_msg = runtime_error_match.group(1).strip()
                                        # Replace literal \n with actual newlines
                                        error_msg = error_msg.replace('\\n', '\n')
                                        
                                        # Filter out any log level lines that might have been captured
                                        # Remove lines that start with INFO:, DEBUG:, WARNING:, ERROR: (but not our error message)
                                        filtered_lines = []
                                        for line in error_msg.split('\n'):
                                            stripped = line.strip()
                                            # Skip log level lines and uvicorn access logs
                                            if (stripped.startswith('INFO:') or 
                                                stripped.startswith('DEBUG:') or 
                                                stripped.startswith('WARNING:') or
                                                stripped.startswith('ERROR:') or
                                                'GET /health HTTP/1.1' in stripped or
                                                'POST /' in stripped):
                                                continue
                                            if stripped:  # Keep non-empty lines
                                                filtered_lines.append(stripped)
                                        
                                        error_msg = '\n'.join(filtered_lines)
                                        
                                        # If message seems truncated, try to get more context (but stop at log levels)
                                        if len(error_msg) < 100 and not error_msg.endswith('.'):
                                            error_start_idx = log_text.find('RuntimeError:')
                                            if error_start_idx >= 0:
                                                # Get next 20 lines after RuntimeError for context
                                                remaining_log = log_text[error_start_idx:]
                                                context_lines = remaining_log.split('\n')[:20]
                                                # Look for lines that look like error message continuation
                                                continuation = []
                                                for line in context_lines[1:]:  # Skip the RuntimeError line itself
                                                    stripped = line.strip()
                                                    # Stop if we hit a traceback line, log level, or another error
                                                    if (any(x in stripped for x in ['File "', 'Traceback', 'Error:', 'Exception:']) or
                                                        stripped.startswith('INFO:') or
                                                        stripped.startswith('DEBUG:') or
                                                        'GET /health' in stripped or
                                                        'POST /' in stripped):
                                                        break
                                                    # Include lines that look like error message (not code/file paths)
                                                    if stripped and not stripped.startswith('File ') and len(stripped) > 10:
                                                        continuation.append(stripped)
                                                if continuation:
                                                    error_msg = error_msg + '\n' + '\n'.join(continuation[:5])  # Limit to 5 more lines
                                        
                                        # Include root exception if we found one
                                        if traceback_match and 'root_exception' in locals() and root_exception:
                                            error_msg = f"{root_exception}\n\n{error_msg}"
                                        
                                        raise RuntimeError(
                                            f"Server error detected in logs:\n{error_msg}"
                                        )
                                    
                                    # Try to extract ImportError with full message
                                    import_error_match = re.search(r'ImportError:\s*(.+?)(?:\n|$)', log_text, re.MULTILINE | re.DOTALL)
                                    if import_error_match:
                                        error_msg = import_error_match.group(1).strip()
                                        # Check if it's protobuf or other missing dependency - auto-install it
                                        if "protobuf" in error_msg.lower():
                                            log("Detected missing protobuf dependency, installing automatically...")
                                            try:
                                                # Get the environment for this model
                                                env_spec = self.env_registry.get_env_for_model(base_model, log_callback=log_callback)
                                                python_exe = env_spec.python_executable
                                                
                                                # Install protobuf using the registry's auto-install method
                                                log(f"Installing protobuf in {env_spec.key}...")
                                                if self.env_registry.auto_install_missing_packages(
                                                    python_exe, 
                                                    ["protobuf"], 
                                                    log_callback=log_callback
                                                ):
                                                    log("protobuf installed successfully, restarting server...")
                                                    # Kill the failed server process and restart
                                                    if model_id in self.running_servers:
                                                        process, log_file, _ = self.running_servers[model_id]
                                                        try:
                                                            process.kill()
                                                            process.wait(timeout=5)
                                                        except Exception:
                                                            pass
                                                        if log_file:
                                                            log_file.close()
                                                        del self.running_servers[model_id]
                                                    # Restart server with protobuf now installed
                                                    time.sleep(2)  # Brief wait for port release
                                                    # Recursively call _start_server to restart
                                                    return self._start_server(model_id, log_callback=log_callback)
                                                else:
                                                    raise RuntimeError(
                                                        f"Failed to auto-install protobuf in environment {env_spec.key}.\n"
                                                        f"Please go to the Environment/Requirements tab and run 'Repair Environment' for this model's environment."
                                                    )
                                            except RuntimeError:
                                                raise  # Re-raise RuntimeError as-is
                                            except Exception as e:
                                                raise RuntimeError(
                                                    f"Error during protobuf auto-installation: {e}\n"
                                                    f"Please go to the Environment/Requirements tab and run 'Repair Environment'."
                                                )
                                        else:
                                            # Generic ImportError - provide helpful context
                                            raise RuntimeError(
                                                f"ImportError in server: {error_msg[:500]}\n"
                                                f"This usually indicates a missing Python package in the model's environment.\n"
                                                f"Please check the server logs for the full error and install the missing package,\n"
                                                f"or go to the Environment/Requirements tab and run 'Repair Environment'."
                                            )
                                    
                                    # Fallback: extract any error line (but try to get more context)
                                    error_lines = [l.strip() for l in lines if ("Error" in l or "Exception" in l) and l.strip()]
                                    if error_lines:
                                        # Get the last meaningful error line (skip empty or very short ones)
                                        meaningful_errors = [e for e in error_lines if len(e) > 10]
                                        if meaningful_errors:
                                            # Try to get the error line plus a few lines of context after it
                                            last_error_idx = None
                                            for i, line in enumerate(lines):
                                                if meaningful_errors[-1] in line:
                                                    last_error_idx = i
                                                    break
                                            if last_error_idx is not None:
                                                # Get error line plus next 3 lines for context
                                                context_lines = lines[last_error_idx:last_error_idx+4]
                                                context = '\n'.join(l.strip() for l in context_lines if l.strip())
                                                raise RuntimeError(
                                                    f"Server error detected in logs:\n{context}"
                                                )
                                            else:
                                                raise RuntimeError(
                                                    f"Server error detected in logs:\n{meaningful_errors[-1]}"
                                                )
                        except RuntimeError:
                            raise  # Re-raise RuntimeError
                        except Exception:
                            pass  # Ignore log reading errors
            
            # Check if process died (only if we started a new process)
            if not port_has_our_server:
                if model_id not in self.running_servers:
                    # Process was never started or was cleaned up
                    break
                process, _, _ = self.running_servers[model_id]
                if process.poll() is not None:
                    # Process died - read log file for error details
                    log_output = ""
                    if model_id in self.running_servers:
                        _, log_file_handle, log_file_path = self.running_servers[model_id]
                        
                        # Close and flush log file
                        try:
                            if log_file_handle:
                                log_file_handle.flush()
                                log_file_handle.close()
                        except Exception:
                            pass
                        
                        # Read log file contents (last 2000 lines or 100KB)
                        try:
                            if log_file_path and os.path.exists(log_file_path):
                                with open(log_file_path, 'r', encoding='utf-8', errors='replace') as f:
                                    lines = f.readlines()
                                    # Get last 2000 lines or all if less
                                    if len(lines) > 2000:
                                        lines = lines[-2000:]
                                    log_output = "".join(lines)
                                    
                                    # Limit to 100KB to avoid huge error messages
                                    if len(log_output) > 100000:
                                        log_output = "... (truncated) ...\n" + log_output[-100000:]
                        except Exception as e:
                            log_output = f"(Failed to read log file: {e})"
                        
                        # Clean up
                        del self.running_servers[model_id]
                        
                        # Delete log file after reading
                        try:
                            if log_file_path and os.path.exists(log_file_path):
                                os.remove(log_file_path)
                        except Exception:
                            pass
                    
                    # PHASE 1: Record failure in StateStore
                    self.state_store.upsert_server(
                        model_id=model_id,
                        pid=process.pid,
                        port=port,
                        status="FAILED",
                        stopped_at=datetime.utcnow().isoformat(),
                        last_error=f"Process died during startup (exit code {process.returncode})"
                    )
                    
                    # Get environment info if available
                    env_info = "unknown"
                    script_info = "unknown"
                    try:
                        from core.inference import get_app_root
                        app_root = get_app_root()
                        launcher_script = app_root / "scripts" / "llm_server_start.py"
                        script_info = str(launcher_script)
                        env_spec = self.env_registry.get_env_for_model(base_model, log_callback=None)
                        env_info = str(env_spec.python_executable)
                    except Exception:
                        pass
                    
                    error_msg = (
                        f"Server process for '{model_id}' died during startup.\n"
                        f"Exit code: {process.returncode}\n"
                        f"Port: {port}\n"
                        f"Python: {env_info}\n"
                        f"Script: {script_info}\n"
                        f"\nServer output:\n{log_output if log_output else '(no output captured)'}"
                    )
                    logger.error(error_msg)
                    raise RuntimeError(error_msg)
            
            # Try health check (server may be up while model is still loading)
            try:
                response = requests.get(f"{server_url}/health", timeout=2)
                if response.status_code == 200:
                    try:
                        data = response.json()
                        status = str(data.get("status", "")).lower()
                        
                        # Check for error status
                        if status == "error":
                            error_msg = data.get("error", "Unknown error")
                            log(f"Server reports error status: {error_msg}")
                            # Get model path for error message
                            model_path = model_cfg.get("base_model", "unknown")
                            raise RuntimeError(
                                f"Server failed to load model: {error_msg}\n"
                                f"Check model files are complete in: {model_path}"
                            )
                        
                        if status == "ok":
                            elapsed = time.time() - start_time
                            logger.info(f"Server '{model_id}' is ready at {server_url} (took {elapsed:.1f}s)")
                            
                            # Close and clean up log file after successful startup
                            if model_id in self.running_servers:
                                _, log_file_handle, log_file_path = self.running_servers[model_id]
                                try:
                                    if log_file_handle:
                                        log_file_handle.flush()
                                        log_file_handle.close()
                                except Exception:
                                    pass
                                
                                # Delete log file (no longer needed after successful startup)
                                try:
                                    if log_file_path and os.path.exists(log_file_path):
                                        os.remove(log_file_path)
                                except Exception:
                                    pass
                                
                                # Update to remove log file references (keep only process)
                                self.running_servers[model_id] = (process, None, None)
                            
                            # PHASE 1: Record success in StateStore
                            self.state_store.upsert_server(
                                model_id=model_id,
                                pid=process.pid,
                                port=port,
                                status="RUNNING"
                            )
                            return
                        # Still loading; keep waiting
                        last_error = f"Server up, model status={status}"
                    except Exception:
                        # If JSON parsing fails, assume not ready yet.
                        last_error = "Server up, invalid /health JSON"
            except requests.exceptions.RequestException as e:
                last_error = str(e)
            except Exception as e:
                last_error = str(e)
            
            time.sleep(2)
        
        # Timeout reached - kill process and raise error
        logger.error(f"Server '{model_id}' failed to become healthy within {self.warmup_timeout}s")
        
        # Check if server is still in "loading" state
        server_status = "unknown"
        try:
            response = requests.get(f"{server_url}/health", timeout=2)
            if response.status_code == 200:
                data = response.json()
                server_status = str(data.get("status", "")).lower()
        except Exception:
            server_status = "not responding"
        
        # Read log file for error details
        log_output = ""
        log_path = None
        if model_id in self.running_servers:
            _, log_file_handle, log_file_path = self.running_servers[model_id]
            log_path = log_file_path
            
            # Close and flush log file
            try:
                if log_file_handle:
                    log_file_handle.flush()
                    log_file_handle.close()
            except Exception:
                pass
            
            # Read log file contents (last 2000 lines or 100KB)
            try:
                if log_file_path and os.path.exists(log_file_path):
                    with open(log_file_path, 'r', encoding='utf-8', errors='replace') as f:
                        lines = f.readlines()
                        # Get last 2000 lines or all if less
                        if len(lines) > 2000:
                            lines = lines[-2000:]
                        log_output = "".join(lines)
                        
                        # Limit to 100KB to avoid huge error messages
                        if len(log_output) > 100000:
                            log_output = "... (truncated) ...\n" + log_output[-100000:]
            except Exception as e:
                log_output = f"(Failed to read log file: {e})"
        
        # Kill process (only if we started a new process)
        if not port_has_our_server and model_id in self.running_servers:
            process, _, _ = self.running_servers[model_id]
            try:
                process.kill()
                process.wait(timeout=5)
            except Exception:
                pass
        
        # Clean up
        if model_id in self.running_servers:
            del self.running_servers[model_id]
            
            # Delete log file after reading
            try:
                if log_file_path and os.path.exists(log_file_path):
                    os.remove(log_file_path)
            except Exception:
                pass
        
        # Build error message
        if log_output:
            output_text = log_output
        else:
            output_text = "(no output captured - process may have failed to start)"
        
        # Build error message based on server status
        if server_status == "loading":
            model_path_str = model_cfg.get("base_model", "unknown")
            error_msg = (
                f"Server stuck in 'loading' state for {self.warmup_timeout}s.\n"
                f"This usually means:\n"
                f"  1. Model files are missing or incomplete\n"
                f"  2. GPU memory is insufficient\n"
                f"  3. Model loading encountered an error\n\n"
                f"Check server logs at: {log_path if log_path else 'N/A'}\n"
                f"Model path: {model_path_str}\n"
                f"Port: {port}\n"
                f"Last health check error: {last_error or 'Connection refused'}\n"
                f"\nServer output:\n{output_text}"
            )
        else:
            error_msg = (
                f"Server '{model_id}' failed to become healthy within {self.warmup_timeout}s.\n"
                f"Port: {port}\n"
                f"Server status: {server_status}\n"
                f"Last health check error: {last_error or 'Connection refused'}\n"
                f"\nServer output:\n{output_text}"
            )
        logger.error(error_msg)
        raise TimeoutError(error_msg)
    
    def _check_health(self, model_id: str, return_status: bool = False):
        """
        Check if server is healthy.
        
        Args:
            model_id: Model identifier
            return_status: If True, return (status, model_name) or (False, None) on failure.
            
        Returns:
            True if ready/ok, False otherwise (default behavior).
        """
        try:
            url = self._get_server_url(model_id)
            response = requests.get(f"{url}/health", timeout=2)
            if response.status_code != 200:
                return False if not return_status else (False, None)
            try:
                data = response.json()
            except Exception:
                # A 200 without JSON is not our API; treat as not healthy.
                return False if not return_status else ("unknown", None)

            status = str(data.get("status", "")).lower().strip()
            model_name = str(data.get("model", "")).strip() if isinstance(data, dict) else ""
            if return_status:
                return (status or "unknown", model_name or None)
            return status == "ok"
        except Exception:
            return False if not return_status else (False, None)
    
    def _get_server_url(self, model_id: str) -> str:
        """
        Get base URL for model server.
        PHASE 1: Checks StateStore first, falls back to YAML.
        
        Args:
            model_id: Model identifier
            
        Returns:
            Base URL (e.g., "http://127.0.0.1:9100")
        """
        # PHASE 1: Check StateStore for runtime port first
        server_state = self.state_store.get_server(model_id)
        if server_state:
            port = server_state['port']
        else:
            # Fallback to YAML port
            port = self.config["models"][model_id].get("port", 10500)
        return f"http://127.0.0.1:{port}"
    
    def shutdown_server(self, model_id: str):
        """
        Shutdown server for given model.
        THREAD SAFE: Uses lock to prevent concurrent shutdown.
        
        Args:
            model_id: Model identifier
        """
        # THREAD SAFETY: Acquire lock for shutdown operation
        with self._server_lock:
            if model_id in self.running_servers:
                process, log_file_handle, log_file_path = self.running_servers[model_id]
                
                # Close log file if still open
                try:
                    if log_file_handle:
                        log_file_handle.flush()
                        log_file_handle.close()
                except Exception:
                    pass
                
                logger.info(f"Shutting down server '{model_id}'")
                
                # Graceful shutdown with timeout
                if process.poll() is None:  # Process is still running
                    process.terminate()
                    try:
                        process.wait(timeout=2)  # Wait 2 seconds for graceful shutdown
                        logger.info(f"Server '{model_id}' terminated gracefully")
                    except subprocess.TimeoutExpired:
                        # Force kill if graceful shutdown failed
                        logger.warning(f"Server '{model_id}' didn't terminate gracefully within 2s, force killing")
                        try:
                            process.kill()
                            process.wait(timeout=1)  # Wait briefly for kill to complete
                            logger.info(f"Server '{model_id}' force killed")
                        except subprocess.TimeoutExpired:
                            logger.error(f"Server '{model_id}' could not be killed")
                        except Exception as e:
                            logger.error(f"Error killing server '{model_id}': {e}")
                
                # Delete log file if it exists
                try:
                    if log_file_path and os.path.exists(log_file_path):
                        os.remove(log_file_path)
                except Exception:
                    pass
                
                del self.running_servers[model_id]
                
                # PHASE 1: Update StateStore
                from datetime import datetime
                self.state_store.upsert_server(
                    model_id=model_id,
                    pid=None,
                    port=0,  # Mark as stopped
                    status="STOPPED",
                    stopped_at=datetime.utcnow().isoformat()
                )
    
    def shutdown_all(self):
        """Shutdown all running servers"""
        if not self.running_servers:
            logger.info("No servers to shutdown")
            return
        
        logger.info(f"Shutting down all {len(self.running_servers)} running servers")
        model_ids = list(self.running_servers.keys())
        for model_id in model_ids:
            try:
                self.shutdown_server(model_id)
            except Exception as e:
                logger.error(f"Error shutting down server '{model_id}': {e}")
        logger.info("All servers shutdown complete")

# Global instance with thread-safe singleton pattern
_global_manager: Optional[LLMServerManager] = None
_manager_lock = threading.Lock()


def get_global_server_manager() -> LLMServerManager:
    """
    Get or create global server manager instance.
    THREAD SAFE: Uses double-checked locking pattern.
    
    Returns:
        Global LLMServerManager instance
    """
    global _global_manager
    
    # Fast path: manager already exists
    if _global_manager is not None:
        return _global_manager
    
    # Slow path: need to create manager with lock
    with _manager_lock:
        # Double-check inside lock (another thread may have created it)
        if _global_manager is None:
            from core.inference import get_app_root
            config_path = get_app_root() / "configs" / "llm_backends.yaml"
            _global_manager = LLMServerManager(config_path)
        
        return _global_manager
