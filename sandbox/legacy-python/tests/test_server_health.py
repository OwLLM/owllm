"""
PHASE 3: pytest test suite for server health checks.
"""
import pytest
import sys
import time
from pathlib import Path
from unittest.mock import patch

# Add LLM to path
llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))


@pytest.fixture
def config_path():
    """Get config path"""
    from core.inference import get_app_root
    return get_app_root() / "configs" / "llm_backends.yaml"


@pytest.fixture
def server_manager(config_path):
    """Get LLMServerManager instance"""
    from core.llm_server_manager import get_global_server_manager
    return get_global_server_manager()


def test_state_store_servers(server_manager):
    """Test StateStore server tracking"""
    from core.state_store import get_state_store
    
    state_store = get_state_store()
    servers = state_store.list_servers()
    
    # Should be able to query servers (even if empty)
    assert isinstance(servers, list)


def test_server_manager_config_load(server_manager):
    """Test that server manager loads config"""
    assert server_manager.config is not None
    assert "models" in server_manager.config
    assert isinstance(server_manager.config["models"], dict)


@pytest.mark.skipif(True, reason="Requires model to be configured")
def test_server_startup_lifecycle(server_manager):
    """Test full server lifecycle (requires configured model)"""
    # This test is skipped by default - enable manually for integration testing
    
    # Get first available model
    models = list(server_manager.config["models"].keys())
    if not models:
        pytest.skip("No models configured")
    
    model_id = models[0]
    
    try:
        # Start server
        server_manager.start_server(model_id)
        
        # Check it's running
        assert model_id in server_manager.running_servers
        
        # Health check
        health_ok = server_manager._check_health(model_id)
        assert health_ok, f"Server {model_id} failed health check"
        
        # Check StateStore
        from core.state_store import get_state_store
        state_store = get_state_store()
        server_state = state_store.get_server(model_id)
        
        assert server_state is not None
        assert server_state["status"] in ["RUNNING", "STARTING"]
        assert server_state["port"] > 0
        
    finally:
        # Cleanup
        server_manager.shutdown_server(model_id)


def test_port_allocation(server_manager):
    """Test port allocation logic"""
    # Test _find_free_port
    used_ports = {10500, 10501, 10502}
    free_port = server_manager._find_free_port(10500, used_ports=used_ports)
    
    assert free_port is not None
    assert free_port not in used_ports


def test_wait_for_health_ok_uses_adaptive_backoff(server_manager):
    """Polling sleep interval should grow while server reports loading."""
    sleeps = []
    fake_now = {"t": 0.0}

    class Resp:
        status_code = 200

        @staticmethod
        def json():
            return {"status": "loading", "model": "m"}

    def fake_get(*args, **kwargs):
        return Resp()

    def fake_sleep(seconds):
        sleeps.append(seconds)
        fake_now["t"] += seconds

    def fake_time():
        return fake_now["t"]

    with patch("core.llm_server_manager.requests.get", side_effect=fake_get), \
         patch("core.llm_server_manager.time.sleep", side_effect=fake_sleep), \
         patch("core.llm_server_manager.time.time", side_effect=fake_time):
        with pytest.raises(TimeoutError):
            server_manager._wait_for_health_ok("dummy", timeout_sec=8, port=65535)

    assert sleeps, "Expected polling sleeps to be recorded"
    assert max(sleeps) > min(sleeps), "Expected adaptive (increasing) backoff"


def test_cleanup_canonical_duplicate_server_rows_stops_duplicate_ports(server_manager, monkeypatch):
    """Duplicate canonical rows on different ports should be actively stopped."""
    candidates = [
        {"model_id": "deepseek-ai/deepseek-coder-6.7b-instruct", "port": 10516, "status": "RUNNING"},
        {"model_id": "deepseek-ai_deepseek-coder-6.7b-instruct", "port": 10500, "status": "RUNNING"},
    ]
    killed_ports = []
    upserts = []

    monkeypatch.setattr(
        server_manager,
        "_find_canonical_server_candidates",
        lambda canonical_id: candidates,
    )
    monkeypatch.setattr(
        server_manager,
        "shutdown_server_by_port",
        lambda port: killed_ports.append(int(port)) or True,
    )
    monkeypatch.setattr(
        server_manager.state_store,
        "upsert_server",
        lambda **kwargs: upserts.append(kwargs),
    )

    server_manager._cleanup_canonical_duplicate_server_rows(
        canonical_id="deepseek-ai/deepseek-coder-6.7b-instruct",
        keep_model_id="deepseek-ai/deepseek-coder-6.7b-instruct",
        keep_port=10516,
    )

    assert 10500 in killed_ports
    assert 10516 not in killed_ports
    assert any(
        str((u or {}).get("model_id") or "") == "deepseek-ai_deepseek-coder-6.7b-instruct"
        and str((u or {}).get("status") or "") == "STOPPED"
        for u in upserts
    )


def test_cleanup_orphan_canonical_ports_stops_config_alias_ports(server_manager, monkeypatch):
    server_manager.config = {
        "models": {
            "unsloth/gemma-2-2b-it-bnb-4bit": {"port": 10528},
            "unsloth_gemma-2-2b-it-bnb-4bit": {"port": 10500},
        }
    }
    monkeypatch.setattr(
        server_manager,
        "_canonical_server_id",
        lambda mid: "unsloth/gemma-2-2b-it-bnb-4bit",
    )
    stopped = []
    monkeypatch.setattr(server_manager, "shutdown_server_by_port", lambda p: stopped.append(int(p)) or True)

    class _Resp:
        status_code = 200
        def json(self):
            return {"status": "ok", "model": "unsloth/gemma-2-2b-it-bnb-4bit"}

    monkeypatch.setattr("core.llm_server_manager.requests.get", lambda *a, **k: _Resp())
    server_manager._cleanup_orphan_canonical_ports("unsloth/gemma-2-2b-it-bnb-4bit", keep_port=10528)
    assert 10500 in stopped


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
