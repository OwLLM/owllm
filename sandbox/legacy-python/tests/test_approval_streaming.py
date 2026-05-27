"""Tests for the streaming-approval features layered on ApprovalGate.

Three additions covered:

* Auto-approve / auto-reject rules — predicate-based shortcuts that
  resolve a request synchronously inside ``request()`` so the UI never
  sees the pending.
* Bulk resolution — ``resolve_matching(predicate, decision)`` decides
  every currently-pending approval that matches at once.
* Pending-count listener — fires with the new count whenever it
  changes (request lands, request resolves, bulk decision fires).

The existing single-request flow is intentionally left untouched and
re-covered by the older ``test_agent_tools.py::TestApprovalGate`` class.
"""
import sys
import threading
import time
from pathlib import Path

import pytest

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.agents.tools import (
    ApprovalDecision,
    ApprovalGate,
    ApprovalRequest,
    AutoApproveRule,
)


# ---------------------------------------------------------------------------
# Auto-approve rules
# ---------------------------------------------------------------------------


class TestAutoApproveRules:
    def test_matching_rule_resolves_synchronously(self):
        gate = ApprovalGate(default_timeout_seconds=10.0)
        gate.add_rule(AutoApproveRule(
            name="trust-pytest",
            predicate=lambda r: r.tool_name == "shell" and "pytest" in str(r.args.get("cmd", "")),
            decision=ApprovalDecision.APPROVE,
        ))
        # No listener installed — if the rule didn't fire, this would
        # block the full default timeout.
        t0 = time.monotonic()
        d = gate.request("coder", "shell", {"cmd": "pytest -x"}, "g1")
        elapsed = time.monotonic() - t0
        assert d == ApprovalDecision.APPROVE
        assert elapsed < 0.5  # synchronous, not gated
        # And no pending leaked into the queue.
        assert gate.pending_count() == 0

    def test_non_matching_rule_falls_through_to_block(self):
        gate = ApprovalGate(default_timeout_seconds=0.1)
        gate.add_rule(AutoApproveRule(
            name="trust-pytest",
            predicate=lambda r: "pytest" in str(r.args.get("cmd", "")),
            decision=ApprovalDecision.APPROVE,
        ))
        # 'rm -rf' doesn't match — falls through, hits the timeout.
        d = gate.request("coder", "shell", {"cmd": "rm -rf /tmp/x"}, "g1")
        assert d == ApprovalDecision.TIMEOUT

    def test_first_matching_rule_wins(self):
        gate = ApprovalGate()
        gate.add_rule(AutoApproveRule(
            name="approve-all-shell",
            predicate=lambda r: r.tool_name == "shell",
            decision=ApprovalDecision.APPROVE,
        ))
        gate.add_rule(AutoApproveRule(
            name="reject-rm",
            predicate=lambda r: "rm" in str(r.args.get("cmd", "")),
            decision=ApprovalDecision.REJECT,
        ))
        # First rule (broader) wins.
        d = gate.request("coder", "shell", {"cmd": "rm -rf x"}, "g")
        assert d == ApprovalDecision.APPROVE

    def test_auto_reject_works_too(self):
        gate = ApprovalGate(default_timeout_seconds=10.0)
        gate.add_rule(AutoApproveRule(
            name="block-system-paths",
            predicate=lambda r: r.tool_name == "edit_file" and str(r.args.get("path", "")).startswith("/etc"),
            decision=ApprovalDecision.REJECT,
            reason="system path off-limits",
        ))
        d = gate.request("coder", "edit_file", {"path": "/etc/hosts", "old_string": "x", "new_string": "y"}, "g")
        assert d == ApprovalDecision.REJECT

    def test_predicate_exception_treated_as_no_match(self):
        gate = ApprovalGate(default_timeout_seconds=0.1)
        def buggy(r):
            raise RuntimeError("boom")
        gate.add_rule(AutoApproveRule(
            name="buggy",
            predicate=buggy,
            decision=ApprovalDecision.APPROVE,
        ))
        # Buggy rule shouldn't approve — we time out instead.
        d = gate.request("coder", "shell", {"cmd": "ls"}, "g")
        assert d == ApprovalDecision.TIMEOUT

    def test_remove_rule_by_name(self):
        gate = ApprovalGate(default_timeout_seconds=0.1)
        gate.add_rule(AutoApproveRule(
            name="trust-pytest",
            predicate=lambda r: True,
            decision=ApprovalDecision.APPROVE,
        ))
        assert len(gate.list_rules()) == 1
        assert gate.remove_rule("trust-pytest") is True
        assert gate.list_rules() == []
        # Removing a missing rule reports False.
        assert gate.remove_rule("trust-pytest") is False

    def test_re_registering_same_name_replaces(self):
        gate = ApprovalGate()
        gate.add_rule(AutoApproveRule(
            name="x", predicate=lambda r: True, decision=ApprovalDecision.APPROVE,
        ))
        gate.add_rule(AutoApproveRule(
            name="x", predicate=lambda r: True, decision=ApprovalDecision.REJECT,
        ))
        rules = gate.list_rules()
        assert len(rules) == 1
        assert rules[0].decision == ApprovalDecision.REJECT

    def test_clear_rules(self):
        gate = ApprovalGate()
        gate.add_rule(AutoApproveRule(name="a", predicate=lambda r: True, decision=ApprovalDecision.APPROVE))
        gate.add_rule(AutoApproveRule(name="b", predicate=lambda r: True, decision=ApprovalDecision.APPROVE))
        gate.clear_rules()
        assert gate.list_rules() == []


