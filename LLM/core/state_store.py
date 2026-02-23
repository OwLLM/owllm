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
        self._run_migrations(conn)
        logger.info(f"StateStore initialized at {self.db_path}")
    
    def _run_migrations(self, conn: sqlite3.Connection):
        """Additive migrations only: new columns and indexes without breaking existing rows."""
        # Canonical identity columns (Phase 1)
        for table, column, col_type in [
            ("models", "canonical_model_id", "TEXT"),
            ("model_onboarding", "config_key", "TEXT"),
            ("model_onboarding", "model_fingerprint", "TEXT"),
        ]:
            info = conn.execute(f"PRAGMA table_info({table})").fetchall()
            names = [r[1] for r in info]
            if column not in names:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")
                logger.debug(f"StateStore migration: added {table}.{column}")
        conn.commit()
        # Indexes for canonical/config lookups
        for index_sql in [
            "CREATE INDEX IF NOT EXISTS idx_models_canonical_model_id ON models(canonical_model_id)",
            "CREATE INDEX IF NOT EXISTS idx_onboarding_config_key ON model_onboarding(config_key)",
            "CREATE INDEX IF NOT EXISTS idx_onboarding_model_fingerprint ON model_onboarding(model_fingerprint)",
        ]:
            try:
                conn.execute(index_sql)
            except sqlite3.OperationalError:
                pass
        conn.commit()
    
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
        config_key: Optional[str] = None,
        model_fingerprint: Optional[str] = None,
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
                model_id, base_model_path, adapter_dir, config_key, model_fingerprint, env_key, backend, accelerator,
                status, last_error, healthcheck_log_path, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(model_id) DO UPDATE SET
                base_model_path=excluded.base_model_path,
                adapter_dir=excluded.adapter_dir,
                config_key=excluded.config_key,
                model_fingerprint=excluded.model_fingerprint,
                env_key=excluded.env_key,
                backend=excluded.backend,
                accelerator=excluded.accelerator,
                status=excluded.status,
                last_error=excluded.last_error,
                healthcheck_log_path=excluded.healthcheck_log_path,
                updated_at=excluded.updated_at
        """, (model_id, base_model_path, adapter_dir, config_key, model_fingerprint, env_key, backend, accelerator,
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
    # INTEGRITY CHECKS (startup / preflight)
    # ========================================================================
    
    def run_integrity_checks(
        self,
        env_root: Optional[Path] = None,
        repair_safe: bool = True,
    ) -> Dict[str, Any]:
        """
        Read-only integrity pass: flag drift and optionally repair safe cases.
        No destructive deletes in phase 1; duplicates are reported for quarantine.
        
        Returns:
            report with keys: duplicate_onboarding, missing_env_for_ready,
            canonical_mismatch, repaired (list of actions), errors (list of str).
        """
        conn = self._get_connection()
        report: Dict[str, Any] = {
            "duplicate_onboarding": [],
            "duplicate_canonical": [],
            "missing_env_for_ready": [],
            "canonical_mismatch": [],
            "stale_building": [],
            "env_key_drift": [],
            "backend_drift": [],
            "repaired": [],
            "errors": [],
        }
        
        def norm(p: Optional[str]) -> str:
            if not p:
                return ""
            try:
                return str(Path(p).resolve()).lower()
            except Exception:
                return str(p).lower()
        
        # 1) Duplicate onboarding rows by base_model_path
        try:
            rows = conn.execute(
                "SELECT model_id, base_model_path FROM model_onboarding"
            ).fetchall()
            by_path: Dict[str, List[str]] = {}
            for row in rows:
                path_key = norm(row["base_model_path"])
                if path_key not in by_path:
                    by_path[path_key] = []
                by_path[path_key].append(row["model_id"])
            for path_key, model_ids in by_path.items():
                if len(model_ids) > 1:
                    report["duplicate_onboarding"].append({
                        "base_model_path": path_key,
                        "model_ids": model_ids,
                    })
        except Exception as e:
            report["errors"].append(f"duplicate_onboarding check: {e}")

        # 1b) Duplicate onboarding rows by canonical identity derived from path/key.
        try:
            from core.model_id_resolver import to_canonical_id
            rows = conn.execute(
                "SELECT model_id, base_model_path FROM model_onboarding"
            ).fetchall()
            by_canonical: Dict[str, List[str]] = {}
            for row in rows:
                mid = str(row["model_id"] or "")
                base = str(row["base_model_path"] or "")
                canonical = to_canonical_id(mid, model_cfg=None, base_model_path=base)
                by_canonical.setdefault(canonical, []).append(mid)
            for canonical_id, model_ids in by_canonical.items():
                uniq = sorted(set(model_ids))
                if len(uniq) > 1:
                    report["duplicate_canonical"].append(
                        {"canonical_id": canonical_id, "model_ids": uniq}
                    )
        except Exception as e:
            report["errors"].append(f"duplicate_canonical check: {e}")
        
        # 2) READY rows must have valid env at .envs/<env_key>/.venv
        if env_root is not None:
            try:
                env_root = Path(env_root)
                ready = conn.execute(
                    "SELECT model_id, env_key FROM model_onboarding WHERE status = ? AND env_key IS NOT NULL AND env_key != ''",
                    ("READY",),
                ).fetchall()
                for row in ready:
                    env_key = row["env_key"]
                    venv_dir = env_root / env_key / ".venv"
                    if not venv_dir.exists():
                        report["missing_env_for_ready"].append({
                            "model_id": row["model_id"],
                            "env_key": env_key,
                            "expected_path": str(venv_dir),
                        })
            except Exception as e:
                report["errors"].append(f"missing_env check: {e}")
        
        # 3) models.canonical_model_id mismatch (when column present and set)
        try:
            info = conn.execute("PRAGMA table_info(models)").fetchall()
            if any(r[1] == "canonical_model_id" for r in info):
                rows = conn.execute(
                    "SELECT model_id, canonical_model_id FROM models WHERE canonical_model_id IS NOT NULL AND canonical_model_id != '' AND canonical_model_id != model_id"
                ).fetchall()
                for row in rows:
                    report["canonical_mismatch"].append({
                        "model_id": row["model_id"],
                        "canonical_model_id": row["canonical_model_id"],
                    })
        except Exception as e:
            report["errors"].append(f"canonical_mismatch check: {e}")
        
        # 4) Safe repair: backfill models.canonical_model_id from model_path when possible.
        if repair_safe:
            try:
                from core.model_id_resolver import to_canonical_id
                info = conn.execute("PRAGMA table_info(models)").fetchall()
                if any(r[1] == "canonical_model_id" for r in info):
                    rows = conn.execute(
                        "SELECT model_id, model_path, canonical_model_id FROM models"
                    ).fetchall()
                    for row in rows:
                        if (row["canonical_model_id"] or "").strip():
                            continue
                        mid = str(row["model_id"] or "")
                        path = str(row["model_path"] or "")
                        canonical = to_canonical_id(mid, model_cfg=None, base_model_path=path)
                        conn.execute(
                            "UPDATE models SET canonical_model_id = ? WHERE model_id = ?",
                            (canonical or mid, mid),
                        )
                    conn.commit()
                    report["repaired"].append("backfill models.canonical_model_id from model_path")
            except Exception as e:
                report["errors"].append(f"repair canonical backfill: {e}")

            # 5) Safe repair: keep env_key consistent between model_onboarding (authoritative) and models.
            try:
                rows = conn.execute(
                    """
                    SELECT mo.model_id,
                           mo.env_key AS onboarding_env_key,
                           m.env_key AS model_env_key,
                           mo.backend AS onboarding_backend,
                           m.backend AS model_backend
                    FROM model_onboarding mo
                    LEFT JOIN models m ON m.model_id = mo.model_id
                    """
                ).fetchall()
                for row in rows:
                    mid = row["model_id"]
                    oenv = (row["onboarding_env_key"] or "").strip()
                    menv = (row["model_env_key"] or "").strip()
                    if oenv and menv and oenv != menv:
                        report["env_key_drift"].append({
                            "model_id": mid,
                            "onboarding_env_key": oenv,
                            "model_env_key": menv,
                        })
                        conn.execute("UPDATE models SET env_key = ? WHERE model_id = ?", (oenv, mid))
                        report["repaired"].append(f"sync models.env_key from onboarding for {mid}")
                    elif oenv and not menv:
                        conn.execute("UPDATE models SET env_key = ? WHERE model_id = ?", (oenv, mid))
                        report["repaired"].append(f"backfill models.env_key from onboarding for {mid}")
                    elif menv and not oenv:
                        conn.execute(
                            "UPDATE model_onboarding SET env_key = ?, updated_at = ? WHERE model_id = ?",
                            (menv, datetime.utcnow().isoformat(), mid),
                        )
                        report["repaired"].append(f"backfill onboarding.env_key from models for {mid}")
                    ob = (row["onboarding_backend"] or "").strip()
                    mb = (row["model_backend"] or "").strip()
                    if ob and mb and ob != mb:
                        report["backend_drift"].append(
                            {"model_id": mid, "onboarding_backend": ob, "model_backend": mb}
                        )
                        conn.execute("UPDATE models SET backend = ? WHERE model_id = ?", (ob, mid))
                        report["repaired"].append(f"sync models.backend from onboarding for {mid}")
                    elif ob and not mb:
                        conn.execute("UPDATE models SET backend = ? WHERE model_id = ?", (ob, mid))
                        report["repaired"].append(f"backfill models.backend from onboarding for {mid}")
                    elif mb and not ob:
                        conn.execute(
                            "UPDATE model_onboarding SET backend = ?, updated_at = ? WHERE model_id = ?",
                            (mb, datetime.utcnow().isoformat(), mid),
                        )
                        report["repaired"].append(f"backfill onboarding.backend from models for {mid}")
                conn.commit()
            except Exception as e:
                report["errors"].append(f"repair env_key drift/backfill: {e}")

            # 6) Safe repair: stale BUILDING rows older than threshold become BROKEN.
            try:
                stale_hours = 2
                stale_before = datetime.utcnow().timestamp() - (stale_hours * 3600)
                building = conn.execute(
                    "SELECT model_id, env_key, updated_at FROM model_onboarding WHERE status = 'BUILDING'"
                ).fetchall()
                for row in building:
                    updated_raw = row["updated_at"] or ""
                    try:
                        updated_ts = datetime.fromisoformat(updated_raw).timestamp()
                    except Exception:
                        updated_ts = 0.0
                    if updated_ts and updated_ts < stale_before:
                        mid = row["model_id"]
                        report["stale_building"].append({
                            "model_id": mid,
                            "updated_at": updated_raw,
                            "env_key": row["env_key"],
                        })
                        conn.execute(
                            """
                            UPDATE model_onboarding
                            SET status = 'BROKEN',
                                last_error = COALESCE(last_error, 'Stale BUILDING onboarding state auto-marked BROKEN at startup integrity check.'),
                                updated_at = ?
                            WHERE model_id = ?
                            """,
                            (datetime.utcnow().isoformat(), mid),
                        )
                        report["repaired"].append(f"mark stale BUILDING as BROKEN for {mid}")
                conn.commit()
            except Exception as e:
                report["errors"].append(f"repair stale BUILDING rows: {e}")
        
        return report
    
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
