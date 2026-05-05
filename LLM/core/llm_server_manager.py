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
import re
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Optional, Tuple, IO

from core.state_store import get_state_store
from core.envs.env_registry import EnvSpec
from core.model_id_resolver import to_canonical_id, resolve_onboarding_identity
from core.envs.capability_matrix import classify_runtime_failure, get_runtime_fallback_packages
from model_integrity_checker import ModelIntegrityChecker

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
        
        # Do not hide child console windows.
        self.subprocess_flags = {}
        
        # THREAD SAFETY: Lock for all server operations
        # Prevents race conditions when multiple chat threads access manager
        self._server_lock = threading.RLock()
        
        # Startup integrity check (read-only report + safe repairs)
        self._integrity_report: Optional[Dict] = None
        try:
            self._integrity_report = self.state_store.run_integrity_checks(
                env_root=getattr(self.env_registry, "envs_dir", None),
                repair_safe=True,
            )
            errs = self._integrity_report.get("errors", [])
            dup = self._integrity_report.get("duplicate_onboarding", [])
            missing = self._integrity_report.get("missing_env_for_ready", [])
            if errs or dup or missing:
                logger.warning(
                    "Integrity report: errors=%s, duplicate_onboarding=%s, missing_env_for_ready=%s",
                    len(errs), len(dup), len(missing),
                )
            if self._integrity_report.get("repaired"):
                logger.info("Integrity repairs applied: %s", self._integrity_report["repaired"])
        except Exception as e:
            logger.debug("Startup integrity check skipped or failed: %s", e)
            self._integrity_report = {}
        
        # Track running server processes
        # Tuple: (process, log_file_handle, log_file_path)
        # log_file_handle and log_file_path are None after successful startup
        self.running_servers: Dict[str, Tuple[subprocess.Popen, Optional[IO], Optional[str]]] = {}
        
        # Warmup timeout (seconds to wait for server to become READY).
        # Keep a bounded default so chat does not appear frozen for very long.
        self.warmup_timeout = 300
        try:
            self.warmup_timeout = int(os.getenv("LLM_SERVER_WARMUP_TIMEOUT", str(self.warmup_timeout)))
        except Exception:
            self.warmup_timeout = 300

        # Existing STARTING-row watchdog:
        # if another process marked STARTING but no real server is progressing,
        # treat it as stale and recover instead of waiting indefinitely.
        self.starting_stale_timeout = 120
        try:
            self.starting_stale_timeout = int(
                os.getenv("LLM_SERVER_STARTING_STALE_TIMEOUT", str(self.starting_stale_timeout))
            )
        except Exception:
            self.starting_stale_timeout = 120

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

    def _is_transient_runtime_broken_reason(self, error_msg: str) -> bool:
        """True when BROKEN reason is likely recoverable by restarting server runtime."""
        low = (error_msg or "").strip().lower()
        if not low:
            return False
        markers = (
            "server failed to become healthy within",
            "process died during startup",
            "stale starting state",
            "recovered stale starting state",
            "connection refused",
            "read timed out",
            "timed out",
            "startup log:",
            "gguf runtime backend failed for this model",
        )
        return any(m in low for m in markers)

    def _parse_version_tuple(self, version_text: str) -> Tuple[int, int, int]:
        """Parse a version string into a comparable 3-int tuple."""
        nums = [int(x) for x in re.findall(r"\d+", str(version_text or ""))]
        major = nums[0] if len(nums) > 0 else 0
        minor = nums[1] if len(nums) > 1 else 0
        patch = nums[2] if len(nums) > 2 else 0
        return (major, minor, patch)

    def _get_env_package_version(self, python_exe: Path, package_name: str) -> Optional[str]:
        """Return installed package version from target interpreter, or None."""
        code = (
            "import importlib.metadata as m\n"
            f"print(m.version('{package_name}'), end='')\n"
        )
        try:
            result = subprocess.run(
                [str(python_exe), "-c", code],
                capture_output=True,
                text=True,
                timeout=20,
                **self.subprocess_flags
            )
        except Exception:
            return None
        if result.returncode != 0:
            return None
        value = (result.stdout or "").strip()
        return value or None

    def _is_gguf_path(self, model_path: Path) -> bool:
        try:
            if model_path.is_file() and model_path.suffix.lower() == ".gguf":
                return True
            if model_path.is_dir():
                return any(model_path.rglob("*.gguf"))
        except Exception:
            return False
        return False

    def _ensure_min_llama_cpp_version_for_gguf(self, env_spec: EnvSpec, model_path: Path, log) -> None:
        """
        Ensure GGUF environments have a sufficiently new llama-cpp-python runtime.
        Prevents false "env healthy" states when an old wheel is installed.
        """
        if not self._is_gguf_path(model_path):
            return
        min_version = self.env_registry.runtime_bundle_manager.resolve_required_llama_cpp_version(model_path)
        current = self._get_env_package_version(env_spec.python_executable, "llama-cpp-python")
        if not current:
            return
        if self._parse_version_tuple(current) >= self._parse_version_tuple(min_version):
            log(f"llama-cpp-python version check passed ({current} >= {min_version})")
            return

        log(
            f"llama-cpp-python is outdated for GGUF runtime ({current} < {min_version}); "
            "attempting in-place upgrade..."
        )
        ok, err = self.env_registry.auto_install_missing_packages(
            env_spec.python_executable,
            ["llama-cpp-python"],
            log_callback=log,
        )
        if not ok:
            raise RuntimeError(
                f"[RUNTIME_MISSING_COMPONENT] Failed to upgrade llama-cpp-python in environment '{env_spec.key}'. "
                f"Details: {str(err)[:400]}"
            )

        current_after = self._get_env_package_version(env_spec.python_executable, "llama-cpp-python")
        if not current_after or self._parse_version_tuple(current_after) < self._parse_version_tuple(min_version):
            raise RuntimeError(
                f"[RUNTIME_MISSING_COMPONENT] llama-cpp-python remains too old after upgrade "
                f"({current_after or 'unknown'} < {min_version}) in environment '{env_spec.key}'."
            )
        log(f"llama-cpp-python upgrade successful ({current_after})")

    def get_integrity_report(self) -> Dict:
        """Return the last startup integrity report (duplicates, missing env, repairs)."""
        return self._integrity_report if self._integrity_report is not None else {}

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

    def _extract_package_from_importerror(self, error_msg: str) -> Optional[str]:
        """
        Extract package name from ImportError message.
        
        Args:
            error_msg: ImportError message text
            
        Returns:
            Package name if detected, None otherwise
        """
        error_lower = error_msg.lower()
        
        # Known package mappings
        if "optimum" in error_lower or "gptq" in error_lower:
            return "optimum"
        elif "autoawq" in error_lower or ("awq" in error_lower and "auto" in error_lower):
            return "autoawq"
        elif "protobuf" in error_lower or "google.protobuf" in error_lower:
            return "protobuf"
        elif "bitsandbytes" in error_lower or "bnb" in error_lower:
            return "bitsandbytes"
        
        # Try to extract module name from common patterns
        import re
        patterns = [
            r"cannot import name ['\"]([^'\"]+)['\"]",
            r"No module named ['\"]([^'\"]+)['\"]",
            r"cannot import ['\"]([^'\"]+)['\"]",
        ]
        for pattern in patterns:
            match = re.search(pattern, error_msg, re.IGNORECASE)
            if match:
                module_name = match.group(1)
                # Map common import names to package names
                if "optimum" in module_name.lower():
                    return "optimum"
                elif "awq" in module_name.lower():
                    return "autoawq"
                elif "protobuf" in module_name.lower() or "google.protobuf" in module_name.lower():
                    return "protobuf"
                elif "bitsandbytes" in module_name.lower() or "bnb" in module_name.lower():
                    return "bitsandbytes"
                # Return the first part of the module name as package name
                package_name = module_name.split(".")[0]
                if package_name and len(package_name) > 2:
                    return package_name
        
        return None

    def _is_fallback_missing_health_error(self, error_msg: str) -> bool:
        """True when /health error suggests missing fallback deps (gguf tokenizer/runtime packages)."""
        if not isinstance(error_msg, str) or not error_msg.strip():
            return False
        low = error_msg.lower()
        return (
            "gguf>=0.10.0" in low
            or "install torch and gguf" in low
            or "please install torch and gguf" in low
            or "sentencepiece" in low
            or "tiktoken" in low
            or "yarn_log_multiplier" in low
            or "error loading model hyperparameters: key not found in model" in low
            or ("sentencepiece or tiktoken" in low)
            or ("couldn't instantiate the backend tokenizer" in low and ("sentencepiece" in low or "tiktoken" in low))
        )

    def _resolve_onboarding_id(self, model_id: str, model_cfg: Optional[dict] = None) -> str:
        """
        Resolve the onboarding key (canonical model ID) for a server config model_id.
        Delegates to canonical resolver to avoid identity drift.
        """
        return to_canonical_id(model_id, model_cfg=model_cfg, base_model_path=None)

    def _find_onboarding_entries_by_base_model_path(self, base_model_path: str) -> list[dict]:
        """Return all onboarding rows matching the normalized base model path."""
        matches: list[dict] = []
        try:
            target_path = str(Path(base_model_path).resolve()).lower()
        except Exception:
            target_path = str(base_model_path).lower()
        for row in (self.state_store.list_all_onboarding() or []):
            row_base = row.get("base_model_path")
            if not row_base:
                continue
            try:
                row_path = str(Path(row_base).resolve()).lower()
            except Exception:
                row_path = str(row_base).lower()
            if row_path == target_path:
                matches.append(row)
        return matches

    def _canonical_server_id(self, model_id: str) -> str:
        """
        Canonicalize server slot identity so alias IDs share one runtime slot.
        """
        cfg = (self.config.get("models") or {}).get(model_id) if isinstance(self.config, dict) else None
        base_model_path = ""
        try:
            base_model_path = str((cfg or {}).get("base_model") or "")
        except Exception:
            base_model_path = ""
        if not base_model_path:
            try:
                row = self.state_store.get_onboarding(model_id) or {}
                base_model_path = str(row.get("base_model_path") or "")
            except Exception:
                base_model_path = ""
        try:
            return to_canonical_id(model_id, model_cfg=cfg, base_model_path=base_model_path) or model_id
        except Exception:
            return model_id

    def _resolve_runtime_server_id(
        self,
        model_id: str,
        canonical_id: str,
        model_cfg: Optional[dict] = None,
        runtime_base_model: Optional[str] = None,
    ) -> str:
        """
        Derive a distinct runtime slot for exact GGUF file selections while keeping
        directory-backed models on the shared model_id slot.
        """
        runtime_base_model = str(runtime_base_model or "").strip()
        if not runtime_base_model:
            return model_id
        try:
            runtime_path = Path(runtime_base_model).resolve()
        except Exception:
            return model_id
        if runtime_path.suffix.lower() != ".gguf":
            return model_id

        variant_rel = runtime_path.name
        configured_base = str((model_cfg or {}).get("base_model") or "").strip()
        if configured_base:
            try:
                configured_path = Path(configured_base).resolve()
                if configured_path.is_dir():
                    variant_rel = str(runtime_path.relative_to(configured_path)).replace("\\", "/")
            except Exception:
                pass

        variant_slug = re.sub(r"[^A-Za-z0-9._-]+", "__", variant_rel).strip("._-") or runtime_path.name
        return f"{canonical_id or model_id}__gguf__{variant_slug}"

    def _validate_runtime_model_target(self, model_path: Path) -> list[Path]:
        """
        Validate the exact runtime model target that will be launched.

        For explicit GGUF file selections, validate that exact file instead of relying on
        directory marker state. For directory-backed models, keep existing recursive discovery.
        """
        model_path = Path(model_path)
        if not model_path.exists():
            raise RuntimeError(
                f"Model path does not exist: {model_path}\n"
                f"Please check the model path in llm_backends.yaml"
            )

        if model_path.is_file():
            suffix = model_path.suffix.lower()
            if suffix not in {".gguf", ".safetensors", ".bin"}:
                raise RuntimeError(
                    f"Unsupported model file target: {model_path}\n"
                    "Expected a .gguf, .safetensors, or .bin file."
                )
            if suffix == ".gguf":
                try:
                    size_bytes = model_path.stat().st_size
                except Exception as exc:
                    raise RuntimeError(f"GGUF file is unreadable: {model_path} ({exc})") from exc
                if size_bytes < ModelIntegrityChecker.MIN_GGUF_BYTES:
                    raise RuntimeError(
                        f"GGUF file appears truncated: {model_path} ({size_bytes} bytes).\n"
                        "Please repair or redownload this variant."
                    )
                try:
                    with open(model_path, "rb") as fh:
                        magic = fh.read(4)
                except Exception as exc:
                    raise RuntimeError(f"Failed to read GGUF header: {model_path} ({exc})") from exc
                if magic != b"GGUF":
                    raise RuntimeError(
                        f"GGUF file has invalid header: {model_path}\n"
                        "Please repair or redownload this variant."
                    )
            return [model_path]

        model_files = (
            list(model_path.rglob("*.safetensors"))
            + list(model_path.rglob("*.bin"))
            + list(model_path.rglob("*.gguf"))
        )
        if not model_files:
            raise RuntimeError(
                f"No model files found in {model_path}\n"
                f"Expected .safetensors, .bin, or .gguf files. The model may not be downloaded correctly."
            )

        try:
            integrity_status = ModelIntegrityChecker().check_model(model_path)
            if not integrity_status.is_complete:
                details = ", ".join(integrity_status.missing_files) or "unknown model file issue"
                raise RuntimeError(
                    f"Model files failed integrity check: {details}\n"
                    f"Please use 'Repair model files' or re-onboard this model.\n"
                    f"Model path: {model_path}"
                )
        except RuntimeError:
            raise
        except Exception as integrity_ex:
            raise RuntimeError(
                f"Model integrity preflight failed unexpectedly: {integrity_ex}\n"
                f"Model path: {model_path}"
            )
        return model_files

    def _find_canonical_server_candidates(self, canonical_id: str) -> list[dict]:
        """
        Find active server rows (RUNNING/STARTING) that map to the same canonical model.
        """
        rows: list[dict] = []
        for st in ("RUNNING", "STARTING"):
            for row in (self.state_store.list_servers(status=st) or []):
                rid = str((row or {}).get("model_id") or "")
                if not rid:
                    continue
                if self._canonical_server_id(rid) == canonical_id:
                    rows.append(row)
        return rows

    def _cleanup_canonical_duplicate_server_rows(
        self,
        canonical_id: str,
        keep_model_id: str,
        keep_port: Optional[int] = None,
    ):
        """
        Stop and mark duplicate canonical server rows as STOPPED so UI/runtime don't
        show parallel aliases of the same physical model.
        """
        for row in self._find_canonical_server_candidates(canonical_id):
            rid = str((row or {}).get("model_id") or "")
            if not rid or rid == keep_model_id:
                continue
            row_port = int((row or {}).get("port") or 0)
            if keep_port and row_port and row_port != int(keep_port):
                try:
                    self.shutdown_server_by_port(int(row_port))
                except Exception:
                    pass
            try:
                self.state_store.upsert_server(
                    model_id=rid,
                    pid=None,
                    port=row_port or 10500,
                    status="STOPPED",
                    stopped_at=datetime.utcnow().isoformat(),
                    last_error="Stopped duplicate alias server slot; canonical slot in use.",
                )
            except Exception:
                pass

    def _cleanup_orphan_canonical_ports(self, canonical_id: str, keep_port: int):
        """
        Best-effort cleanup for live orphan servers that share canonical identity
        but are not currently represented as RUNNING/STARTING rows in StateStore.
        """
        try:
            models = (self.config or {}).get("models") or {}
            candidate_ports = set()
            for mid, cfg in models.items():
                try:
                    if self._canonical_server_id(str(mid)) == canonical_id:
                        p = int((cfg or {}).get("port") or 0)
                        if p > 0 and p != int(keep_port):
                            candidate_ports.add(p)
                except Exception:
                    continue
            for port in sorted(candidate_ports):
                try:
                    r = requests.get(f"http://127.0.0.1:{port}/health", timeout=1.5)
                    if r.status_code != 200:
                        continue
                    data = r.json()
                    status = str(data.get("status", "")).strip().lower()
                    if status not in {"ok", "loading"}:
                        continue
                    reported_model = str(data.get("model", "")).strip()
                    if reported_model and reported_model.lower() not in {"local-llm", "unknown"}:
                        reported_canonical = self._canonical_server_id(reported_model)
                        if reported_canonical != canonical_id:
                            continue
                    self.shutdown_server_by_port(int(port))
                except Exception:
                    continue
        except Exception:
            pass
    
    def ensure_server_running(
        self,
        model_id: str,
        log_callback=None,
        runtime_base_model: Optional[str] = None,
    ) -> str:
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
            
            model_cfg = self.config["models"][model_id]

            # RUNTIME GATE: Check onboarding status
            from core.model_onboarding import get_onboarding_service
            onboarding = get_onboarding_service()
            identity = resolve_onboarding_identity(
                model_id,
                model_cfg=model_cfg,
                get_status=onboarding.get_onboarding_status,
                strict=True,
            )
            onboarding_id = identity["onboarding_id"] or model_id
            canonical_server_id = identity["canonical_id"] or onboarding_id or model_id
            status = identity["status"]
            if status is None:
                # Identity-drift fallback: if key lookups miss, match onboarding row by base_model_path.
                # This keeps runtime gate aligned with _start_server() fallback behavior.
                try:
                    base_model_path = str((model_cfg or {}).get("base_model") or "").strip()
                    if base_model_path:
                        matches = self._find_onboarding_entries_by_base_model_path(base_model_path)
                        if len(matches) > 1:
                            ids = sorted((m.get("model_id") or "") for m in matches if m.get("model_id"))
                            raise RuntimeError(
                                f"Ambiguous onboarding mapping for model path '{base_model_path}'. "
                                f"Matching onboarding ids: {ids}. Please remove duplicates and retry."
                            )
                        if len(matches) == 1:
                            row = matches[0]
                            onboarding_id = row.get("model_id") or onboarding_id
                            status = row.get("status")
                            try:
                                log(
                                    f"Using onboarding fallback key '{onboarding_id}' via base_model_path match "
                                    f"(runtime gate)."
                                )
                            except Exception:
                                pass
                except RuntimeError:
                    raise
                except Exception:
                    pass
            
            if status is None:
                try:
                    log(f"Model '{onboarding_id}' has no onboarding entry (status=None).")
                except RuntimeError:
                    raise
                except Exception:
                    pass
                raise RuntimeError(
                    f"Model '{onboarding_id}' has not been onboarded. "
                    f"Please run onboarding first (model download/Add model should trigger this)."
                )
            
            if status != "READY":
                entry = self.state_store.get_onboarding(onboarding_id)
                error_msg = entry.get("last_error", "Unknown error") if entry else "Unknown error"
                if str(status).upper() == "BROKEN" and self._is_transient_runtime_broken_reason(str(error_msg)):
                    try:
                        log(
                            f"Model '{onboarding_id}' is BROKEN due to transient startup failure; "
                            "attempting automatic runtime recovery."
                        )
                    except Exception:
                        pass
                else:
                    try:
                        log(f"Model '{onboarding_id}' is not READY (status={status}). Error: {error_msg}")
                    except Exception:
                        pass
                    raise RuntimeError(
                        f"Model '{onboarding_id}' is not ready for runtime (status={status}). "
                        f"Please complete onboarding or repair the model. "
                        f"Error: {error_msg}"
                    )
            
            server_id = self._resolve_runtime_server_id(
                model_id=model_id,
                canonical_id=canonical_server_id,
                model_cfg=model_cfg,
                runtime_base_model=runtime_base_model,
            )
            if server_id != model_id:
                try:
                    log(
                        f"Using GGUF runtime slot '{server_id}' for model '{model_id}' "
                        f"(base_model={runtime_base_model})."
                    )
                except Exception:
                    pass

            # Check for duplicate ports and warn
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

            # Canonical reuse gate: if an alias of this same canonical model is already running/loading,
            # reuse that server slot instead of starting another one.
            canonical_candidates = self._find_canonical_server_candidates(canonical_server_id)
            for row in canonical_candidates:
                rid = str((row or {}).get("model_id") or "")
                port = int((row or {}).get("port") or 0)
                if not rid or port <= 0:
                    continue
                try:
                    r = requests.get(f"http://127.0.0.1:{port}/health", timeout=2)
                    if r.status_code != 200:
                        continue
                    data = r.json()
                    health_status = str(data.get("status", "")).strip().lower()
                    reported_model = str(data.get("model", "")).strip()
                    # Some backends report placeholder model names like "local-llm" on /health.
                    # Treat these as unknown and allow canonical-slot reuse checks to proceed.
                    if reported_model and reported_model.lower() not in {"local-llm", "unknown"}:
                        reported_canonical = self._canonical_server_id(reported_model)
                        if reported_canonical and reported_canonical != canonical_server_id:
                            continue
                    if health_status in {"ok", "loading"}:
                        log(
                            f"Reusing canonical server slot '{rid}' on port {port} "
                            f"for requested model '{model_id}'."
                        )
                        self.state_store.upsert_server(
                            model_id=server_id,
                            pid=None,
                            port=port,
                            status="RUNNING" if health_status == "ok" else "STARTING",
                        )
                        self._cleanup_canonical_duplicate_server_rows(
                            canonical_server_id,
                            keep_model_id=server_id,
                            keep_port=port,
                        )
                        self._cleanup_orphan_canonical_ports(canonical_server_id, keep_port=port)
                        if health_status == "loading":
                            self._wait_for_health_ok(server_id, self.warmup_timeout, log_callback=log, port=port)
                        return self._get_server_url(server_id)
                except Exception:
                    continue
            
            # Check if already running. If the process is alive, REUSE it — never
            # kill a same-model server that another caller may currently be using.
            # A failing /health check (status "loading", "unknown", False) usually
            # just means the server is busy answering an in-flight generation;
            # a 2s probe timing out is not evidence that it's broken. Wait it out;
            # only restart if it genuinely never recovers within warmup_timeout.
            if server_id in self.running_servers:
                process, _, _ = self.running_servers[server_id]
                if process.poll() is None:  # Process is alive
                    health_status, _ = self._check_health(server_id, return_status=True)
                    if health_status == "ok":
                        log(f"Server '{server_id}' already running and healthy")
                        return self._get_server_url(server_id)
                    log(
                        f"Server '{server_id}' alive but health probe returned "
                        f"status={health_status!r} (likely busy or still loading). "
                        f"Waiting for it to become ready instead of restarting."
                    )
                    try:
                        self._wait_for_health_ok(server_id, self.warmup_timeout, log_callback=log)
                        return self._get_server_url(server_id)
                    except TimeoutError:
                        log(
                            f"Server '{server_id}' never returned to 'ok' within "
                            f"{self.warmup_timeout}s; assuming stuck and restarting."
                        )
                        self._force_kill_process_tree(process, server_id)
                        del self.running_servers[server_id]
                else:
                    log(f"Server '{server_id}' process died, restarting")
                    del self.running_servers[server_id]

            # If another slot already started this model (STARTING), wait for it instead of starting duplicate
            server_state = self.state_store.get_server(server_id)
            if server_state and server_state.get("status") == "STARTING":
                port = server_state.get("port")
                pid = server_state.get("pid")
                started_at = server_state.get("started_at")
                if port is not None:
                    wait_timeout = max(20, min(self.warmup_timeout, self.starting_stale_timeout))
                    age_sec = self._state_age_seconds(started_at)
                    pid_alive = self._is_pid_alive(pid)
                    port_has_listener = not self._check_port_available(int(port))
                    stale_start = (
                        (age_sec is not None and age_sec >= self.starting_stale_timeout)
                        and ((pid is not None and not pid_alive) or (not port_has_listener))
                    )
                    if stale_start:
                        log(
                            f"Detected stale STARTING state for '{model_id}' "
                            f"(age={int(age_sec)}s, pid={pid}, pid_alive={pid_alive}, port={port}, "
                            f"listener={port_has_listener}). Recovering by resetting state."
                        )
                        try:
                            self.state_store.upsert_server(
                                model_id=server_id,
                                pid=pid if isinstance(pid, int) else None,
                                port=int(port),
                                status="FAILED",
                                stopped_at=datetime.utcnow().isoformat(),
                                last_error=(
                                    "Recovered stale STARTING state: no active startup process/listener. "
                                    "A fresh server start will be attempted."
                                )[:500],
                            )
                        except Exception:
                            pass
                    else:
                        log(
                            f"Server for '{server_id}' is already starting (port {port}), "
                            f"waiting up to {wait_timeout}s for readiness..."
                        )
                        try:
                            self._wait_for_health_ok(server_id, wait_timeout, log_callback=log, port=port)
                            return self._get_server_url(server_id)
                        except TimeoutError:
                            log(f"Existing start did not become ready in {wait_timeout}s, will start server")
            
            # Fast-path: if something is already healthy on our preferred port, reuse it
            # without logging "Starting server..." or calling _start_server
            try:
                r = requests.get(f"http://127.0.0.1:{preferred_port}/health", timeout=2)
                if r.status_code == 200:
                    data = r.json()
                    if (str(data.get("model", "")).strip() == server_id and
                            str(data.get("status", "")).lower().strip() == "ok"):
                        log(f"Server already running on port {preferred_port}, reusing it")
                        self.state_store.upsert_server(server_id, None, preferred_port, "RUNNING")
                        return self._get_server_url(server_id)
            except Exception:
                pass  # Fall through to _start_server
            
            # Start new server
            self._start_server(
                model_id,
                log_callback=log_callback,
                server_id=server_id,
                runtime_base_model=runtime_base_model,
            )
            return self._get_server_url(server_id)
    
    def _check_port_available(self, port: int) -> bool:
        """
        Check if port is available.
        
        Args:
            port: Port number to check
            
        Returns:
            True if available, False if in use
        """
        # Fast path: if something is already listening, port is not available.
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            probe.settimeout(0.25)
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                return False
        except OSError:
            # Ignore probe errors and fall through to bind check.
            pass
        finally:
            try:
                probe.close()
            except Exception:
                pass

        # Strict bind check: do NOT set SO_REUSEADDR on Windows here.
        # SO_REUSEADDR can report false positives for "available" even when occupied.
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            sock.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False
        finally:
            try:
                sock.close()
            except Exception:
                pass

    def _is_pid_alive(self, pid: Optional[int]) -> bool:
        """Best-effort check whether a process PID is still alive."""
        if pid is None:
            return False
        try:
            pid_i = int(pid)
        except Exception:
            return False
        if pid_i <= 0:
            return False
        try:
            if os.name == "nt":
                result = subprocess.run(
                    ["tasklist", "/FI", f"PID eq {pid_i}", "/FO", "CSV", "/NH"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    **self.subprocess_flags,
                )
                out = (result.stdout or "").strip().lower()
                if "no tasks are running" in out:
                    return False
                return f"\"{pid_i}\"" in out
            os.kill(pid_i, 0)
            return True
        except Exception:
            return False

    def _state_age_seconds(self, iso_ts: Optional[str]) -> Optional[float]:
        """Parse ISO timestamp and return age in seconds (UTC)."""
        if not iso_ts:
            return None
        try:
            ts = str(iso_ts).strip()
            if ts.endswith("Z"):
                ts = ts[:-1] + "+00:00"
            dt = datetime.fromisoformat(ts)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return max(0.0, (datetime.now(timezone.utc) - dt).total_seconds())
        except Exception:
            return None

    def _start_server(
        self,
        model_id: str,
        log_callback=None,
        server_id: Optional[str] = None,
        runtime_base_model: Optional[str] = None,
    ):
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

        # Same-server adapter detection. If this model_id is just a
        # LoRA adapter sharing its base's process (``shares_server_with``
        # field set in the YAML by ``_wire_adapter_into_yaml``), DO NOT
        # start a second server. Start the BASE instead — it loads
        # base + adapter together — and let the per-request ``adapter``
        # field on chat calls toggle the LoRA layer at inference time.
        # This is what lets Test page Model A=base + Model B=adapter
        # work on a single 4090 without doubling VRAM.
        try:
            cfg_models = (self.config or {}).get("models", {}) or {}
            this_entry = cfg_models.get(model_id) or {}
            base_for_share = this_entry.get("shares_server_with")
            if base_for_share and base_for_share != model_id and base_for_share in cfg_models:
                base_entry = cfg_models[base_for_share]
                base_port = int(base_entry.get("port", 0) or 0)
                this_port = int(this_entry.get("port", 0) or 0)
                if base_port and base_port == this_port:
                    log(
                        f"[adapter-share] '{model_id}' shares server with "
                        f"base '{base_for_share}' on port {base_port}. "
                        "Starting (or reusing) the base server instead of "
                        "spawning a duplicate."
                    )
                    # Delegate to the base. If a server is already running
                    # there, the existing health-check logic short-circuits.
                    return self._start_server(
                        base_for_share,
                        log_callback=log_callback,
                        server_id=server_id,
                        runtime_base_model=runtime_base_model,
                    )
        except Exception as exc:
            log(f"[adapter-share] same-server check failed: {exc!r} — falling through to normal launch")

        from core.inference import get_app_root
        from core.gpu_config import get_chosen_gpu_index
        app_root = get_app_root()
        # Deterministic resolution: GPU from gpu_config.json then nvidia-smi; port from YAML then conflict handling; interpreter from env (below).
        chosen_gpu = get_chosen_gpu_index(app_root, subprocess_flags=self.subprocess_flags)
        log(f"Launch context: preferred_port from YAML, gpu={chosen_gpu if chosen_gpu is not None else 'default'}, interpreter from model env (resolved below)")

        # Check current VRAM usage before starting (warn if free is very low)
        # Use the selected GPU index so the warning reflects the GPU the server will use
        try:
            r = subprocess.run(
                ["nvidia-smi", "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
                capture_output=True,
                text=True,
                timeout=5,
                **self.subprocess_flags,
            )
            if r.returncode == 0 and r.stdout.strip():
                lines = [x.strip() for x in r.stdout.strip().split("\n") if x.strip()]
                if lines:
                    line_idx = chosen_gpu if (chosen_gpu is not None and 0 <= chosen_gpu < len(lines)) else 0
                    parts = lines[line_idx].split(",")
                    if len(parts) >= 2:
                        used_mb = float(parts[0].strip())
                        total_mb = float(parts[1].strip())
                        free_mb = total_mb - used_mb
                        free_gb = free_mb / 1024.0
                        if free_gb < 2.0 and total_mb > 0:
                            log(
                                f"[VRAM] Low free GPU memory (GPU {line_idx}): {free_gb:.1f} GB free "
                                f"({used_mb:.0f} MB used / {total_mb:.0f} MB total). "
                                "Loading the model may fail or be very slow."
                            )
        except Exception as e:
            logger.debug("Could not check VRAM usage: %s", e)

        model_cfg = self.config["models"][model_id]
        server_id = str(server_id or model_id)
        base_model = str(runtime_base_model or model_cfg["base_model"])
        # Single key for all BROKEN writes this run (set when we load onboarding; fallback when we only wait).
        authoritative_onboarding_id = None

        # PHASE 1: Get preferred port from YAML (this is the AUTHORITATIVE port assignment)
        preferred_port = model_cfg.get("port", 10500)  # Default if not specified
        port = preferred_port
        port_has_our_server = False  # Flag: if True, skip starting new server and go to warmup loop
        port_needs_reassignment = False  # Flag: if True, skip retries and search for new port immediately
        
        log(f"Starting server for model '{server_id}' on preferred port {port} (from YAML config)")
        
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
                if reported_model == server_id:
                    if status == "ok":
                        log(f"Server already running on preferred port {port} (status=ok), reusing it")
                        self.state_store.upsert_server(server_id, None, port, "RUNNING")
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
                            server_state = self.state_store.get_server(server_id)
                            pid = None
                            if server_state and server_state.get('pid'):
                                pid = server_state.get('pid')
                            
                            if pid:
                                try:
                                    if os.name == 'nt':  # Windows
                                        subprocess.run(['taskkill', '/F', '/PID', str(pid)], 
                                                     capture_output=True, timeout=5, **self.subprocess_flags)
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
                                        timeout=5,
                                        **self.subprocess_flags
                                    )
                                    for line in result.stdout.split('\n'):
                                        if f':{port}' in line and 'LISTENING' in line:
                                            parts = line.split()
                                            if len(parts) >= 5:
                                                found_pid = parts[-1]
                                                if found_pid.isdigit():
                                                    subprocess.run(['taskkill', '/F', '/PID', found_pid],
                                                                 capture_output=True, timeout=5, **self.subprocess_flags)
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
                elif reported_model and reported_model not in {server_id, ""}:
                    log(
                        f"Port {port} is already in use by model '{reported_model}'. "
                        f"Will search for an available port for '{model_id}'."
                    )
                # Generic model identity is ambiguous; do not reuse to avoid cross-model contamination.
                elif status in {"ok", "loading"} and not reported_model:
                    log(
                        f"Port {port} has a healthy server with unknown model identity; "
                        f"will not reuse for '{model_id}'."
                    )
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
                                    self.state_store.upsert_server(server_id, None, port, "RUNNING")
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
                    if reported_model and reported_model == server_id:
                        if status == "ok":
                            # Server is healthy - reuse it
                            log(f"Found our server on port {port} (status=ok), reusing it")
                            self.state_store.upsert_server(server_id, None, port, "RUNNING")
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
                                server_state = self.state_store.get_server(server_id)
                                pid = None
                                if server_state and server_state.get('pid'):
                                    pid = server_state.get('pid')
                                
                                # If we have PID, try to kill it
                                if pid:
                                    try:
                                        if os.name == 'nt':  # Windows
                                            subprocess.run(['taskkill', '/F', '/PID', str(pid)], 
                                                         capture_output=True, timeout=5, **self.subprocess_flags)
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
                                                timeout=5,
                                                **self.subprocess_flags,
                                            )
                                            for line in result.stdout.split('\n'):
                                                if f':{port}' in line and 'LISTENING' in line:
                                                    parts = line.split()
                                                    if len(parts) >= 5:
                                                        found_pid = parts[-1]
                                                        if found_pid.isdigit():
                                                            subprocess.run(['taskkill', '/F', '/PID', found_pid],
                                                                         capture_output=True, timeout=5, **self.subprocess_flags)
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
                    elif reported_model and reported_model not in {server_id, ""}:
                        # Different model is using this port - immediately search for new port
                        log(
                            f"Port {port} is already in use by a different model '{reported_model}'. "
                            f"Searching for an available port for '{model_id}'..."
                        )
                        # Break out of retry loop immediately - don't waste time retrying
                        port_needs_reassignment = True
                        break
                    elif status in {"ok", "loading"} and not reported_model:
                        log(
                            f"Found healthy server on port {port} with unknown model identity; "
                            f"will not reuse for '{model_id}'."
                        )
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
                                        self.state_store.upsert_server(server_id, None, port, "RUNNING")
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
                            server_state = self.state_store.get_server(server_id)
                            pid = None
                            if server_state and server_state.get('pid'):
                                pid = server_state.get('pid')
                            
                            if pid:
                                try:
                                    if os.name == 'nt':  # Windows
                                        subprocess.run(['taskkill', '/F', '/PID', str(pid)], 
                                                     capture_output=True, timeout=5, **self.subprocess_flags)
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
                                        timeout=5,
                                        **self.subprocess_flags
                                    )
                                    for line in result.stdout.split('\n'):
                                        if f':{port}' in line and 'LISTENING' in line:
                                            parts = line.split()
                                            if len(parts) >= 5:
                                                found_pid = parts[-1]
                                                if found_pid.isdigit():
                                                    subprocess.run(['taskkill', '/F', '/PID', found_pid],
                                                                 capture_output=True, timeout=5, **self.subprocess_flags)
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
            # Exclude ports already in use by running/starting servers (deterministic conflict avoidance)
            try:
                for st in ("RUNNING", "STARTING"):
                    for row in (self.state_store.list_servers(status=st) or []):
                        p = row.get("port")
                        if p is not None:
                            other_model_ports.add(int(p))
            except Exception:
                pass
            # Also check ports in the standard range (10500-10600)
            candidate_ports = sorted({int(p) for p in list(other_model_ports) + list(range(10500, 10601))})
            
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
                            if reported_model and reported_model != model_id:
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
                            timeout=5,
                            **self.subprocess_flags,
                        )
                        for line in result.stdout.split('\n'):
                            if f':{port}' in line and 'LISTENING' in line:
                                parts = line.split()
                                if len(parts) >= 5:
                                    found_pid = parts[-1]
                                    if found_pid.isdigit():
                                        subprocess.run(['taskkill', '/F', '/PID', found_pid],
                                                     capture_output=True, timeout=5, **self.subprocess_flags)
                                        log(f"Killed process {found_pid} on port {port}")
                                        time.sleep(2)  # Wait for port release
                                        break
                except Exception as e:
                    log(f"Failed to kill process on port {port}: {e}")
                    # Continue anyway - will fail with clear error if port still bound
            
            # Validate the exact runtime model target that will be launched.
            model_path_str = str(base_model or "").strip()
            if not model_path_str:
                raise RuntimeError(
                    f"Model path (base_model) not specified in config for '{model_id}'\n"
                    f"Please check the base_model field in llm_backends.yaml"
                )
            
            model_path = Path(model_path_str)
            model_files = self._validate_runtime_model_target(model_path)
            
            log(f"Found {len(model_files)} model files, starting server...")

            # App root for logs and launcher script
            from core.inference import get_app_root
            app_root = get_app_root()
            
            # Get environment for this model
            # RUNTIME: Use existing env only (no creation/repair in runtime path)
            log(f"Getting environment for model: {base_model}")
            
            # Get onboarding entry to find env_key.
            # Authority: model_onboarding.env_key is the runtime source of truth; models.env_key is legacy mirror.
            # IMPORTANT: onboarding is usually keyed by HF id (org/repo), but
            # older/stale rows may still exist under sanitized config keys.
            # Be resilient to key drift by trying both key forms and path match.
            identity = resolve_onboarding_identity(
                model_id,
                model_cfg=model_cfg,
                get_status=lambda mid: (self.state_store.get_onboarding(mid) or {}).get("status"),
                strict=True,
            )
            derived_onboarding_id = identity["canonical_id"] or model_id
            onboarding_id = identity["onboarding_id"] or model_id
            onboarding_entry = self.state_store.get_onboarding(onboarding_id)

            if not onboarding_entry:
                # Last fallback: match onboarding rows by base_model_path.
                try:
                    onboarding_lookup_path = model_path.parent if model_path.is_file() else model_path
                    matches = self._find_onboarding_entries_by_base_model_path(str(onboarding_lookup_path))
                    if len(matches) > 1:
                        ids = sorted((m.get("model_id") or "") for m in matches if m.get("model_id"))
                        raise RuntimeError(
                            f"Ambiguous onboarding mapping for model path '{model_path}'. "
                            f"Matching onboarding ids: {ids}. Please remove duplicate onboarding rows."
                        )
                    if len(matches) == 1:
                        row = matches[0]
                        onboarding_entry = row
                        onboarding_id = row.get("model_id") or onboarding_id
                except RuntimeError:
                    raise
                except Exception:
                    pass

            if not onboarding_entry:
                raise RuntimeError(
                    f"Model onboarding entry not found for runtime model '{model_id}'. "
                    f"Tried keys: '{derived_onboarding_id}' and '{model_id}'. "
                    f"Please run onboarding first."
                )
            if onboarding_id != derived_onboarding_id:
                log(
                    f"Using fallback onboarding key '{onboarding_id}' "
                    f"(derived key '{derived_onboarding_id}' not available)."
                )
                # Phase 3 (optional): reject ambiguous mappings here; for now compatibility path kept.
            authoritative_onboarding_id = onboarding_id

            env_key = onboarding_entry.get("env_key")
            onboarding_backend = str(onboarding_entry.get("backend") or "").strip().lower()
            use_bundled_backend = onboarding_backend == "llama_cpp_server"
            if not env_key:
                raise RuntimeError(
                    f"Model '{onboarding_id}' has no env_key in onboarding entry. "
                    f"Please re-run onboarding."
                )
            
            # Get env spec (should already exist from onboarding)
            python_exe = self.env_registry._get_env_python_executable(env_key)
            if not python_exe or not python_exe.exists():
                raise RuntimeError(
                    f"Environment '{env_key}' for model '{onboarding_id}' not found. "
                    f"Please re-run onboarding."
                )
            
            env_spec = EnvSpec(
                key=env_key,
                python_executable=python_exe,
                metadata={"env_key": env_key, "status": "READY", "source": "onboarded"}
            )
            if use_bundled_backend:
                log("Runtime routing: using bundled llama.cpp backend for this model.")
            log(f"Using environment: {env_spec.key}")
            log(f"Python executable: {env_spec.python_executable}")
            log(f"Resolved launch: interpreter={env_spec.python_executable}, gpu={chosen_gpu if chosen_gpu is not None else 'default'}, port={port}")
            logger.info(
                "RUNTIME_EVENT launch_resolved model_id=%s interpreter=%s gpu=%s port=%s",
                model_id, env_spec.python_executable, chosen_gpu if chosen_gpu is not None else "default", port,
            )
            
            # ENVIRONMENT-FIRST: Comprehensive validation and repair BEFORE model load
            log("Validating environment dependencies (environment-first approach)...")
            
            # Check for critical packages using universal capability matrix (parity with onboarding).
            from core.envs.capability_matrix import get_runtime_required_packages, BASE_PACKAGES as _BASE_PACKAGES
            adapter_dir = onboarding_entry.get("adapter_dir") or (self.config.get("models", {}).get(model_id, {}) or {}).get("adapter_dir")
            critical_packages = get_runtime_required_packages(
                str(model_path),
                model_cfg=model_cfg,
                adapter_dir=adapter_dir,
                model_id=model_id,
            )
            if not critical_packages:
                critical_packages = list(_BASE_PACKAGES)
            is_gguf_model_early = False
            try:
                if model_path.is_file() and model_path.suffix.lower() == ".gguf":
                    is_gguf_model_early = True
                elif model_path.is_dir():
                    is_gguf_model_early = any(model_path.rglob("*.gguf"))
            except Exception:
                is_gguf_model_early = False
            if use_bundled_backend and is_gguf_model_early:
                # Bundled runtime path does not require python gguf package stack.
                critical_packages = []
            logger.info(
                "RUNTIME_EVENT dependency_resolved model_id=%s env_key=%s packages_count=%s",
                model_id, env_spec.key, len(critical_packages),
            )
            missing_packages = self.env_registry.check_missing_packages(
                env_spec.python_executable,
                required_packages=critical_packages
            )
            
            if missing_packages:
                log(f"Missing critical packages detected: {', '.join(missing_packages)}")
                if (
                    is_gguf_model_early
                    and "llama-cpp-python" in set(missing_packages)
                    and not use_bundled_backend
                ):
                    try:
                        bundled_ok, bundled_msg = self.env_registry.runtime_bundle_manager.probe_bundled_gguf_runtime(
                            model_path,
                            log_callback=log,
                        )
                        if bundled_ok:
                            use_bundled_backend = True
                            missing_packages = [p for p in missing_packages if p != "llama-cpp-python"]
                            onboarding_backend = "llama_cpp_server"
                            log(
                                "Switching runtime route to bundled llama.cpp backend because "
                                "python llama-cpp runtime is unavailable for this GGUF model. "
                                f"{bundled_msg}"
                            )
                            try:
                                self.state_store.upsert_onboarding(
                                    model_id=onboarding_id,
                                    base_model_path=str(model_path),
                                    adapter_dir=adapter_dir,
                                    env_key=env_spec.key,
                                    backend="llama_cpp_server",
                                    accelerator=onboarding_entry.get("accelerator"),
                                    status=onboarding_entry.get("status") or "READY",
                                    last_error=onboarding_entry.get("last_error"),
                                    healthcheck_log_path=onboarding_entry.get("healthcheck_log_path"),
                                )
                            except Exception:
                                pass
                    except Exception as bundled_switch_ex:
                        log(f"Bundled runtime switch attempt failed: {bundled_switch_ex}")
                is_dedicated = "--dedicated--" in env_spec.key
                vision_migration_pkgs = {"Pillow", "timm", "einops", "open-clip-torch"}
                missing_set = set(missing_packages)
                # Backward-compat migration for existing dedicated vision envs created before
                # multimodal deps were enforced in runtime preflight.
                if is_dedicated and missing_set and missing_set.issubset(vision_migration_pkgs):
                    log(
                        "Detected missing dedicated vision deps in existing env; "
                        "attempting one-shot compatibility install before fail-fast..."
                    )
                    try:
                        mig_ok, mig_err = self.env_registry.auto_install_missing_packages(
                            env_spec.python_executable,
                            missing_packages,
                            log_callback=log,
                        )
                        if mig_ok:
                            mig_recheck = self.env_registry.check_missing_packages(
                                env_spec.python_executable,
                                required_packages=critical_packages,
                            )
                            if not mig_recheck:
                                missing_packages = []
                                log("Dedicated vision dependency migration succeeded; revalidation passed.")
                            else:
                                log(f"Vision migration install incomplete; still missing: {mig_recheck}")
                        else:
                            log(f"Vision migration install failed: {mig_err[:300]}")
                    except Exception as mig_ex:
                        log(f"Vision migration install error: {mig_ex}")
                # One-shot runtime auto-repair. For DEDICATED envs we always
                # try, because a dedicated env is contractually a complete
                # self-contained runtime for its model — if it's missing
                # core packages (transformers, accelerate, …) onboarding
                # left it incomplete and the user-facing fix is the same
                # install we'd run on opt-in. For SHARED envs we keep the
                # opt-in gate so a quick boot doesn't accidentally fix up
                # the global venv. LLM_RUNTIME_AUTO_REPAIR=0 forces the
                # old strict behaviour for both.
                auto_repair_env = os.environ.get("LLM_RUNTIME_AUTO_REPAIR", "").strip().lower()
                auto_repair_disabled = auto_repair_env in ("0", "false", "no")
                auto_repair_forced = auto_repair_env in ("1", "true", "yes")
                auto_repair = (
                    not auto_repair_disabled
                    and (auto_repair_forced or is_dedicated)
                )
                if auto_repair and missing_packages:
                    log(
                        "Attempting one-shot install of missing packages "
                        f"({'dedicated env auto-heal' if is_dedicated and not auto_repair_forced else 'LLM_RUNTIME_AUTO_REPAIR'})..."
                    )
                    try:
                        install_ok, install_err = self.env_registry.auto_install_missing_packages(
                            env_spec.python_executable,
                            missing_packages,
                            log_callback=log,
                        )
                        if install_ok:
                            recheck = self.env_registry.check_missing_packages(
                                env_spec.python_executable,
                                required_packages=critical_packages,
                            )
                            if not recheck:
                                missing_packages = []
                                log("Runtime auto-repair succeeded; revalidation passed.")
                            else:
                                log(f"After install, packages still missing: {recheck}")
                        else:
                            log(f"Runtime auto-repair install failed: {install_err[:200]}")
                    except Exception as repair_ex:
                        log(f"Runtime auto-repair error: {repair_ex}")
                if missing_packages:
                    # Fail-fast: mark BROKEN and raise (default behavior, or after failed auto-repair)
                    from datetime import datetime
                    log_dir = app_root / "logs" / "server_startup"
                    log_dir.mkdir(parents=True, exist_ok=True)
                    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
                    safe_model_id = server_id.replace("/", "__").replace("\\", "__")
                    preflight_log_path = log_dir / f"{safe_model_id}_{timestamp}_env_preflight.log"
                    try:
                        preflight_log_path.write_text(
                            f"Missing critical packages in env '{env_spec.key}': {', '.join(missing_packages)}\n",
                            encoding="utf-8",
                            errors="replace",
                        )
                    except Exception:
                        pass

                    try:
                        self.state_store.upsert_onboarding(
                            model_id=onboarding_id,
                            base_model_path=str(model_path),
                            adapter_dir=adapter_dir,
                            env_key=env_spec.key,
                            status="BROKEN",
                            last_error=(
                                f"Missing critical packages in environment '{env_spec.key}': {', '.join(missing_packages)}\n"
                                f"Startup log: {preflight_log_path}"
                            )[:2000],
                        )
                    except Exception:
                        pass

                    if is_dedicated:
                        raise RuntimeError(
                            f"[RUNTIME_MISSING_COMPONENT] Model environment is missing critical packages: {', '.join(missing_packages)}\n"
                            f"The model has been marked BROKEN. Please re-onboard/repair this model before chatting.\n"
                            f"Startup log: {preflight_log_path}"
                        )
                    else:
                        raise RuntimeError(
                            f"[RUNTIME_MISSING_COMPONENT] Missing critical packages in shared environment '{env_spec.key}': {', '.join(missing_packages)}\n"
                            "Please re-onboard the model to create/refresh its dedicated environment, "
                            "or click '🛡️ Isolation' on the model card.\n"
                            f"Startup log: {preflight_log_path}"
                        )
            log("Environment dependencies validated - all critical packages present")

            # Migration 6/6: unified torch ABI coherence check.
            # The 'critical packages present' gate above only checks that
            # each package has a compatible-version wheel installed — it
            # does NOT verify that torch's C extensions actually load.
            # That distinction matters: a venv with torch+cu121 installed
            # but a stale torchvision/_C.pyd compiled against a different
            # libtorch reports 'all packages present' here AND then dies
            # at first inference with the Windows 'Entry Point Not Found'
            # pop-up (we hit this empirically with Gemma-4 / unsloth).
            # EnvRepairer's torch trio coherence step force-rebuilds the
            # matched cu* triple in that exact case. Soft-dependency: a
            # verify failure logs the trace; the existing 'critical
            # packages OK' result stands so we don't regress models that
            # were working before the unified check existed.
            try:
                from core.install import EnvRepairer, RepairOutcome
                from pathlib import Path as _Path
                repairer = EnvRepairer(project_root=_Path(__file__).resolve().parents[1])
                pin_env_id = self.env_registry.env_key_resolver.parse_env_key(env_spec.key).get("profile_id") or env_spec.key
                if pin_env_id in repairer.resolver.profile_ids:
                    log(f"[server-preflight] EnvRepairer torch coherence check (profile={pin_env_id})")
                    coh = repairer.repair(
                        env_python=_Path(env_spec.python_executable),
                        env_id=pin_env_id,
                        log=log,
                    )
                    if coh.outcome == RepairOutcome.SUCCESS_WITH_WARNINGS:
                        log(f"[server-preflight] coherence warning: {coh.summary}")
                    elif coh.outcome != RepairOutcome.SUCCESS:
                        log(f"[server-preflight] coherence check non-fatal failure: {coh.summary}")
                else:
                    log(f"[server-preflight] env_key {env_spec.key!r} has no matching profile — skipping coherence check")
            except Exception as coh_exc:
                log(f"[server-preflight] EnvRepairer coherence check raised (continuing): {type(coh_exc).__name__}: {coh_exc}")

            if not use_bundled_backend:
                self._ensure_min_llama_cpp_version_for_gguf(env_spec, model_path, log)

            # Additional health check: verify environment can import required modules.
            # IMPORTANT: critical_packages are pip package names, not always import module names.
            log("Running environment health check...")
            try:
                # Use same package list as preflight (capability matrix), mapped to import names.
                import_map = {
                    "protobuf": "google.protobuf",
                    "auto-gptq": "auto_gptq",
                    "open-clip-torch": "open_clip",
                    "Pillow": "PIL",
                    "llama-cpp-python": "llama_cpp",
                }
                health_imports = [import_map.get(p, p) for p in critical_packages]
                health_lines = ["import importlib"] + [f"importlib.import_module('{m}')" for m in health_imports] + ["print('OK')"]
                health_code = "\n".join(health_lines)
                result = subprocess.run(
                    [str(env_spec.python_executable), "-c", health_code],
                    capture_output=True,
                    text=True,
                    timeout=30,
                    **self.subprocess_flags
                )
                if result.returncode != 0 or "OK" not in result.stdout:
                    stdout_snip = (result.stdout or "")[:300]
                    stderr_snip = (result.stderr or "")[:300]
                    log(f"Environment health check failed. stdout: {stdout_snip}")
                    if stderr_snip:
                        log(f"Environment health check failed. stderr: {stderr_snip}")
                    raise RuntimeError(
                        f"Environment {env_spec.key} failed health check.\n"
                        f"Environment may be corrupted. Please repair it in the Environment/Requirements tab."
                    )
                log("Environment health check passed")
                logger.info("RUNTIME_EVENT health_ready model_id=%s env_key=%s", server_id, env_spec.key)
            except Exception as e:
                log(f"Environment health check error: {e}")
                raise RuntimeError(
                    f"[ENVIRONMENT_CORRUPT] Environment {env_spec.key} health check failed: {e}\n"
                    f"Please repair the environment before attempting to load models."
                )

            # Runtime pass/fail probe gate:
            # Validate this exact env can initialize/load this exact model family before launch.
            # This prevents "env looks healthy but model can never start" loops.
            log("Running runtime model-load probe gate...")
            is_gguf_model = False
            try:
                if model_path.is_file() and model_path.suffix.lower() == ".gguf":
                    is_gguf_model = True
                elif model_path.is_dir():
                    is_gguf_model = any(model_path.rglob("*.gguf"))
            except Exception:
                is_gguf_model = False
            if use_bundled_backend and is_gguf_model:
                probe_ok, bundled_msg = self.env_registry.runtime_bundle_manager.probe_bundled_gguf_runtime(
                    model_path,
                    log_callback=log,
                )
                probe_reason = None if probe_ok else "GGUF_BACKEND_INCOMPATIBLE"
                probe_error = None if probe_ok else bundled_msg
            else:
                probe_ok, probe_reason, probe_error = self.env_registry.run_model_load_probe(
                    env_spec.python_executable,
                    str(model_path),
                    adapter_dir=adapter_dir,
                    deep_probe=is_gguf_model,
                    log_callback=log,
                )
            if not probe_ok:
                if not use_bundled_backend and is_gguf_model:
                    try:
                        bundled_ok, bundled_msg = self.env_registry.runtime_bundle_manager.probe_bundled_gguf_runtime(
                            model_path,
                            log_callback=log,
                        )
                        if bundled_ok:
                            use_bundled_backend = True
                            onboarding_backend = "llama_cpp_server"
                            probe_ok = True
                            probe_reason = None
                            probe_error = None
                            log(
                                "Switching runtime route to bundled llama.cpp backend because "
                                f"the python GGUF runtime probe failed. {bundled_msg}"
                            )
                            try:
                                self.state_store.upsert_onboarding(
                                    model_id=onboarding_id,
                                    base_model_path=str(model_path),
                                    adapter_dir=adapter_dir,
                                    env_key=env_spec.key,
                                    backend="llama_cpp_server",
                                    accelerator=onboarding_entry.get("accelerator"),
                                    status=onboarding_entry.get("status") or "READY",
                                    last_error=onboarding_entry.get("last_error"),
                                    healthcheck_log_path=onboarding_entry.get("healthcheck_log_path"),
                                )
                            except Exception:
                                pass
                    except Exception as bundled_switch_ex:
                        log(f"Bundled runtime switch attempt after GGUF probe failure failed: {bundled_switch_ex}")
            if not probe_ok:
                from datetime import datetime
                log_dir = app_root / "logs" / "server_startup"
                log_dir.mkdir(parents=True, exist_ok=True)
                timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
                safe_model_id = server_id.replace("/", "__").replace("\\", "__")
                probe_log_path = log_dir / f"{safe_model_id}_{timestamp}_runtime_probe.log"
                try:
                    probe_log_path.write_text(
                        f"Runtime model-load probe failed.\n"
                        f"model_id={model_id}\n"
                        f"env_key={env_spec.key}\n"
                        f"reason={probe_reason or 'OTHER'}\n"
                        f"error={probe_error or 'Unknown'}\n",
                        encoding="utf-8",
                        errors="replace",
                    )
                except Exception:
                    pass

                norm = classify_runtime_failure(probe_reason or "OTHER", str(probe_error or ""))
                category = norm.get("category", "ENVIRONMENT_CORRUPT")
                action = norm.get("action", "")
                full_error = (
                    f"[{category}] Runtime probe failed before server launch.\n"
                    f"Model: {server_id}\n"
                    f"Reason: {probe_reason or 'OTHER'}\n"
                    f"Error: {probe_error or 'Unknown'}\n"
                    f"Startup log: {probe_log_path}\n"
                    f"Suggested action: {action}"
                )
                try:
                    self.state_store.upsert_onboarding(
                        model_id=onboarding_id,
                        base_model_path=str(model_path),
                        adapter_dir=adapter_dir,
                        env_key=env_spec.key,
                        status="BROKEN",
                        last_error=full_error[:2000],
                    )
                except Exception:
                    pass
                raise RuntimeError(full_error)

            # GPTQ-specific: prevent native crash by verifying auto-gptq CUDA kernels.
            # Runtime policy: DO NOT repair during chat startup. If preflight fails, mark BROKEN and instruct re-onboarding.
            use_exllamav2_gptq = False
            is_gptq_model = False
            try:
                is_gptq_model = (model_path / "quantize_config.json").exists()
            except Exception:
                is_gptq_model = False

            if is_gptq_model and not use_bundled_backend:
                ok, err = self.env_registry._verify_autogptq_cuda_kernels(env_spec.python_executable)
                if not ok:
                    from datetime import datetime
                    log_dir = app_root / "logs" / "server_startup"
                    log_dir.mkdir(parents=True, exist_ok=True)
                    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
                    safe_model_id = server_id.replace("/", "__").replace("\\", "__")
                    preflight_log_path = log_dir / f"{safe_model_id}_{timestamp}_gptq_preflight.log"
                    try:
                        preflight_log_path.write_text(
                            f"GPTQ preflight failed for env '{env_spec.key}'.\n\n{err}\n",
                            encoding="utf-8",
                            errors="replace",
                        )
                    except Exception:
                        pass

                    try:
                        self.state_store.upsert_onboarding(
                            model_id=onboarding_id,
                            base_model_path=str(model_path),
                            adapter_dir=adapter_dir,
                            env_key=env_spec.key,
                            status="BROKEN",
                            last_error=(
                                "GPTQ preflight failed: auto-gptq CUDA kernels are unavailable.\n"
                                f"Details: {err}\n"
                                f"Startup log: {preflight_log_path}"
                            )[:2000],
                        )
                    except Exception:
                        pass

                    raise RuntimeError(
                        "GPTQ cannot start: auto-gptq CUDA kernels are unavailable.\n"
                        f"Details: {err}\n"
                        "The model has been marked BROKEN. Please re-onboard/repair this model before chatting.\n"
                        f"Startup log: {preflight_log_path}"
                    )
            
            # Construct launcher script path
            launcher_script = app_root / "scripts" / "llm_server_start.py"
            
            if not launcher_script.exists():
                raise FileNotFoundError(f"Launcher script not found: {launcher_script}")
            
            # Launch server using environment's python
            log(f"Launching server: {env_spec.python_executable} {launcher_script} {model_id}")
            log(f"Working directory: {app_root}")
            
            # PHASE 1: Record server starting in StateStore
            from datetime import datetime
            logger.info("RUNTIME_EVENT startup_starting model_id=%s port=%s interpreter=%s", server_id, port, env_spec.python_executable)
            self.state_store.upsert_server(
                model_id=server_id,
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
            safe_model_id = server_id.replace("/", "__").replace("\\", "__")
            log_path = log_dir / f"{safe_model_id}_{timestamp}.log"
            
            # Open log file for writing (will be closed after startup completes or fails)
            log_file = open(log_path, 'w', encoding='utf-8', errors='replace')
            
            # Prepare Windows subprocess flags to hide CMD window
            # CRITICAL: Pass port via environment variable so auto-reassignment works
            env = os.environ.copy()
            env['SERVER_PORT'] = str(port)
            # Pin the intended model environment interpreter for launcher -> uvicorn handoff.
            env["LLM_SERVER_PYTHON"] = str(env_spec.python_executable)
            env["LLM_RUNTIME_BASE_MODEL"] = str(base_model)
            env["LLM_RUNTIME_MODEL_NAME"] = server_id
            if use_bundled_backend:
                env["LLM_RUNTIME_BACKEND"] = "llama_cpp_server"
            # If the onboarding row is a tuned__*__lora_gguf entry (a LoRA
            # adapter converted to GGUF format), wire the adapter file
            # through to the bundled proxy so llama-server starts with
            # `--lora <path>`. The proxy reads LORA_GGUF from env. Resolves
            # the .gguf file from adapter_dir; if multiple .gguf files
            # exist, picks the first matching `*-lora-*.gguf`, falling
            # back to any .gguf in the dir.
            if use_bundled_backend and is_gguf_model and adapter_dir:
                try:
                    from pathlib import Path as _Path
                    adir = _Path(str(adapter_dir))
                    if adir.is_dir():
                        lora_candidates = sorted(adir.glob("*-lora-*.gguf"))
                        if not lora_candidates:
                            lora_candidates = sorted(adir.glob("*.gguf"))
                        if lora_candidates:
                            env["LORA_GGUF"] = str(lora_candidates[0])
                            log(f"[lora] applying LoRA-GGUF: {lora_candidates[0]}")
                except Exception as _ex:
                    log(f"[lora] failed to resolve adapter GGUF: {_ex}")
            # Force server process to use the selected GPU (or highest-VRAM default)
            if chosen_gpu is not None:
                env["CUDA_DEVICE_ORDER"] = "PCI_BUS_ID"
                env["CUDA_VISIBLE_DEVICES"] = str(chosen_gpu)
                # Default GGUF backends to full-GPU offload. Without this,
                # llama-cpp-python loads weights into RAM and inference is so
                # slow Cline times out. setdefault so a power user can pin a
                # specific layer count via env without us clobbering it.
                env.setdefault("LLM_LLAMACPP_N_GPU_LAYERS", "-1")
                env.setdefault("LLM_BUNDLED_N_GPU_LAYERS", "-1")
            # Reduce CUDA allocator fragmentation issues.
            # NOTE: expandable_segments is not supported on Windows builds (PyTorch warns). Use max_split_size_mb instead.
            env.setdefault("PYTORCH_CUDA_ALLOC_CONF", "max_split_size_mb:128")
            if use_exllamav2_gptq:
                env["USE_EXLLAMAV2_GPTQ"] = "true"
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
            
            try:
                process = subprocess.Popen(
                    [str(env_spec.python_executable), 
                     str(launcher_script), 
                     model_id],
                    **subprocess_kwargs
                )
                # Store process with log file handle and path
                self.running_servers[server_id] = (process, log_file, str(log_path))
                log(f"Server process started with PID: {process.pid}")
                log(f"Startup logs being captured to: {log_path}")
                
                # PHASE 1: Update StateStore with PID
                self.state_store.upsert_server(
                    model_id=server_id,
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
                    model_id=server_id,
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
        self_heal_attempted = False  # One-shot startup self-heal for known fallback deps

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
                if server_id in self.running_servers:
                    _, log_file_handle, log_file_path = self.running_servers[server_id]
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
                                    match = re.search(r'No such file.*?([^\s]+\.(?:safetensors|bin|gguf))', log_text)
                                    if match:
                                        missing_file = match.group(1)
                                        raise RuntimeError(
                                            f"Model file missing: {missing_file}\n"
                                            f"Please re-onboard/repair this model (Downloaded Models tab), then retry.\n"
                                            f"Startup log: {log_file_path}"
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
                                        package_name = self._extract_package_from_importerror(error_msg)
                                        
                                        if package_name:
                                            raise RuntimeError(
                                                f"Model requires extra package '{package_name}' which is not installed in the current environment.\n"
                                                f"To fix this, please go to the Downloaded Models tab and click 'Isolation' for '{model_id}',\n"
                                                f"or re-run onboarding. This will create a dedicated isolated environment for this model."
                                            )
                                        else:
                                            # Generic ImportError - provide helpful context
                                            raise RuntimeError(
                                                f"ImportError in server: {error_msg[:500]}\n"
                                                f"This usually indicates a missing Python package in the model's environment.\n"
                                                f"Please re-onboard/repair this model (or click '🛡️ Isolation'), then retry.\n"
                                                f"Startup log: {log_file_path}"
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
                if server_id not in self.running_servers:
                    # Process was never started or was cleaned up
                    break
                process, _, _ = self.running_servers[server_id]
                if process.poll() is not None:
                    # Process died - read log file for error details
                    log_output = ""
                    log_file_path_for_user = None
                    if server_id in self.running_servers:
                        _, log_file_handle, log_file_path = self.running_servers[server_id]
                        log_file_path_for_user = log_file_path
                        
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
                        del self.running_servers[server_id]
                        # IMPORTANT: Do NOT delete the startup log on failure.
                        # Users need the full file to diagnose native crashes (e.g. 0xC0000005).
                    
                    # Recoverable race on Windows: another in-flight server may bind first.
                    # If startup log indicates bind conflict, probe /health and reuse that server.
                    log_lower = (log_output or "").lower()
                    bind_conflict_markers = (
                        "winerror 10048",
                        "[errno 10048]",
                        "address already in use",
                        "only one usage of each socket address",
                    )
                    if any(m in log_lower for m in bind_conflict_markers):
                        log(f"Detected port bind conflict on {port}; checking for existing server to reuse...")
                        for _ in range(3):
                            try:
                                reused_resp = requests.get(f"http://127.0.0.1:{port}/health", timeout=2)
                                if reused_resp.status_code == 200:
                                    reused_data = reused_resp.json()
                                    reused_model = str(reused_data.get("model", "")).strip()
                                    reused_status = str(reused_data.get("status", "")).lower().strip()
                                    if reused_model == server_id:
                                        log(
                                            f"Bind conflict recovered: reusing server on port {port} "
                                            f"(status={reused_status or 'unknown'}, model={reused_model or 'generic'})."
                                        )
                                        if reused_status == "ok":
                                            self.state_store.upsert_server(server_id, None, port, "RUNNING")
                                            return
                                        # loading/error/unknown: keep warmup loop alive and wait for next /health check
                                        port_has_our_server = True
                                        self.state_store.upsert_server(server_id, None, port, "STARTING")
                                        break
                            except Exception:
                                pass
                            time.sleep(1)
                        if port_has_our_server:
                            continue

                    # PHASE 1: Record failure in StateStore
                    self.state_store.upsert_server(
                        model_id=server_id,
                        pid=process.pid,
                        port=port,
                        status="FAILED",
                        stopped_at=datetime.utcnow().isoformat(),
                        last_error=(
                            f"Process died during startup (exit code {process.returncode}). "
                            f"Startup log: {log_file_path_for_user or 'N/A'}"
                        )[:500]
                    )
                    
                    # Use the actual command we launched (more reliable than re-deriving env info).
                    cmd = getattr(process, "args", None)
                    cmd_str = " ".join(str(x) for x in cmd) if isinstance(cmd, (list, tuple)) else str(cmd or "unknown")
                    python_info = "unknown"
                    script_info = "unknown"
                    try:
                        if isinstance(cmd, (list, tuple)) and len(cmd) >= 2:
                            python_info = str(cmd[0])
                            script_info = str(cmd[1])
                    except Exception:
                        pass
                    
                    hint = ""
                    if process.returncode == 3221225477:  # 0xC0000005 ACCESS_VIOLATION
                        log_lower = (log_output or "").lower()
                        if "gptq" in log_lower or "auto_gptq" in log_lower or "cuda extension not installed" in log_lower:
                            hint = (
                                "\n\nHINT: This crash (exit 0xC0000005) often occurs with GPTQ models when auto-gptq's "
                                "CUDA extension is not properly built. Please re-onboard/repair the model, then retry. "
                                "See the full startup log path above for details. If it keeps failing: use a non-GPTQ variant (BnB 4-bit or GGUF)."
                            )
                    error_msg = (
                        f"Server process for '{model_id}' died during startup.\n"
                        f"Exit code: {process.returncode}\n"
                        f"Port: {port}\n"
                        f"Python: {python_info}\n"
                        f"Script: {script_info}\n"
                        f"Command: {cmd_str}\n"
                        f"Startup log (full): {log_file_path_for_user or 'N/A'}\n"
                        f"\nServer output (tail):\n{log_output if log_output else '(no output captured)'}"
                        f"{hint}"
                    )
                    # If a model was previously marked READY but server dies during startup,
                    # it is effectively BROKEN until re-onboard/repair succeeds.
                    try:
                        broken_key = authoritative_onboarding_id if authoritative_onboarding_id is not None else self._resolve_onboarding_id(model_id, model_cfg=model_cfg)
                        row = self.state_store.get_onboarding(broken_key)
                        if not row and broken_key != model_id:
                            row = self.state_store.get_onboarding(model_id)
                            if row:
                                broken_key = model_id
                        base_path_for_row = (row or {}).get("base_model_path") or model_cfg.get("base_model", "") or ""
                        self.state_store.upsert_onboarding(
                            model_id=broken_key,
                            base_model_path=str(base_path_for_row),
                            status="BROKEN",
                            last_error=(f"Server process died during startup (exit {process.returncode}). "
                                        f"Startup log: {log_file_path_for_user or 'N/A'}")[:2000],
                        )
                    except Exception:
                        pass
                    logger.error(error_msg)
                    raise RuntimeError(error_msg)
            
            # Try health check (server may be up while model is still loading)
            # Use higher read timeout during warmup so slow /health during load does not fail
            try:
                response = requests.get(f"{server_url}/health", timeout=10)
                if response.status_code == 200:
                    try:
                        data = response.json()
                        status = str(data.get("status", "")).lower()
                        
                        # Check for error status
                        if status == "error":
                            error_msg = data.get("error", "Unknown error")
                            log(f"Server reports error status: {error_msg}")
                            
                            # Check for missing dependencies in /health error
                            if isinstance(error_msg, str) and "importerror" in error_msg.lower():
                                pkg = self._extract_package_from_importerror(error_msg)
                                if pkg:
                                    raise RuntimeError(
                                        f"Model requires extra package '{pkg}' which is not installed in the current environment.\n"
                                        f"To fix this, please go to the Downloaded Models tab and click 'Isolation' for '{model_id}',\n"
                                        f"or re-run onboarding. This will create a dedicated isolated environment for this model."
                                    )
                            
                            # Get model path for error message
                            model_path = model_cfg.get("base_model", "unknown")
                            log_path_for_error = None
                            if server_id in self.running_servers:
                                _, _, log_path_for_error = self.running_servers[server_id]
                            norm = classify_runtime_failure("OTHER", str(error_msg))
                            category = norm.get("category", "ENVIRONMENT_CORRUPT")
                            action = norm.get("action", "")
                            # BACKEND_INCOMPATIBLE_MODEL: do not attempt self-heal; return categorized error.
                            if category == "BACKEND_INCOMPATIBLE_MODEL":
                                remediation = (
                                    "This GGUF variant appears incompatible with available runtime backends.\n"
                                    "Try another GGUF quant/variant or a different backend format."
                                )
                                full_error = (
                                    f"Server failed to load model: {error_msg}\n"
                                    f"Check model files are complete in: {model_path}\n"
                                    f"{remediation}\n"
                                    f"Startup log: {log_path_for_error or 'N/A'}"
                                )
                                full_error = f"[{category}] {full_error}\nSuggested action: {action}"
                                try:
                                    broken_key = authoritative_onboarding_id if authoritative_onboarding_id is not None else self._resolve_onboarding_id(model_id, model_cfg=model_cfg)
                                    row = self.state_store.get_onboarding(broken_key)
                                    if not row and broken_key != model_id:
                                        row = self.state_store.get_onboarding(model_id)
                                        if row:
                                            broken_key = model_id
                                    base_path_for_row = (row or {}).get("base_model_path") or model_path
                                    self.state_store.upsert_onboarding(
                                        model_id=broken_key,
                                        base_model_path=str(base_path_for_row),
                                        status="BROKEN",
                                        last_error=(error_msg or full_error)[:500],
                                    )
                                except Exception:
                                    pass
                                raise RuntimeError(full_error)
                            # One-shot targeted self-heal for known missing fallback deps (tokenizer/transformers path).
                            if not self_heal_attempted and self._is_fallback_missing_health_error(str(error_msg)):
                                try:
                                    broken_key = authoritative_onboarding_id if authoritative_onboarding_id is not None else self._resolve_onboarding_id(model_id, model_cfg=model_cfg)
                                    row = self.state_store.get_onboarding(broken_key)
                                    if not row and broken_key != model_id:
                                        row = self.state_store.get_onboarding(model_id)
                                    base_model_path = (row or {}).get("base_model_path") or model_cfg.get("base_model") or ""
                                    fallback_adapter_dir = (
                                        (row or {}).get("adapter_dir")
                                        or (self.config.get("models", {}).get(model_id, {}) or {}).get("adapter_dir")
                                    )
                                    fallback_packages = get_runtime_fallback_packages(
                                        str(base_model_path),
                                        model_cfg=model_cfg,
                                        adapter_dir=fallback_adapter_dir,
                                        model_id=model_id,
                                    ) if base_model_path else []
                                    if fallback_packages and env_spec:
                                        self_heal_attempted = True
                                        log("One-shot startup self-heal: installing fallback packages (tokenizer/transformers path)...")
                                        low_err = str(error_msg or "").lower()
                                        ordered_fallbacks = list(fallback_packages)
                                        # For "sentencepiece or tiktoken" tokenizer errors, prefer wheel-friendly tiktoken first.
                                        if "sentencepiece or tiktoken" in low_err:
                                            # Install only the deps explicitly requested by tokenizer conversion path.
                                            # Do not force-install tokenizers here; slow tokenizer mode can proceed
                                            # with sentencepiece/tiktoken and keeps repair narrower.
                                            ordered_fallbacks = [
                                                p for p in ordered_fallbacks if p in ("tiktoken", "sentencepiece")
                                            ]
                                            if "tiktoken" not in ordered_fallbacks:
                                                ordered_fallbacks.insert(0, "tiktoken")
                                            elif ordered_fallbacks[0] != "tiktoken":
                                                ordered_fallbacks = ["tiktoken"] + [p for p in ordered_fallbacks if p != "tiktoken"]
                                        # Old llama.cpp metadata support: trigger runtime backend upgrade in-place.
                                        if (
                                            "yarn_log_multiplier" in low_err
                                            or "error loading model hyperparameters: key not found in model" in low_err
                                        ) and "llama-cpp-python" not in ordered_fallbacks:
                                            ordered_fallbacks.insert(0, "llama-cpp-python")

                                        installed_any = False
                                        install_failures: list[str] = []
                                        for pkg in ordered_fallbacks:
                                            ok_pkg, err_pkg = self.env_registry.auto_install_missing_packages(
                                                env_spec.python_executable,
                                                [pkg],
                                                log_callback=log,
                                            )
                                            if ok_pkg:
                                                installed_any = True
                                            else:
                                                install_failures.append(f"{pkg}: {(err_pkg or '')[:300]}")
                                                # Optional fallback deps are best-effort; keep trying others.
                                                continue

                                        if installed_any:
                                            # Restart server so it runs with updated env
                                            if server_id in self.running_servers:
                                                old_process, old_log_file, _ = self.running_servers[server_id]
                                                try:
                                                    if old_process and old_process.poll() is None:
                                                        old_process.kill()
                                                except Exception:
                                                    pass
                                                try:
                                                    if old_log_file:
                                                        old_log_file.flush()
                                                        old_log_file.close()
                                                except Exception:
                                                    pass
                                                del self.running_servers[server_id]
                                            log_dir = app_root / "logs" / "server_startup"
                                            log_dir.mkdir(parents=True, exist_ok=True)
                                            timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
                                            safe_model_id = server_id.replace("/", "__").replace("\\", "__")
                                            log_path2 = log_dir / f"{safe_model_id}_{timestamp}_selfheal.log"
                                            log_file2 = open(log_path2, "w", encoding="utf-8", errors="replace")
                                            env2 = os.environ.copy()
                                            env2["SERVER_PORT"] = str(port)
                                            env2["LLM_SERVER_PYTHON"] = str(env_spec.python_executable)
                                            env2["LLM_RUNTIME_BASE_MODEL"] = str(base_model)
                                            env2["LLM_RUNTIME_MODEL_NAME"] = server_id
                                            if chosen_gpu is not None:
                                                env2["CUDA_DEVICE_ORDER"] = "PCI_BUS_ID"
                                                env2["CUDA_VISIBLE_DEVICES"] = str(chosen_gpu)
                                                env2.setdefault("LLM_LLAMACPP_N_GPU_LAYERS", "-1")
                                                env2.setdefault("LLM_BUNDLED_N_GPU_LAYERS", "-1")
                                            env2.setdefault("PYTORCH_CUDA_ALLOC_CONF", "max_split_size_mb:128")
                                            if use_exllamav2_gptq:
                                                env2["USE_EXLLAMAV2_GPTQ"] = "true"
                                            subprocess_kwargs2 = {
                                                "cwd": str(app_root),
                                                "stdout": log_file2,
                                                "stderr": subprocess.STDOUT,
                                                "text": True,
                                                "encoding": "utf-8",
                                                "errors": "replace",
                                                "env": env2,
                                            }
                                            process2 = subprocess.Popen(
                                                [str(env_spec.python_executable), str(launcher_script), model_id],
                                                **subprocess_kwargs2,
                                            )
                                            self.running_servers[server_id] = (process2, log_file2, str(log_path2))
                                            process = process2
                                            self.state_store.upsert_server(
                                                model_id=server_id,
                                                pid=process2.pid,
                                                port=port,
                                                status="STARTING",
                                            )
                                            log("Server restarted after self-heal; re-checking health...")
                                            time.sleep(5)
                                            continue
                                        else:
                                            if install_failures:
                                                log(f"Self-heal install failed: {' | '.join(install_failures)[:500]}")
                                except Exception as heal_ex:
                                    log(f"Startup self-heal error: {heal_ex}")
                            # Categorized error: use action from classifier (no generic re-onboard loop).
                            if category == "MODEL_FILE_CORRUPT":
                                remediation = (
                                    "Model files may be incomplete/corrupt.\n"
                                    "Repair/redownload model files, then retry."
                                )
                            else:
                                remediation = action if action else "Repair environment or re-run onboarding for this model, then retry."
                            full_error = (
                                f"Server failed to load model: {error_msg}\n"
                                f"Check model files are complete in: {model_path}\n"
                                f"{remediation}\n"
                                f"Startup log: {log_path_for_error or 'N/A'}"
                            )
                            full_error = f"[{category}] {full_error}\nSuggested action: {action}"
                            try:
                                broken_key = authoritative_onboarding_id if authoritative_onboarding_id is not None else self._resolve_onboarding_id(model_id, model_cfg=model_cfg)
                                row = self.state_store.get_onboarding(broken_key)
                                if not row and broken_key != model_id:
                                    row = self.state_store.get_onboarding(model_id)
                                    if row:
                                        broken_key = model_id
                                base_path_for_row = (row or {}).get("base_model_path") or model_path
                                self.state_store.upsert_onboarding(
                                    model_id=broken_key,
                                    base_model_path=str(base_path_for_row),
                                    status="BROKEN",
                                    last_error=(error_msg or full_error)[:500],
                                )
                            except Exception:
                                pass
                            raise RuntimeError(full_error)
                        
                        if status == "ok":
                            elapsed = time.time() - start_time
                            log(f"Server is healthy at {server_url} (startup took {elapsed:.1f}s)")
                            logger.info(f"Server '{server_id}' is ready at {server_url} (took {elapsed:.1f}s)")
                            
                            # Close and clean up log file after successful startup
                            if server_id in self.running_servers:
                                _, log_file_handle, log_file_path = self.running_servers[server_id]
                                try:
                                    if log_file_handle:
                                        log_file_handle.flush()
                                        log_file_handle.close()
                                except Exception:
                                    pass
                                
                                # Delete log file unless debug mode keeps it (LLM_KEEP_SERVER_STARTUP_LOGS)
                                keep_logs = os.environ.get("LLM_KEEP_SERVER_STARTUP_LOGS", "").lower() in ("true", "1", "yes")
                                if not keep_logs:
                                    try:
                                        if log_file_path and os.path.exists(log_file_path):
                                            os.remove(log_file_path)
                                    except Exception:
                                        pass
                                else:
                                    logger.debug("Keeping server startup log (LLM_KEEP_SERVER_STARTUP_LOGS): %s", log_file_path)
                                
                                # Update to remove log file references (keep only process)
                                self.running_servers[server_id] = (process, None, None)
                            
                            # PHASE 1: Record success in StateStore
                            self.state_store.upsert_server(
                                model_id=server_id,
                                pid=process.pid,
                                port=port,
                                status="RUNNING"
                            )
                            return
                        # Still loading; keep waiting
                        last_error = f"Server up, model status={status}"
                    except Exception as e:
                        if isinstance(e, RuntimeError):
                            raise
                        # If JSON parsing fails, assume not ready yet.
                        last_error = "Server up, invalid /health JSON"
            except requests.exceptions.RequestException as e:
                last_error = str(e)
            except Exception as e:
                if isinstance(e, RuntimeError):
                    raise
                last_error = str(e)
            
            time.sleep(2)
        
        # Timeout reached - kill process and raise error
        logger.error(f"Server '{server_id}' failed to become healthy within {self.warmup_timeout}s")
        
        # Check if server is still in "loading" state
        server_status = "unknown"
        try:
            response = requests.get(f"{server_url}/health", timeout=10)
            if response.status_code == 200:
                data = response.json()
                server_status = str(data.get("status", "")).lower()
        except Exception:
            server_status = "not responding"
        
        # Read log file for error details
        log_output = ""
        log_path = None
        if server_id in self.running_servers:
            _, log_file_handle, log_file_path = self.running_servers[server_id]
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
        if not port_has_our_server and server_id in self.running_servers:
            process, _, _ = self.running_servers[server_id]
            try:
                process.kill()
                process.wait(timeout=5)
            except Exception:
                pass
        
        # Clean up (preserve startup log for diagnostics; user-facing errors reference log path)
        if server_id in self.running_servers:
            del self.running_servers[server_id]
            # Do not remove startup log on timeout/failure so users can inspect it

        # Build error message
        if log_output:
            output_text = log_output
        else:
            output_text = "(no output captured - process may have failed to start)"
        
        # Build error message based on server status
        if server_status == "loading":
            model_path_str = model_cfg.get("base_model", "unknown")
            error_msg = (
                f"Server stuck in 'loading' state for {self.warmup_timeout}s (slow-load or load failure).\n"
                f"This usually means:\n"
                f"  1. Model files are missing or incomplete\n"
                f"  2. GPU memory is insufficient\n"
                f"  3. Model loading encountered an error\n"
                f"  For large/vision models, try increasing LLM_SERVER_WARMUP_TIMEOUT.\n\n"
                f"Startup log: {log_path if log_path else 'N/A'}\n"
                f"Model path: {model_path_str}\n"
                f"Port: {port}\n"
                f"Last health check error: {last_error or 'Connection refused'}\n"
                f"\nServer output:\n{output_text}"
            )
        else:
            error_msg = (
                f"Server '{model_id}' failed to become healthy within {self.warmup_timeout}s.\n"
                f"Server status: {server_status} (possible crash or misconfiguration).\n"
                f"Startup log: {log_path if log_path else 'N/A'}\n"
                f"Port: {port}\n"
                f"Last health check error: {last_error or 'Connection refused'}\n"
                f"\nServer output:\n{output_text}"
            )
        logger.error(error_msg)
        # Deterministic state transition: STARTING -> FAILED on timeout
        try:
            self.state_store.upsert_server(
                model_id=server_id,
                pid=None,
                port=port,
                status="FAILED",
                last_error=(f"Server failed to become healthy within {self.warmup_timeout}s. "
                            f"Status: {server_status}. {last_error or 'N/A'}")[:500],
            )
        except Exception:
            pass
        # Mark onboarding BROKEN on warmup timeout; model is not usable until repaired/re-onboarded.
        try:
            broken_key = authoritative_onboarding_id if authoritative_onboarding_id is not None else self._resolve_onboarding_id(model_id, model_cfg=model_cfg)
            row = self.state_store.get_onboarding(broken_key)
            if not row and broken_key != model_id:
                row = self.state_store.get_onboarding(model_id)
                if row:
                    broken_key = model_id
            base_path_for_row = (row or {}).get("base_model_path") or model_cfg.get("base_model", "") or ""
            self.state_store.upsert_onboarding(
                model_id=broken_key,
                base_model_path=str(base_path_for_row),
                status="BROKEN",
                last_error=(f"Server failed to become healthy within {self.warmup_timeout}s. "
                            f"Status: {server_status}. Last health error: {last_error or 'N/A'}")[:2000],
            )
        except Exception:
            pass
        raise TimeoutError(error_msg)

    def _wait_for_health_ok(
        self,
        model_id: str,
        timeout_sec: float,
        log_callback=None,
        port: Optional[int] = None,
    ) -> None:
        """
        Poll /health until status is 'ok' or timeout.
        Uses a higher read timeout (10s) during warmup to avoid false failures while loading.
        Treats status 'loading' as expected and keeps waiting.
        """
        def log(msg):
            if log_callback:
                log_callback(msg)
            logger.info(msg)

        base_url = f"http://127.0.0.1:{port}" if port is not None else self._get_server_url(model_id)
        start = time.time()
        health_timeout = 10  # higher read timeout during warmup
        last_log = 0.0
        sleep_s = 1.5
        while time.time() - start < timeout_sec:
            try:
                response = requests.get(f"{base_url}/health", timeout=health_timeout)
                if response.status_code == 200:
                    data = response.json()
                    status = str(data.get("status", "")).lower().strip()
                    if status == "ok":
                        return
                    if status == "loading" and time.time() - last_log >= 10:
                        log(f"Server still loading... ({int(time.time() - start)}s elapsed)")
                        last_log = time.time()
            except requests.exceptions.RequestException:
                pass
            except Exception:
                pass
            time.sleep(sleep_s)
            sleep_s = min(8.0, sleep_s * 1.5)
        raise TimeoutError(
            f"Server for '{model_id}' did not become ready within {timeout_sec}s. "
            "Try freeing VRAM, switching GPU, or reducing max_new_tokens."
        )

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

    def _request_graceful_http_shutdown(
        self,
        server_id: str,
        port: Optional[int],
        process: Optional[subprocess.Popen] = None,
    ) -> bool:
        """
        Ask the server to shut itself down so app shutdown hooks can run.

        This is critical on Windows because Popen.terminate() is forceful there and does
        not give the bundled proxy a chance to stop its child llama-server.exe process.
        """
        try:
            port_i = int(port or 0)
        except Exception:
            port_i = 0
        if port_i <= 0:
            return False

        try:
            response = requests.post(f"http://127.0.0.1:{port_i}/shutdown", timeout=2)
            if response.status_code not in (200, 202):
                return False
        except Exception:
            return False

        deadline = time.time() + 5.0
        while time.time() < deadline:
            proc_dead = False
            if process is not None:
                try:
                    proc_dead = process.poll() is not None
                except Exception:
                    proc_dead = False
            if proc_dead or self._check_port_available(port_i):
                return True
            time.sleep(0.2)
        return False
    
    def shutdown_server(self, model_id: str, runtime_base_model: Optional[str] = None):
        """
        Shutdown server for given model.
        THREAD SAFE: Uses lock to prevent concurrent shutdown.
        
        Args:
            model_id: Model identifier
        """
        # THREAD SAFETY: Acquire lock for shutdown operation
        with self._server_lock:
            model_cfg = (self.config.get("models") or {}).get(model_id) if isinstance(self.config, dict) else None
            canonical_id = self._canonical_server_id(model_id)
            server_id = self._resolve_runtime_server_id(
                model_id=model_id,
                canonical_id=canonical_id,
                model_cfg=model_cfg,
                runtime_base_model=runtime_base_model,
            )
            try:
                server_state = self.state_store.get_server(server_id) or {}
            except Exception:
                server_state = {}
            state_port = server_state.get("port")

            if server_id in self.running_servers:
                process, log_file_handle, log_file_path = self.running_servers[server_id]
                
                # Close log file if still open
                try:
                    if log_file_handle:
                        log_file_handle.flush()
                        log_file_handle.close()
                except Exception:
                    pass
                
                logger.info(f"Shutting down server '{server_id}'")

                if self._request_graceful_http_shutdown(server_id, state_port, process=process):
                    logger.info(f"Server '{server_id}' exited via HTTP shutdown")
                else:
                    # Graceful shutdown with timeout
                    if process.poll() is None:  # Process is still running
                        process.terminate()
                        try:
                            process.wait(timeout=2)  # Wait 2 seconds for graceful shutdown
                            logger.info(f"Server '{server_id}' terminated gracefully")
                        except subprocess.TimeoutExpired:
                            # Force kill if graceful shutdown failed
                            logger.warning(f"Server '{server_id}' didn't terminate gracefully within 2s, force killing")
                            try:
                                process.kill()
                                process.wait(timeout=1)  # Wait briefly for kill to complete
                                logger.info(f"Server '{server_id}' force killed")
                            except subprocess.TimeoutExpired:
                                logger.error(f"Server '{server_id}' could not be killed")
                            except Exception as e:
                                logger.error(f"Error killing server '{server_id}': {e}")
                
                # Delete log file if it exists
                try:
                    if log_file_path and os.path.exists(log_file_path):
                        os.remove(log_file_path)
                except Exception:
                    pass
                
                del self.running_servers[server_id]
                
                # PHASE 1: Update StateStore
                from datetime import datetime
                self.state_store.upsert_server(
                    model_id=server_id,
                    pid=None,
                    port=0,  # Mark as stopped
                    status="STOPPED",
                    stopped_at=datetime.utcnow().isoformat()
                )
                return

            # Fallback: server may be running but NOT tracked in running_servers.
            # This happens when we "reuse" an already-running server found via /health.
            # In that case we still need a way to force-stop it (by PID or by port).
            pid = server_state.get("pid")
            port = server_state.get("port")

            logger.info(f"Shutting down untracked server '{server_id}' (pid={pid}, port={port})")

            if self._request_graceful_http_shutdown(server_id, port):
                logger.info(f"Untracked server '{server_id}' exited via HTTP shutdown")
                try:
                    from datetime import datetime
                    self.state_store.upsert_server(
                        model_id=server_id,
                        pid=None,
                        port=0,
                        status="STOPPED",
                        stopped_at=datetime.utcnow().isoformat()
                    )
                except Exception:
                    pass
                return

            # 1) Try killing by PID if known
            killed_any = False
            if pid:
                try:
                    if os.name == "nt":
                        subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, timeout=10, **self.subprocess_flags)
                    else:
                        try:
                            os.kill(int(pid), 15)
                        except Exception:
                            pass
                        try:
                            os.kill(int(pid), 9)
                        except Exception:
                            pass
                    killed_any = True
                    logger.info(f"Killed server PID {pid} for '{server_id}'")
                except Exception as e:
                    logger.warning(f"Failed to kill PID {pid} for '{server_id}': {e}")

            # 2) If PID missing (or kill failed), try killing by port (Windows only)
            if (not killed_any) and port and os.name == "nt":
                try:
                    result = subprocess.run(["netstat", "-ano"], capture_output=True, text=True, timeout=10, **self.subprocess_flags)
                    pids_to_kill: set[str] = set()
                    port_str = f":{int(port)}"
                    for line in (result.stdout or "").splitlines():
                        # Typical line: TCP    127.0.0.1:10500    0.0.0.0:0    LISTENING    12345
                        if ("LISTENING" in line) and (port_str in line):
                            parts = line.split()
                            if parts and parts[-1].isdigit():
                                pids_to_kill.add(parts[-1])
                    for found_pid in sorted(pids_to_kill):
                        subprocess.run(["taskkill", "/F", "/PID", found_pid], capture_output=True, timeout=10, **self.subprocess_flags)
                        logger.info(f"Killed PID {found_pid} on port {port} for '{server_id}'")
                        killed_any = True
                except Exception as e:
                    logger.warning(f"Failed to kill by port {port} for '{server_id}': {e}")

            # 3) Update StateStore regardless (best-effort)
            try:
                from datetime import datetime
                self.state_store.upsert_server(
                    model_id=server_id,
                    pid=None,
                    port=0,
                    status="STOPPED",
                    stopped_at=datetime.utcnow().isoformat()
                )
            except Exception:
                pass

    def shutdown_server_by_port(self, port: int) -> bool:
        """
        Force-stop whatever process is listening on the given port.
        Used when model_id is ambiguous (e.g. active list shows a server not in dropdown).
        Kills PIDs found on the port, then best-effort updates StateStore rows with that port to STOPPED.

        Returns:
            True if at least one PID was killed or no listener found; False on unexpected error.
        """
        if not port:
            return False
        port = int(port)
        with self._server_lock:
            killed_any = False
            if os.name == "nt":
                try:
                    result = subprocess.run(
                        ["netstat", "-ano"],
                        capture_output=True,
                        text=True,
                        timeout=10,
                        **self.subprocess_flags,
                    )
                    pids_to_kill: set[str] = set()
                    port_str = f":{port}"
                    for line in (result.stdout or "").splitlines():
                        if ("LISTENING" in line) and (port_str in line):
                            parts = line.split()
                            if parts and parts[-1].isdigit():
                                pids_to_kill.add(parts[-1])
                    for found_pid in sorted(pids_to_kill):
                        subprocess.run(
                            ["taskkill", "/F", "/PID", found_pid],
                            capture_output=True,
                            timeout=10,
                            **self.subprocess_flags,
                        )
                        logger.info(f"Killed PID {found_pid} on port {port} (stop-by-port)")
                        killed_any = True
                except Exception as e:
                    logger.warning(f"Failed to kill by port {port}: {e}")
                    return False
            else:
                # Unix: try common ways to find PIDs on port
                try:
                    result = subprocess.run(
                        ["lsof", "-ti", f":{port}"],
                        capture_output=True,
                        text=True,
                        timeout=10,
                        **self.subprocess_flags,
                    )
                    pids = (result.stdout or "").strip().split()
                    for pid in pids:
                        if pid.isdigit():
                            try:
                                os.kill(int(pid), 9)
                                killed_any = True
                                logger.info(f"Killed PID {pid} on port {port} (stop-by-port)")
                            except Exception:
                                pass
                except Exception as e:
                    logger.warning(f"Failed to kill by port {port}: {e}")
                    return False

            # Best-effort: mark any StateStore server row with this port as STOPPED
            try:
                for row in self.state_store.list_servers() or []:
                    if row.get("port") == port:
                        mid = row.get("model_id")
                        if mid:
                            self.state_store.upsert_server(
                                model_id=mid,
                                pid=None,
                                port=0,
                                status="STOPPED",
                                stopped_at=datetime.utcnow().isoformat(),
                            )
                            logger.debug(f"Marked server '{mid}' (port {port}) as STOPPED")
            except Exception as e:
                logger.warning(f"Failed to update StateStore for port {port}: {e}")

            return True

    def _force_kill_process_tree(self, process: subprocess.Popen, server_id: str) -> None:
        """
        Force-kill a server process and ALL of its descendants, then wait for
        the parent to exit. process.kill() only terminates the parent; native
        workers it spawned (e.g. llama-server.exe under a python proxy, or any
        in-process CUDA context that hasn't yet been reaped) keep holding GPU
        VRAM and break the next launch on the same GPU. taskkill /F /T walks
        the tree on Windows; killpg covers the POSIX case.
        """
        try:
            pid = process.pid
        except Exception:
            pid = None

        try:
            if pid is not None and os.name == "nt":
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(pid)],
                    capture_output=True,
                    timeout=10,
                    **self.subprocess_flags,
                )
            elif pid is not None:
                try:
                    os.killpg(os.getpgid(pid), 15)
                except Exception:
                    pass
                try:
                    os.killpg(os.getpgid(pid), 9)
                except Exception:
                    try:
                        process.kill()
                    except Exception:
                        pass
            else:
                try:
                    process.kill()
                except Exception:
                    pass
        except Exception as e:
            logger.warning(
                f"Tree-kill of PID {pid} for '{server_id}' failed: {e}; falling back to process.kill()"
            )
            try:
                process.kill()
            except Exception:
                pass

        # Block briefly so the OS finishes reaping the process and its CUDA
        # context before the caller tries to relaunch on the same GPU.
        try:
            process.wait(timeout=5)
        except Exception:
            pass

    def _kill_orphan_bundled_llama_servers(self) -> int:
        """
        Kill orphan llama-server.exe processes left behind by a previous run.

        Previously this used ``powershell.exe`` + ``Get-CimInstance`` to filter
        only processes whose ExecutablePath/CommandLine pointed at the bundled
        runtime under ``LLM/runtime/llama.cpp``. That powershell spawn was
        triggering ``0xc0000142`` (DLL init failed) error popups during app
        shutdown on some Windows boxes — undismissable modal dialogs.

        OWLLM has no legitimate reason to leave non-bundled llama-server.exe
        processes alive on its own machine, so the safer-and-simpler approach
        is ``taskkill /F /IM llama-server.exe /T``. It does not spawn
        powershell, has no DLL-init dependencies, and is idempotent.
        """
        if os.name != "nt":
            return 0
        try:
            result = subprocess.run(
                ["taskkill", "/F", "/IM", "llama-server.exe", "/T"],
                capture_output=True,
                text=True,
                timeout=10,
                **self.subprocess_flags,
            )
            # taskkill exits 128 if no matching process — treat as 0 killed.
            if result.returncode == 0:
                # stdout typically lists each killed PID; count "PID" tokens
                # for the log line.
                out = result.stdout or ""
                count = out.count("PID ") if "PID " in out else (1 if out.strip() else 0)
                return count
            return 0
        except Exception as e:
            logger.warning("Failed orphan llama-server cleanup: %s", e)
            return 0
    
    def shutdown_all(self):
        """Shutdown all running servers"""
        # NOTE: servers can be running but not tracked in running_servers (reused via /health).
        # Always consult StateStore as well so we can stop orphan/untracked processes.
        model_ids: set[str] = set(self.running_servers.keys())
        try:
            for st in ("RUNNING", "STARTING"):
                for row in (self.state_store.list_servers(status=st) or []):
                    mid = row.get("model_id")
                    if mid:
                        model_ids.add(str(mid))
        except Exception:
            pass

        if not model_ids:
            killed = self._kill_orphan_bundled_llama_servers()
            if killed:
                logger.info("Killed %s orphan bundled llama-server process(es)", killed)
            else:
                logger.info("No servers to shutdown")
            return

        logger.info(f"Shutting down all {len(model_ids)} server(s)")
        for model_id in sorted(model_ids):
            try:
                self.shutdown_server(model_id)
            except Exception as e:
                logger.error(f"Error shutting down server '{model_id}': {e}")
        killed = self._kill_orphan_bundled_llama_servers()
        if killed:
            logger.info("Killed %s orphan bundled llama-server process(es) after shutdown", killed)
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
