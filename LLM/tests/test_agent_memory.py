"""Tests for ``core.agents.memory.MemoryStore``.

Cover write/read, FTS5 ranking, project scoping, and the empty-input
no-ops.
"""
import sys
from pathlib import Path

import pytest

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.agents.memory import (
    KIND_COMPLETED_GOAL,
    KIND_NOTE,
    Memory,
    MemoryStore,
)


@pytest.fixture
def store(tmp_path):
    return MemoryStore(tmp_path / "memory.sqlite")


class TestRememberAndRecall:
    def test_remember_returns_row_id(self, store):
        rid = store.remember(1, "the cat sat on the mat")
        assert rid > 0

    def test_recall_finds_inserted(self, store):
        store.remember(1, "the build tool we use is uv, not pip")
        hits = store.recall(1, "uv build tool")
        assert len(hits) == 1
        assert "uv" in hits[0].body
        assert hits[0].kind == KIND_NOTE

    def test_empty_body_is_dropped(self, store):
        rid = store.remember(1, "")
        assert rid == 0
        rid = store.remember(1, "   ")
        assert rid == 0

    def test_empty_query_returns_empty(self, store):
        store.remember(1, "something to find")
        assert store.recall(1, "") == []

    def test_recall_ranks_by_relevance(self, store):
        store.remember(1, "alpha banana gamma")
        store.remember(1, "banana banana banana")
        store.remember(1, "alpha gamma delta")
        hits = store.recall(1, "banana", limit=5)
        # The row with three "banana" mentions should rank first.
        assert hits[0].body == "banana banana banana"

    def test_limit_caps_results(self, store):
        for i in range(10):
            store.remember(1, f"keyword_x note number {i}")
        hits = store.recall(1, "keyword_x", limit=3)
        assert len(hits) == 3


class TestProjectScoping:
    def test_recall_does_not_cross_projects(self, store):
        store.remember(1, "project one secret")
        store.remember(2, "project two unrelated")
        hits = store.recall(1, "secret")
        assert len(hits) == 1
        assert hits[0].project_id == 1
        assert "one" in hits[0].body

    def test_count_per_project(self, store):
        store.remember(1, "p1 a")
        store.remember(1, "p1 b")
        store.remember(2, "p2 only")
        assert store.count(1) == 2
        assert store.count(2) == 1
        assert store.count(99) == 0


class TestKindAndMetadata:
    def test_kind_is_recorded(self, store):
        rid = store.remember(1, "solved the build hang", kind=KIND_COMPLETED_GOAL)
        m = store.get(rid)
        assert m is not None
        assert m.kind == KIND_COMPLETED_GOAL

    def test_list_recent_orders_newest_first(self, store):
        a = store.remember(1, "older note")
        b = store.remember(1, "newer note")
        recent = store.list_recent(1, limit=10)
        assert [m.id for m in recent] == [b, a]

    def test_recall_updates_last_used_at(self, store):
        rid = store.remember(1, "the answer is 42")
        before = store.get(rid)
        assert before is not None
        assert before.last_used_at is None
        store.recall(1, "answer")
        after = store.get(rid)
        assert after is not None
        assert after.last_used_at is not None


class TestPersistence:
    def test_data_survives_store_reopen(self, tmp_path):
        path = tmp_path / "memory.sqlite"
        s1 = MemoryStore(path)
        s1.remember(1, "preserved across restarts")
        s2 = MemoryStore(path)
        hits = s2.recall(1, "preserved")
        assert len(hits) == 1
        assert "preserved" in hits[0].body


class TestFtsEdgeCases:
    def test_quotes_in_query_are_escaped(self, store):
        # FTS5 syntax like NEAR() or ' " ' must not trip the recall call.
        store.remember(1, 'the user said "hello world"')
        hits = store.recall(1, 'said "hello')
        assert len(hits) >= 1

    def test_special_fts_keywords_dont_crash(self, store):
        store.remember(1, "near and far apart")
        # Bare 'NEAR' is FTS5 syntax — our wrap quotes the query so this
        # should be treated as a literal.
        hits = store.recall(1, "near")
        assert len(hits) == 1
