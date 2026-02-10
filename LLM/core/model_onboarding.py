"""
Model Onboarding Service
Handles model onboarding pipeline: requirement detection, env creation, health checks.
Separates onboarding from runtime to keep chat paths side-effect free.
"""
from pathlib import Path
from typing import Optional, Dict, Any, List
import logging
import tempfile
from datetime import datetime

from core.state_store import get_state_store
from core.envs.model_requirement_detector import detect_model_requirements
from core.envs.env_registry import EnvRegistry
from core.envs.capability_matrix import (
    get_runtime_required_packages,
    BASE_PACKAGES,
)
from model_integrity_checker import ModelIntegrityChecker

logger = logging.getLogger(__name__)


def _get_model_cfg(model_id: Optional[str]) -> Dict[str, Any]:
    """Load model config from llm_backends.yaml for parity with runtime capability resolution."""
    if not model_id:
        return {}
    try:
        from core.models import get_app_root
        import yaml
        config_path = get_app_root() / "configs" / "llm_backends.yaml"
        if not config_path.exists():
            return {}
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f)
        return (cfg or {}).get("models", {}).get(model_id, {}) or {}
    except Exception:
        return {}


def _get_gptq_backend_for_model(model_id: str) -> str:
    """Read gptq_backend from llm_backends.yaml for a model. Default: auto-gptq."""
    try:
        from pathlib import Path
        from core.models import get_app_root
        import yaml
        config_path = get_app_root() / "configs" / "llm_backends.yaml"
        if not config_path.exists():
            return "auto-gptq"
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f)
        model_cfg = (cfg or {}).get("models", {}).get(model_id, {})
        return "exllamav2" if model_cfg.get("gptq_backend") == "exllamav2" else "auto-gptq"
    except Exception:
        return "auto-gptq"


def _get_required_packages_for_requirements(req: Dict[str, Any], model_id: Optional[str] = None) -> List[str]:
    """
    Map model requirements to required Python packages.
    
    Args:
        req: Requirements dict from detect_model_requirements
        model_id: Optional model ID to check gptq_backend preference in config
        
    Returns:
        List of required package names
    """
    packages = []
    quantization = req.get("quantization", "none")
    
    if quantization == "gptq":
        gptq_backend = _get_gptq_backend_for_model(model_id or "") if model_id else "auto-gptq"
        if gptq_backend == "exllamav2":
            packages.append("exllamav2")
        else:
            packages.extend(["optimum", "auto-gptq"])
    elif quantization == "awq":
        # AWQ models require autoawq or awq
        packages.append("autoawq")
    # bnb quantization is handled by the base stack
    # gguf models use llamacpp backend, not Python packages
    
    return packages