# ---------------------------------------------------------------------------
# Bulk resolution
# ---------------------------------------------------------------------------


class TestResolveMatching:
    def _kick_off(self, gate: ApprovalGate, n: int, *, tool_name="shell") -> list:
        """Spawn ``n`` blocking request calls; returns the result-holder list."""
        holders: list = []
        threads = []
        for i in range(n):
            holder: dict = {}
            holders.append(holder)
            def caller(idx=i, h=holder):
                h["d"] = gate.request(
                    f"agent{idx}", tool_name, {"i": idx}, f"g{idx}",
                )
            t = threading.Thread(target=caller, daemon=True)
            t.start()
            threads.append(t)
        # Wait for all to have landed in pending.
        for _ in range(50):
            if gate.pending_count() == n:
                break
            time.sleep(0.01)
        return holders, threads

    def test_resolves_all_matching(self):
        gate = ApprovalGate(default_timeout_seconds=5.0)
        holders, threads = self._kick_off(gate, 3)
        resolved = gate.resolve_matching(
            predicate=lambda r: r.tool_name == "shell",
            decision=ApprovalDecision.APPROVE,
        )
        assert resolved == 3
        for t in threads:
            t.join(timeout=2)
        for h in holders:
            assert h.get("d") == ApprovalDecision.APPROVE

    def test_only_predicate_matches_resolved(self):
        gate = ApprovalGate(default_timeout_seconds=5.0)
        holders, threads = self._kick_off(gate, 4)
        # Resolve only the even-indexed ones.
        resolved = gate.resolve_matching(
            predicate=lambda r: r.args.get("i", 0) % 2 == 0,
            decision=ApprovalDecision.APPROVE,
        )
        assert resolved == 2
        # Even-indexed threads finished; odd-indexed still pending.
        for i, t in enumerate(threads):
            if i % 2 == 0:
                t.join(timeout=2)
                assert holders[i].get("d") == ApprovalDecision.APPROVE
        assert gate.pending_count() == 2

    def test_predicate_error_does_not_poison_batch(self):
        gate = ApprovalGate(default_timeout_seconds=5.0)
        holders, threads = self._kick_off(gate, 2)
        seen = []
        def predicate(r):
            seen.append(r.id)
            if len(seen) == 1:
                raise RuntimeError("first one explodes")
            return True
        resolved = gate.resolve_matching(predicate, ApprovalDecision.APPROVE)
        # The second pending was still resolved despite the first
        # predicate raising.
        assert resolved == 1


# ---------------------------------------------------------------------------
# Pending-count listener
# ---------------------------------------------------------------------------


class TestCountListener:
    def test_count_listener_fires_on_request_and_resolve(self):
        gate = ApprovalGate(default_timeout_seconds=5.0)
        events = []
        gate.add_count_listener(lambda n: events.append(n))

        # Kick off two requests in the background.
        threads = []
        for i in range(2):
            t = threading.Thread(
                target=lambda i=i: gate.request(f"a{i}", "shell", {}, f"g{i}"),
                daemon=True,
            )
            t.start()
            threads.append(t)

        for _ in range(50):
            if gate.pending_count() == 2:
                break
            time.sleep(0.01)

        # Should have seen 1, 2 (in some order, but monotonically rising).
        assert max(events) >= 2
        # Now resolve everything, count listener fires going down.
        gate.resolve_matching(predicate=lambda r: True, decision=ApprovalDecision.APPROVE)
        for t in threads:
            t.join(timeout=2)
        # Final count should be zero.
        assert events[-1] == 0
