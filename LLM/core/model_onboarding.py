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

logger = logging.getLogger(__name__)


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
            
            # Step 2: Resolve env_key (pure, no side effects)
            env_key, accelerator, backend = self.env_registry.resolve_env_for_model(
                base_model_path,
                adapter_dir,
                profile_data
            )
            log(f"Resolved env_key: {env_key} (backend={backend}, accelerator={accelerator})")
            
            # Step 3: Ensure environment exists (creates if missing)
            log(f"Ensuring environment exists: {env_key}")
            self.env_registry.ensure_env_exists(env_key, profile_data, log_callback=log_callback)
            
            # Step 4: Run health check
            log(f"Running health check for env: {env_key}")
            health_result, log_path = self.env_registry.run_env_health_check(
                env_key,
                profile_data,
                log_callback=log_callback
            )
            
            # Step 5: Handle health check failure with optional repair
            if health_result.returncode != 0:
                log(f"Health check failed for {env_key}")
                
                if allow_repair:
                    log("Attempting one-time repair...")
                    try:
                        self.env_registry.repair_env_once(env_key, profile_data, log_callback=log_callback)
                        
                        # Re-run health check after repair
                        log("Re-running health check after repair...")
                        health_result, log_path = self.env_registry.run_env_health_check(
                            env_key,
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
                        env_key=env_key,
                        backend=backend,
                        accelerator=accelerator,
                        status="BROKEN",
                        last_error=error_msg,
                        healthcheck_log_path=log_path
                    )
                    
                    return {
                        "status": "BROKEN",
                        "env_key": env_key,
                        "backend": backend,
                        "accelerator": accelerator,
                        "last_error": error_msg,
                        "healthcheck_log_path": log_path
                    }
            
            # Success: mark as READY
            log(f"Model {model_id} successfully onboarded (env: {env_key})")
            self.state_store.upsert_onboarding(
                model_id=model_id,
                base_model_path=base_model_path,
                adapter_dir=adapter_dir,
                env_key=env_key,
                backend=backend,
                accelerator=accelerator,
                status="READY",
                healthcheck_log_path=log_path
            )

            # Keep models table in sync (some UI/flows read env_key from here)
            try:
                self.state_store.upsert_model(
                    model_id=model_id,
                    backend=backend,
                    model_path=str(base_model_path),
                    env_key=env_key,
                    params_json=None
                )
            except Exception as e:
                log(f"[WARN] Could not upsert model env association: {e}")
            
            return {
                "status": "READY",
                "env_key": env_key,
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


# Global instance
_onboarding_service: Optional[ModelOnboardingService] = None


def get_onboarding_service() -> ModelOnboardingService:
    """Get global ModelOnboardingService instance."""
    global _onboarding_service
    if _onboarding_service is None:
        _onboarding_service = ModelOnboardingService()
    return _onboarding_service