class ModelOnboardingService:
    """Service for onboarding models (env creation, validation)"""
    
    def __init__(self):
        self.state_store = get_state_store()
        self.env_registry = EnvRegistry()
    
    def ensure_model_onboarded(
        self,
        model_id: str,
        base_model_path: str,
        adapter_dir: Optional[str] = None,
        profile_data: Optional[dict] = None,
        log_callback=None,
        allow_repair: bool = True
    ) -> Dict[str, Any]:
        """
        Run full onboarding pipeline for a model.
        
        Args:
            model_id: Unique model identifier
            base_model_path: Path to base model files
            adapter_dir: Optional adapter directory
            profile_data: Hardware profile data (if None, auto-detected)
            log_callback: Optional function to call with log messages
            allow_repair: If True, attempt one repair if health check fails
        
        Returns:
            Dict with onboarding result:
            - status: READY | BROKEN
            - env_key: Resolved environment key
            - backend: Backend type
            - accelerator: Accelerator type
            - last_error: Error message if BROKEN
            - healthcheck_log_path: Path to health check log
        """
        def log(msg):
            if log_callback:
                log_callback(msg)
            logger.info(msg)
        
        # Set status to BUILDING
        self.state_store.upsert_onboarding(
            model_id=model_id,
            base_model_path=base_model_path,
            adapter_dir=adapter_dir,
            status="BUILDING"
        )
        
        try:
            # Get profile data if not provided
            if profile_data is None:
                profile_data = self.env_registry._get_active_profile_data()
                if not profile_data:
                    raise RuntimeError("Could not determine hardware profile")
            
            # Step 1: Detect model requirements
            log(f"Detecting requirements for model: {model_id}")
            req = detect_model_requirements(base_model_path, adapter_dir)
            log(f"Detected requirements: {req}")
            
            # Step 2: Resolve stable env_key (pure, no side effects; use capability matrix for parity with runtime)
            model_cfg = _get_model_cfg(model_id)
            stable_env_key, accelerator, backend = self.env_registry.resolve_env_for_model(
                base_model_path,
                adapter_dir,
                profile_data,
                tier="stable",
                model_cfg=model_cfg,
                model_id=model_id,
            )
            log(f"Resolved stable env_key: {stable_env_key} (backend={backend}, accelerator={accelerator})")
            
            # Step 3: Ensure stable environment exists (creates if missing)
            log(f"Ensuring stable environment exists: {stable_env_key}")
            stable_env_spec = self.env_registry.ensure_env_exists(stable_env_key, profile_data, log_callback=log_callback)
            stable_python_exe = stable_env_spec.python_executable
            
            # Step 4: Run health check on stable env
            log(f"Running health check for stable env: {stable_env_key}")
            health_result, log_path = self.env_registry.run_env_health_check(
                stable_env_key,
                profile_data,
                log_callback=log_callback
            )
            
            # Step 5: Handle health check failure with optional repair
            if health_result.returncode != 0:
                log(f"Health check failed for {stable_env_key}")
                
                if allow_repair:
                    log("Attempting one-time repair...")
                    try:
                        self.env_registry.repair_env_once(stable_env_key, profile_data, log_callback=log_callback)
                        
                        # Re-run health check after repair
                        log("Re-running health check after repair...")
                        health_result, log_path = self.env_registry.run_env_health_check(
                            stable_env_key,
                            profile_data,
                            log_callback=log_callback
                        )
                    except Exception as repair_error:
                        log(f"Repair attempt failed: {repair_error}")
                
                # If still failing, mark as BROKEN
                if health_result.returncode != 0:
                    error_msg = self._format_health_check_error(health_result)
                    log(f"Model onboarding failed: {error_msg}")
                    
                    self.state_store.upsert_onboarding(
                        model_id=model_id,
                        base_model_path=base_model_path,
                        adapter_dir=adapter_dir,
                        env_key=stable_env_key,
                        backend=backend,
                        accelerator=accelerator,
                        status="BROKEN",
                        last_error=error_msg,
                        healthcheck_log_path=log_path
                    )
                    
                    return {
                        "status": "BROKEN",
                        "env_key": stable_env_key,
                        "backend": backend,
                        "accelerator": accelerator,
                        "last_error": error_msg,
                        "healthcheck_log_path": log_path
                    }
            
            # Step 6: Run model load probe on stable env
            log(f"Running model load probe on stable env: {stable_env_key}")
            probe_success, probe_reason, probe_error = self.env_registry.run_model_load_probe(
                stable_python_exe,
                base_model_path,
                adapter_dir,
                log_callback=log_callback
            )
            
            final_env_key = stable_env_key
            final_python_exe = stable_python_exe
            
            # Step 7a: MISSING_PACKAGE - attempt one-time auto-install of optional deps (Pillow/timm/einops), then re-probe
            if not probe_success and probe_reason == "MISSING_PACKAGE":
                packages_to_install = self._parse_missing_packages_for_repair(probe_error)
                if allow_repair and packages_to_install:
                    log(f"Attempting auto-install of missing packages: {', '.join(packages_to_install)}")
                    install_ok, install_err = self.env_registry.auto_install_missing_packages(
                        stable_python_exe,
                        packages_to_install,
                        log_callback=log_callback
                    )
                    if install_ok:
                        log("Re-running model load probe after auto-install...")
                        probe_success, probe_reason, probe_error = self.env_registry.run_model_load_probe(
                            stable_python_exe,
                            base_model_path,
                            adapter_dir,
                            log_callback=log_callback
                        )
                        if probe_success:
                            log("Model load probe passed after auto-install")
                if not probe_success and probe_reason == "MISSING_PACKAGE":
                    error_msg = self._format_probe_missing_package_error(probe_error, log_path)
                    log(f"Model onboarding failed (missing package): {error_msg[:300]}")
                    self.state_store.upsert_onboarding(
                        model_id=model_id,
                        base_model_path=base_model_path,
                        adapter_dir=adapter_dir,
                        env_key=stable_env_key,
                        backend=backend,
                        accelerator=accelerator,
                        status="BROKEN",
                        last_error=error_msg,
                        healthcheck_log_path=log_path
                    )
                    return {
                        "status": "BROKEN",
                        "env_key": stable_env_key,
                        "backend": backend,
                        "accelerator": accelerator,
                        "last_error": error_msg,
                        "healthcheck_log_path": log_path
                    }
            # Step 7b: UNSUPPORTED_ARCH - try edge env fallback (newer transformers, etc.)
            if not probe_success and probe_reason == "UNSUPPORTED_ARCH":
                log(f"Model load probe failed: {probe_reason} - {probe_error[:200]}")
                log("Attempting edge environment fallback...")
                try:
                    edge_env_key, _, _ = self.env_registry.resolve_env_for_model(
                        base_model_path,
                        adapter_dir,
                        profile_data,
                        tier="edge",
                        model_cfg=model_cfg,
                        model_id=model_id,
                    )
                    self.env_registry._create_or_upgrade_edge_env(
                        stable_env_key,
                        profile_data,
                        log_callback=log_callback
                    )
                    edge_env_spec = self.env_registry.ensure_env_exists(edge_env_key, profile_data, log_callback=log_callback)
                    edge_python_exe = edge_env_spec.python_executable
                    log("Installing transformers from GitHub source for unsupported architecture...")
                    self.env_registry._upgrade_edge_env_for_unsupported_arch(edge_python_exe, log_callback=log_callback)
                    # Re-run probe on edge env
                    log(f"Running model load probe on edge env: {edge_env_key}")
                    edge_probe_success, edge_probe_reason, edge_probe_error = self.env_registry.run_model_load_probe(
                        edge_python_exe,
                        base_model_path,
                        adapter_dir,
                        log_callback=log_callback
                    )
                    
                    if edge_probe_success:
                        log(f"Model load probe passed on edge env: {edge_env_key}")
                        final_env_key = edge_env_key
                        final_python_exe = edge_python_exe
                    else:
                        # Edge env also failed
                        error_msg = f"Model load failed on both stable and edge environments. Last error ({edge_probe_reason}): {edge_probe_error[:500]}"
                        log(f"Model onboarding failed: {error_msg}")
                        
                        self.state_store.upsert_onboarding(
                            model_id=model_id,
                            base_model_path=base_model_path,
                            adapter_dir=adapter_dir,
                            env_key=edge_env_key,
                            backend=backend,
                            accelerator=accelerator,
                            status="BROKEN",
                            last_error=error_msg,
                            healthcheck_log_path=log_path
                        )
                        
                        return {
                            "status": "BROKEN",
                            "env_key": edge_env_key,
                            "backend": backend,
                            "accelerator": accelerator,
                            "last_error": error_msg,
                            "healthcheck_log_path": log_path
                        }
                except Exception as edge_error:
                    log(f"Edge environment fallback failed: {edge_error}")
                    error_msg = f"Stable env probe failed ({probe_reason}), edge fallback failed: {str(edge_error)[:500]}"
                    
                    self.state_store.upsert_onboarding(
                        model_id=model_id,
                        base_model_path=base_model_path,
                        adapter_dir=adapter_dir,
                        env_key=stable_env_key,
                        backend=backend,
                        accelerator=accelerator,
                        status="BROKEN",
                        last_error=error_msg,
                        healthcheck_log_path=log_path
                    )
                    
                    return {
                        "status": "BROKEN",
                        "env_key": stable_env_key,
                        "backend": backend,
                        "accelerator": accelerator,
                        "last_error": error_msg,
                        "healthcheck_log_path": log_path
                    }
            elif not probe_success:
                # Probe failed with non-upgradeable reason
                error_msg = f"Model load probe failed ({probe_reason}): {probe_error[:500]}"
                log(f"Model onboarding failed: {error_msg}")
                
                self.state_store.upsert_onboarding(
                    model_id=model_id,
                    base_model_path=base_model_path,
                    adapter_dir=adapter_dir,
                    env_key=stable_env_key,
                    backend=backend,
                    accelerator=accelerator,
                    status="BROKEN",
                    last_error=error_msg,
                    healthcheck_log_path=log_path
                )
                
                return {
                    "status": "BROKEN",
                    "env_key": stable_env_key,
                    "backend": backend,
                    "accelerator": accelerator,
                    "last_error": error_msg,
                    "healthcheck_log_path": log_path
                }
            else:
                log(f"Model load probe passed on stable env: {stable_env_key}")
            
            # Step 8: Run shard-complete integrity check
            log(f"Running shard-complete integrity check for model: {model_id}")
            integrity_checker = ModelIntegrityChecker()
            integrity_status = integrity_checker.check_model(Path(base_model_path))
            
            if not integrity_status.is_complete:
                error_msg = f"Model integrity check failed. Missing: {', '.join(integrity_status.missing_files)}"
                log(f"Model onboarding failed: {error_msg}")
                
                self.state_store.upsert_onboarding(
                    model_id=model_id,
                    base_model_path=base_model_path,
                    adapter_dir=adapter_dir,
                    env_key=final_env_key,
                    backend=backend,
                    accelerator=accelerator,
                    status="BROKEN",
                    last_error=error_msg,
                    healthcheck_log_path=log_path
                )
                
                return {
                    "status": "BROKEN",
                    "env_key": final_env_key,
                    "backend": backend,
                    "accelerator": accelerator,
                    "last_error": error_msg,
                    "healthcheck_log_path": log_path
                }
            
            log(f"Shard-complete integrity check passed")
            
            # Step 9: Check for model-specific extra dependencies (universal capability matrix)
            log(f"Checking for model-specific extra dependencies")
            required_packages = get_runtime_required_packages(
                base_model_path,
                model_cfg=model_cfg,
                adapter_dir=adapter_dir,
                model_id=model_id,
            )
            extra_packages = [p for p in required_packages if p not in BASE_PACKAGES]
            
            if extra_packages:
                log(f"Model requires extra packages: {extra_packages}")
                log(f"Enforcing per-model isolation for extra dependencies.")
                
                # Resolve dedicated env key
                dedicated_env_key = self.env_registry.env_key_resolver.resolve_dedicated_env_key(final_env_key, model_id)
                log(f"Resolved dedicated env_key: {dedicated_env_key}")
                
                # Create dedicated env by copying the current final env (stable or edge).
                # For GPTQ (auto-gptq): creates fresh with Python 3.11 instead of copying.
                try:
                    self.env_registry._create_dedicated_env(
                        dedicated_env_key,
                        final_env_key,
                        profile_data,
                        log_callback=log_callback,
                        required_packages=extra_packages,
                    )
                    # Update final env to the dedicated one
                    final_env_key = dedicated_env_key
                    final_python_exe = self.env_registry._get_env_python_executable(final_env_key)
                    if not final_python_exe or not final_python_exe.exists():
                        raise RuntimeError(f"Dedicated environment Python not found: {final_python_exe}")
                except Exception as dedicated_error:
                    log(f"Failed to create dedicated environment: {dedicated_error}")
                    error_msg = f"Failed to create isolated environment for model-specific dependencies: {dedicated_error}"
                    
                    self.state_store.upsert_onboarding(
                        model_id=model_id,
                        base_model_path=base_model_path,
                        adapter_dir=adapter_dir,
                        env_key=final_env_key,
                        backend=backend,
                        accelerator=accelerator,
                        status="BROKEN",
                        last_error=error_msg,
                        healthcheck_log_path=log_path
                    )
                    
                    return {
                        "status": "BROKEN",
                        "env_key": final_env_key,
                        "backend": backend,
                        "accelerator": accelerator,
                        "last_error": error_msg,
                        "healthcheck_log_path": log_path
                    }

                # Step 10: Run dependency probe (install model-specific packages into dedicated env)
                log(f"Installing required packages into dedicated environment: {extra_packages}")
                missing_packages = self.env_registry.check_missing_packages(
                    final_python_exe,
                    extra_packages
                )
                
                if missing_packages:
                    log(f"Missing packages detected in dedicated env: {missing_packages}. Installing...")
                    install_success, install_error = self.env_registry.auto_install_missing_packages(
                        final_python_exe,
                        missing_packages,
                        log_callback=log_callback
                    )
                    
                    if not install_success:
                        error_msg = f"Failed to install required packages in dedicated environment: {', '.join(missing_packages)}\n\nDetailed error:\n{install_error}"
                        log(f"Model onboarding failed: {error_msg}")
                        
                        self.state_store.upsert_onboarding(
                            model_id=model_id,
                            base_model_path=base_model_path,
                            adapter_dir=adapter_dir,
                            env_key=final_env_key,
                            backend=backend,
                            accelerator=accelerator,
                            status="BROKEN",
                            last_error=error_msg,
                            healthcheck_log_path=log_path
                        )
                        
                        return {
                            "status": "BROKEN",
                            "env_key": final_env_key,
                            "backend": backend,
                            "accelerator": accelerator,
                            "last_error": error_msg,
                            "healthcheck_log_path": log_path
                        }
                    
                    # Re-verify packages after installation
                    still_missing = self.env_registry.check_missing_packages(
                        final_python_exe,
                        missing_packages
                    )
                    
                    if still_missing:
                        error_msg = f"Packages still missing after installation in dedicated env: {', '.join(still_missing)}"
                        log(f"Model onboarding failed: {error_msg}")
                        
                        self.state_store.upsert_onboarding(
                            model_id=model_id,
                            base_model_path=base_model_path,
                            adapter_dir=adapter_dir,
                            env_key=final_env_key,
                            backend=backend,
                            accelerator=accelerator,
                            status="BROKEN",
                            last_error=error_msg,
                            healthcheck_log_path=log_path
                        )
                        
                        return {
                            "status": "BROKEN",
                            "env_key": final_env_key,
                            "backend": backend,
                            "accelerator": accelerator,
                            "last_error": error_msg,
                            "healthcheck_log_path": log_path
                        }
                    
                    log(f"Successfully installed and verified packages in dedicated env: {missing_packages}")
                else:
                    log(f"All required packages already present in dedicated env: {extra_packages}")
                    # GPTQ: verify CUDA kernels when auto-gptq was pre-installed (no install = no verification in auto_install)
                    if "auto-gptq" in extra_packages:
                        log("Verifying auto-gptq CUDA kernels...")
                        verify_ok, verify_err = self.env_registry._verify_autogptq_cuda_kernels(final_python_exe)
                        if not verify_ok:
                            error_msg = f"auto-gptq CUDA kernels failed verification. Model startup would crash (0xC0000005). {verify_err}"
                            log(f"Model onboarding failed: {error_msg}")
                            self.state_store.upsert_onboarding(
                                model_id=model_id,
                                base_model_path=base_model_path,
                                adapter_dir=adapter_dir,
                                env_key=final_env_key,
                                backend=backend,
                                accelerator=accelerator,
                                status="BROKEN",
                                last_error=error_msg,
                                healthcheck_log_path=log_path
                            )
                            return {
                                "status": "BROKEN",
                                "env_key": final_env_key,
                                "backend": backend,
                                "accelerator": accelerator,
                                "last_error": error_msg,
                                "healthcheck_log_path": log_path
                            }
                        log("auto-gptq CUDA extension verified OK")
            else:
                log(f"No model-specific packages required (shared environment is sufficient)")
            
            # Success: mark as READY (all checks passed)
            log(f"Model {model_id} successfully onboarded (env: {final_env_key})")
            self.state_store.upsert_onboarding(
                model_id=model_id,
                base_model_path=base_model_path,
                adapter_dir=adapter_dir,
                env_key=final_env_key,
                backend=backend,
                accelerator=accelerator,
                status="READY",
                healthcheck_log_path=log_path
            )

            # Keep models table in sync (model_onboarding.env_key is authoritative; models.env_key is legacy mirror)
            try:
                self.state_store.upsert_model(
                    model_id=model_id,
                    backend=backend,
                    model_path=str(base_model_path),
                    env_key=final_env_key,
                    params=None
                )
            except Exception as e:
                log(f"[WARN] Could not upsert model env association: {e}")
            
            return {
                "status": "READY",
                "env_key": final_env_key,
                "backend": backend,
                "accelerator": accelerator,
                "healthcheck_log_path": log_path
            }
            
        except Exception as e:
            error_msg = str(e)
            log(f"Onboarding failed with exception: {error_msg}")
            
            self.state_store.upsert_onboarding(
                model_id=model_id,
                base_model_path=base_model_path,
                adapter_dir=adapter_dir,
                status="BROKEN",
                last_error=error_msg
            )
            
            return {
                "status": "BROKEN",
                "last_error": error_msg
            }
    
    def list_ready_models(self) -> List[Dict[str, Any]]:
        """List all models with status=READY."""
        return self.state_store.list_onboarding_by_status("READY")
    
    def list_unready_models(self) -> List[Dict[str, Any]]:
        """List all models with status != READY."""
        all_models = self.state_store.list_all_onboarding()
        return [m for m in all_models if m.get("status") != "READY"]
    
    def get_onboarding_status(self, model_id: str) -> Optional[str]:
        """Get onboarding status for a model."""
        entry = self.state_store.get_onboarding(model_id)
        return entry.get("status") if entry else None
    
    def _format_health_check_error(self, result) -> str:
        """Format health check error message."""
        stdout = (result.stdout or "").strip()
        stderr = (result.stderr or "").strip()
        return f"Health check failed (returncode={result.returncode})\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}"

    def _parse_missing_packages_for_repair(self, probe_error: str) -> List[str]:
        """
        Parse probe error for missing module/package names and return pip package names to install.
        Maps import names to pip names (e.g. PIL -> Pillow). Used for one-time auto-repair.
        """
        import re
        err_full = (probe_error or "").strip()
        # Map known import/module names (and common bad hints) to correct pip packages
        # NOTE: Some probes/logs may incorrectly suggest `pip install PIL` (there is no such PyPI package).
        module_to_pip = {"PIL": "Pillow", "timm": "timm", "einops": "einops"}

        # Extract pip package name from "Install with: pip install X" (probe emits this)
        pip_from_hint: List[str] = []
        for m in re.finditer(r"pip install\s+([A-Za-z0-9_.\-]+)", err_full):
            raw = m.group(1).strip()
            # Normalize common bad hints to real pip names (case-insensitive)
            pip_from_hint.append(module_to_pip.get(raw, module_to_pip.get(raw.upper(), raw)))
        # Extract module names from "No module named 'X'"
        module_names: List[str] = []
        for m in re.finditer(r"No module named\s+['\"]([^'\"]+)['\"]", err_full):
            module_names.append(m.group(1).strip())
        # Map known module names to pip package names
        pip_names = []
        for mod in module_names:
            pip_names.append(module_to_pip.get(mod, module_to_pip.get(mod.upper(), mod)))
        # Combine and de-dup, prefer pip hint when present
        seen = set()
        out = []
        for p in pip_from_hint + pip_names:
            if p and p not in seen:
                seen.add(p)
                out.append(p)
        return out

    def _format_probe_missing_package_error(self, probe_error: str, log_path: Optional[str] = None) -> str:
        """Format BROKEN error when onboarding probe fails with MISSING_PACKAGE (actionable message)."""
        import re

        err_full = (probe_error or "").strip()
        err = err_full[:1500]

        # Normalize common missing-module names to actual pip packages for display clarity
        normalize = {"PIL": "Pillow"}

        # Best-effort extraction of missing module/package names
        missing: list[str] = []
        try:
            patterns = [
                r"No module named ['\"]([^'\"]+)['\"]",
                r"Missing optional dependency.*?:\s*pip install ([A-Za-z0-9_.\\-]+)",
                r"requires ['\"]([^'\"]+)['\"] package",
            ]
            for pat in patterns:
                missing.extend(re.findall(pat, err_full))
        except Exception:
            missing = []
        # De-dup while preserving order
        seen = set()
        missing = [m for m in missing if m and not (m in seen or seen.add(m))]
        # Normalize display names (e.g. PIL -> Pillow)
        missing = [normalize.get(m, normalize.get(m.upper(), m)) for m in missing]

        missing_line = ""
        if missing:
            missing_line = "Missing module(s): " + ", ".join(missing[:10]) + "\n\n"

        log_line = f"\n\nOnboarding log: {log_path}" if log_path else ""
        return (
            "Onboarding probe failed during model compatibility check: one or more required packages are missing.\n\n"
            + missing_line +
            "Details:\n" + err + "\n\n"
            "Next step: Install the missing package(s) into the model environment, then Repair or Re-onboard this model from the Models tab."
            + log_line
        )


# Global instance
_onboarding_service: Optional[ModelOnboardingService] = None


def get_onboarding_service() -> ModelOnboardingService:
    """Get global ModelOnboardingService instance."""
    global _onboarding_service
    if _onboarding_service is None:
        _onboarding_service = ModelOnboardingService()
    return _onboarding_service
