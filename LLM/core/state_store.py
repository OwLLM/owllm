"""
StateStore - Single source of truth for OWLLM runtime state.

Stores model/env/server/port mappings in SQLite to eliminate config drift.
YAML becomes static config only; runtime state lives here.
"""
import sqlite3
import json
import threading
from pathlib import Path
from typing import Optional, Dict, List, Any
from datetime import datetime
import logging

logger = logging.getLogger(__name__)


class StateStore:
    """
    Persistent state store for OWLLM runtime state.
    
    Tables:
    - models: model_id, backend, model_path, env_key, params_json, created_at, updated_at
    - envs: env_key, python_path, torch_version, cuda_version, backend, constraints_hash, 
            status (CREATING/READY/FAILED), last_error, created_at, updated_at
    - servers: model_id, pid, port, status (STARTING/RUNNING/STOPPED/FAILED), 
               started_at, stopped_at, last_error
    - kv: key, value (optional key-value store)
    """
    
    def __init__(self, db_path: Path):
        """
        Initialize state store.
        
        Args:
            db_path: Path to SQLite database file
        """
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Thread-local connections for thread safety
        self._local = threading.local()
        
        # Initialize schema
        self._init_schema()
    
    def _get_connection(self) -> sqlite3.Connection:
        """Get thread-local database connection."""
        if not hasattr(self._local, 'conn'):
            self._local.conn = sqlite3.connect(
                str(self.db_path),
                check_same_thread=False,
                timeout=10.0
            )
            self._local.conn.row_factory = sqlite3.Row
            # Enable WAL mode for better concurrency
            self._local.conn.execute("PRAGMA journal_mode=WAL")
        return self._local.conn
    
    def _init_schema(self):
        """Initialize database schema if not exists."""
        conn = self._get_connection()
        
        # Models table
        conn.execute("""
            CREATE TABLE IF NOT EXISTS models (
                model_id TEXT PRIMARY KEY,
                backend TEXT NOT NULL,
                model_path TEXT NOT NULL,
                env_key TEXT,
                params_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        
        # Environments table
        conn.execute("""
            CREATE TABLE IF NOT EXISTS envs (
                env_key TEXT PRIMARY KEY,
                python_path TEXT,
                torch_version TEXT,
                cuda_version TEXT,
                backend TEXT,
                constraints_hash TEXT,
                status TEXT NOT NULL,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        
        # Servers table
        conn.execute("""
            CREATE TABLE IF NOT EXISTS servers (
                model_id TEXT PRIMARY KEY,
                pid INTEGER,
                port INTEGER NOT NULL,
                status TEXT NOT NULL,
                started_at TEXT,
                stopped_at TEXT,
                last_error TEXT,
                FOREIGN KEY (model_id) REFERENCES models(model_id)
            )
        """)
        
        # Key-value store (optional)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS kv (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at TEXT NOT NULL
            )
        """)
        
        # Model onboarding table
        conn.execute("""
            CREATE TABLE IF NOT EXISTS model_onboarding (
                model_id TEXT PRIMARY KEY,
                base_model_path TEXT NOT NULL,
                adapter_dir TEXT,
                env_key TEXT,
                backend TEXT,
                accelerator TEXT,
                status TEXT NOT NULL,
                last_error TEXT,
                healthcheck_log_path TEXT,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (model_id) REFERENCES models(model_id)
            )
        """)
        
        # Indexes for common queries
        conn.execute("CREATE INDEX IF NOT EXISTS idx_models_env_key ON models(env_key)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_servers_status ON servers(status)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_envs_status ON envs(status)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_onboarding_status ON model_onboarding(status)")
        
        conn.commit()
        logger.info(f"StateStore initialized at {self.db_path}")
    
    # ========================================================================
    # MODELS
    # ========================================================================
    
    def upsert_model(
        self,
        model_id: str,
        backend: str,
        model_path: str,
        env_key: Optional[str] = None,
        params: Optional[Dict[str, Any]] = None
    ):
        """
        Insert or update model entry.
        
        Args:
            model_id: Unique model identifier
            backend: Backend type (transformers, vllm, llamacpp, etc.)
            model_path: Path to model files
            env_key: Associated environment key (e.g., "torch-cu121-transformers-bnb")
            params: Additional parameters (dict will be stored as JSON)
        """
        conn = self._get_connection()
        now = datetime.utcnow().isoformat()
        params_json = json.dumps(params) if params else None
        
        conn.execute("""
            INSERT INTO models (model_id, backend, model_path, env_key, params_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(model_id) DO UPDATE SET
                backend=excluded.backend,
                model_path=excluded.model_path,
                env_key=excluded.env_key,
                params_json=excluded.params_json,
                updated_at=excluded.updated_at
        """, (model_id, backend, model_path, env_key, params_json, now, now))
        
        conn.commit()
        logger.debug(f"Upserted model: {model_id}")
    
    def get_model(self, model_id: str) -> Optional[Dict[str, Any]]:
        """Get model by ID."""
        conn = self._get_connection()
        row = conn.execute(
            "SELECT * FROM models WHERE model_id = ?",
            (model_id,)
        ).fetchone()
        
        if row:
            result = dict(row)
            # Parse JSON params
            if result.get('params_json'):
                result['params'] = json.loads(result['params_json'])
            return result
        return None
    
    def list_models(self) -> List[Dict[str, Any]]:
        """List all models."""
        conn = self._get_connection()
        rows = conn.execute("SELECT * FROM models ORDER BY model_id").fetchall()
        
        results = []
        for row in rows:
            result = dict(row)
            if result.get('params_json'):
                result['params'] = json.loads(result['params_json'])
            results.append(result)
        return results
    
    def delete_model(self, model_id: str):
        """Delete model entry."""
        conn = self._get_connection()
        conn.execute("DELETE FROM models WHERE model_id = ?", (model_id,))
        conn.commit()
        logger.debug(f"Deleted model: {model_id}")
    
    # ========================================================================
    # ENVIRONMENTS
    # ========================================================================
    
    def upsert_env(
        self,
        env_key: str,
        python_path: Optional[str] = None,
        torch_version: Optional[str] = None,
        cuda_version: Optional[str] = None,
        backend: Optional[str] = None,
        constraints_hash: Optional[str] = None,
        status: str = "CREATING",
        last_error: Optional[str] = None
    ):
        """
        Insert or update environment entry.
        
        Args:
            env_key: Environment key (e.g., "torch-cu121-transformers-bnb")
            python_path: Path to Python executable
            torch_version: PyTorch version string
            cuda_version: CUDA version string
            backend: Backend type
            constraints_hash: Hash of constraints file for reproducibility
            status: CREATING | READY | FAILED
            last_error: Error message if status=FAILED
        """
        conn = self._get_connection()
        now = datetime.utcnow().isoformat()
        
        conn.execute("""
            INSERT INTO envs (
                env_key, python_path, torch_version, cuda_version, backend, 
                constraints_hash, status, last_error, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(env_key) DO UPDATE SET
                python_path=excluded.python_path,
                torch_version=excluded.torch_version,
                cuda_version=excluded.cuda_version,
                backend=excluded.backend,
                constraints_hash=excluded.constraints_hash,
                status=excluded.status,
                last_error=excluded.last_error,
                updated_at=excluded.updated_at
        """, (env_key, python_path, torch_version, cuda_version, backend,
              constraints_hash, status, last_error, now, now))
        
        conn.commit()
        logger.debug(f"Upserted env: {env_key} (status={status})")
    
    def get_env(self, env_key: str) -> Optional[Dict[str, Any]]:
        """Get environment by key."""
        conn = self._get_connection()
        row = conn.execute(
            "SELECT * FROM envs WHERE env_key = ?",
            (env_key,)
        ).fetchone()
        
        return dict(row) if row else None
    
    def list_envs(self, status: Optional[str] = None) -> List[Dict[str, Any]]:
        """List environments, optionally filtered by status."""
        conn = self._get_connection()
        
        if status:
            rows = conn.execute(
                "SELECT * FROM envs WHERE status = ? ORDER BY env_key",
                (status,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM envs ORDER BY env_key").fetchall()
        
        return [dict(row) for row in rows]
    
    def delete_env(self, env_key: str):
        """Delete environment entry."""
        conn = self._get_connection()
        conn.execute("DELETE FROM envs WHERE env_key = ?", (env_key,))
        conn.commit()
        logger.debug(f"Deleted env: {env_key}")
    
    # ========================================================================
    # SERVERS
    # ========================================================================
    
    def upsert_server(
        self,
        model_id: str,
        pid: Optional[int],
        port: int,
        status: str,
        started_at: Optional[str] = None,
        stopped_at: Optional[str] = None,
        last_error: Optional[str] = None
    ):
        """
        Insert or update server entry.
        
        Args:
            model_id: Model identifier
            pid: Process ID
            port: Server port
            status: STARTING | RUNNING | STOPPED | FAILED
            started_at: ISO timestamp when started
            stopped_at: ISO timestamp when stopped
            last_error: Error message if status=FAILED
        """
        conn = self._get_connection()
        
        if started_at is None and status == "STARTING":
            started_at = datetime.utcnow().isoformat()
        
        conn.execute("""
            INSERT INTO servers (model_id, pid, port, status, started_at, stopped_at, last_error)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(model_id) DO UPDATE SET
                pid=excluded.pid,
                port=excluded.port,
                status=excluded.status,
                started_at=COALESCE(excluded.started_at, servers.started_at),
                stopped_at=excluded.stopped_at,
                last_error=excluded.last_error
        """, (model_id, pid, port, status, started_at, stopped_at, last_error))
        
        conn.commit()
        logger.debug(f"Upserted server: {model_id} port={port} status={status}")
    
    def get_server(self, model_id: str) -> Optional[Dict[str, Any]]:
        """Get server by model ID."""
        conn = self._get_connection()
        row = conn.execute(
            "SELECT * FROM servers WHERE model_id = ?",
            (model_id,)
        ).fetchone()
        
        return dict(row) if row else None
    
    def list_servers(self, status: Optional[str] = None) -> List[Dict[str, Any]]:
        """List servers, optionally filtered by status."""
        conn = self._get_connection()
        
        if status:
            rows = conn.execute(
                "SELECT * FROM servers WHERE status = ? ORDER BY model_id",
                (status,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM servers ORDER BY model_id").fetchall()
        
        return [dict(row) for row in rows]
    
    def delete_server(self, model_id: str):
        """Delete server entry."""
        conn = self._get_connection()
        conn.execute("DELETE FROM servers WHERE model_id = ?", (model_id,))
        conn.commit()
        logger.debug(f"Deleted server: {model_id}")
    
    # ========================================================================
    # KEY-VALUE STORE
    # ========================================================================
    
    def set_kv(self, key: str, value: Any):
        """Set a key-value pair."""
        conn = self._get_connection()
        now = datetime.utcnow().isoformat()
        value_json = json.dumps(value) if not isinstance(value, str) else value
        
        conn.execute("""
            INSERT INTO kv (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value=excluded.value,
                updated_at=excluded.updated_at
        """, (key, value_json, now))
        
        conn.commit()
    
    def get_kv(self, key: str, default: Any = None) -> Any:
        """Get a value by key."""
        conn = self._get_connection()
        row = conn.execute(
            "SELECT value FROM kv WHERE key = ?",
            (key,)
        ).fetchone()
        
        if row:
            try:
                return json.loads(row['value'])
            except:
                return row['value']
        return default
    
    def delete_kv(self, key: str):
        """Delete a key-value pair."""
        conn = self._get_connection()
        conn.execute("DELETE FROM kv WHERE key = ?", (key,))
        conn.commit()
    
    # ========================================================================
    # MODEL ONBOARDING
    # ========================================================================
    
    def upsert_onboarding(
        self,
        model_id: str,
        base_model_path: str,
        adapter_dir: Optional[str] = None,
        env_key: Optional[str] = None,
        backend: Optional[str] = None,
        accelerator: Optional[str] = None,
        status: str = "NEW",
        last_error: Optional[str] = None,
        healthcheck_log_path: Optional[str] = None
    ):
        """
        Insert or update model onboarding entry.
        
        Args:
            model_id: Unique model identifier
            base_model_path: Path to base model files
            adapter_dir: Optional adapter directory path
            env_key: Associated environment key
            backend: Backend type (tf, llamacpp, etc.)
            accelerator: Accelerator type (cu121, cpu, etc.)
            status: NEW | BUILDING | READY | BROKEN
            last_error: Error message if status=BROKEN
            healthcheck_log_path: Path to health check log file
        """
        conn = self._get_connection()
        now = datetime.utcnow().isoformat()
        
        conn.execute("""
            INSERT INTO model_onboarding (
                model_id, base_model_path, adapter_dir, env_key, backend, accelerator,
                status, last_error, healthcheck_log_path, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(model_id) DO UPDATE SET
                base_model_path=excluded.base_model_path,
                adapter_dir=excluded.adapter_dir,
                env_key=excluded.env_key,
                backend=excluded.backend,
                accelerator=excluded.accelerator,
                status=excluded.status,
                last_error=excluded.last_error,
                healthcheck_log_path=excluded.healthcheck_log_path,
                updated_at=excluded.updated_at
        """, (model_id, base_model_path, adapter_dir, env_key, backend, accelerator,
              status, last_error, healthcheck_log_path, now))
        
        conn.commit()
        logger.debug(f"Upserted onboarding: {model_id} (status={status})")
    
    def get_onboarding(self, model_id: str) -> Optional[Dict[str, Any]]:
        """Get onboarding entry by model ID."""
        conn = self._get_connection()
        row = conn.execute(
            "SELECT * FROM model_onboarding WHERE model_id = ?",
            (model_id,)
        ).fetchone()
        
        return dict(row) if row else None
    
    def list_onboarding_by_status(self, status: str) -> List[Dict[str, Any]]:
        """List onboarding entries filtered by status."""
        conn = self._get_connection()
        rows = conn.execute(
            "SELECT * FROM model_onboarding WHERE status = ? ORDER BY model_id",
            (status,)
        ).fetchall()
        
        return [dict(row) for row in rows]
    
    def list_all_onboarding(self) -> List[Dict[str, Any]]:
        """List all onboarding entries."""
        conn = self._get_connection()
        rows = conn.execute(
            "SELECT * FROM model_onboarding ORDER BY model_id"
        ).fetchall()
        
        return [dict(row) for row in rows]
    
    def list_onboarding_by_env_key(self, env_key: str) -> List[Dict[str, Any]]:
        """List all onboarding entries for a specific environment key."""
        conn = self._get_connection()
        rows = conn.execute(
            "SELECT * FROM model_onboarding WHERE env_key = ? ORDER BY model_id",
            (env_key,)
        ).fetchall()
        
        return [dict(row) for row in rows]
    
    def delete_onboarding(self, model_id: str):
        """Delete onboarding entry."""
        conn = self._get_connection()
        conn.execute("DELETE FROM model_onboarding WHERE model_id = ?", (model_id,))
        conn.commit()
        logger.debug(f"Deleted onboarding: {model_id}")
    
    # ========================================================================
    # UTILITIES
    # ========================================================================
    
    def close(self):
        """Close database connection."""
        if hasattr(self._local, 'conn'):
            self._local.conn.close()
            delattr(self._local, 'conn')


# Global instance (singleton pattern)
_store: Optional[StateStore] = None


def get_state_store(db_path: Optional[Path] = None) -> StateStore:
    """
    Get global StateStore instance.
    
    Args:
        db_path: Optional path to database (defaults to data/owllm_state.db)
    
    Returns:
        StateStore instance
    """
    global _store
    
    if _store is None:
        if db_path is None:
            from pathlib import Path
            # Default to LLM/data/owllm_state.db
            llm_root = Path(__file__).parent.parent
            db_path = llm_root / "data" / "owllm_state.db"
        
        _store = StateStore(db_path)
    
    return _store
