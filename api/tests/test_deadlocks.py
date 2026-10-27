"""Unit tests for the deadlocks engine (Banker's + wait-for graph).

Run from the repository root with:

    python -m unittest discover -s api/tests -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

# Make ``app`` importable when the tests are run from the repository root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engines import deadlocks  # noqa: E402


def classic_banker_payload() -> dict:
    """The textbook three-resource, five-process safe state."""
    return {
        "mode": "banker",
        "processes": ["P0", "P1", "P2", "P3", "P4"],
        "resources": [
            {"id": "A", "total": 10},
            {"id": "B", "total": 5},
            {"id": "C", "total": 7},
        ],
        "allocation": {
            "P0": {"A": 0, "B": 1, "C": 0},
            "P1": {"A": 2, "B": 0, "C": 0},
            "P2": {"A": 3, "B": 0, "C": 2},
            "P3": {"A": 2, "B": 1, "C": 1},
            "P4": {"A": 0, "B": 0, "C": 2},
        },
        "max": {
            "P0": {"A": 7, "B": 5, "C": 3},
            "P1": {"A": 3, "B": 2, "C": 2},
            "P2": {"A": 9, "B": 0, "C": 2},
            "P3": {"A": 2, "B": 2, "C": 2},
            "P4": {"A": 4, "B": 3, "C": 3},
        },
        "available": {"A": 3, "B": 3, "C": 2},
    }


def detection_payload(with_cycle: bool) -> dict:
    """Two single-instance resources; P1 releases R1 only when idle."""
    return {
        "mode": "detection",
        "processes": ["P0", "P1"],
        "resources": [
            {"id": "R0", "total": 1},
            {"id": "R1", "total": 1},
        ],
        "allocation": {"P0": {"R0": 1, "R1": 0}, "P1": {"R0": 0, "R1": 1}},
        "max": {
            "P0": {"R0": 1, "R1": 1},
            "P1": {"R0": 1, "R1": 1} if with_cycle else {"R0": 0, "R1": 1},
        },
        "available": {"R0": 0, "R1": 0},
    }


class DeadlocksValidationTests(unittest.TestCase):
    def test_classic_payload_is_valid(self) -> None:
        self.assertEqual(deadlocks.validate(classic_banker_payload()), [])

    def test_allocation_above_max_is_rejected(self) -> None:
        payload = {
            "mode": "banker",
            "processes": ["P0"],
            "resources": [{"id": "R", "total": 5}],
            "allocation": {"P0": {"R": 4}},
            "max": {"P0": {"R": 2}},
            "available": {"R": 1},
        }
        errors = deadlocks.validate(payload)
        self.assertTrue(any("exceeds max" in error for error in errors))

    def test_over_committed_available_is_rejected(self) -> None:
        payload = {
            "mode": "banker",
            "processes": ["P0"],
            "resources": [{"id": "R", "total": 5}],
            "allocation": {"P0": {"R": 4}},
            "max": {"P0": {"R": 5}},
            "available": {"R": 2},
        }
        errors = deadlocks.validate(payload)
        self.assertTrue(any("exceeds total" in error for error in errors))

    def test_unknown_resource_is_rejected(self) -> None:
        payload = classic_banker_payload()
        payload["available"]["Z"] = 0
        errors = deadlocks.validate(payload)
        self.assertTrue(any("unknown resource 'Z'" in error for error in errors))


class BankerEngineTests(unittest.TestCase):
    def test_classic_state_is_safe(self) -> None:
        result = deadlocks.run(classic_banker_payload()).model_dump()
        metrics = result["metrics"]
        self.assertTrue(metrics["safe"])
        self.assertFalse(metrics["deadlock"])
        self.assertEqual(sorted(metrics["safe_sequence"]), ["P0", "P1", "P2", "P3", "P4"])
        self.assertEqual(metrics["finished_processes"], metrics["safe_sequence"])

    def test_progress_steps_report_only_finished_processes(self) -> None:
        result = deadlocks.run(classic_banker_payload()).model_dump()
        first_progress = result["steps"][1]["state"]
        self.assertEqual(first_progress["phase"], "safety-check")
        self.assertEqual(first_progress["finished"], ["P1"])
        self.assertNotIn("P0", first_progress["finished"])
        self.assertIn("P0", first_progress["unfinished"])
        self.assertEqual(first_progress["released"], {"A": 2, "B": 0, "C": 0})

    def test_final_step_is_a_complete_verdict(self) -> None:
        result = deadlocks.run(classic_banker_payload()).model_dump()
        last_state = result["steps"][-1]["state"]
        self.assertEqual(last_state["phase"], "complete")
        self.assertEqual(last_state["finished"], result["metrics"]["safe_sequence"])
        self.assertEqual(last_state["unfinished"], [])

    def test_unsafe_state_gets_a_stuck_verdict(self) -> None:
        payload = {
            "mode": "banker",
            "processes": ["P0", "P1"],
            "resources": [{"id": "R", "total": 10}],
            "allocation": {"P0": {"R": 6}, "P1": {"R": 4}},
            "max": {"P0": {"R": 10}, "P1": {"R": 10}},
            "available": {"R": 0},
        }
        self.assertEqual(deadlocks.validate(payload), [])
        result = deadlocks.run(payload).model_dump()
        self.assertFalse(result["metrics"]["safe"])
        self.assertEqual(result["metrics"]["unfinished_processes"], ["P0", "P1"])
        last_state = result["steps"][-1]["state"]
        self.assertEqual(last_state["phase"], "stuck")
        self.assertEqual(last_state["unfinished"], ["P0", "P1"])
        self.assertTrue(result["warnings"])


class DetectionEngineTests(unittest.TestCase):
    def test_cycle_is_detected(self) -> None:
        payload = detection_payload(with_cycle=True)
        self.assertEqual(deadlocks.validate(payload), [])
        result = deadlocks.run(payload).model_dump()
        self.assertTrue(result["metrics"]["deadlock"])
        self.assertEqual(result["metrics"]["deadlock_cycle"], ["P0", "P1", "P0"])
        self.assertEqual(sorted(result["metrics"]["waiting_processes"]), ["P0", "P1"])
        self.assertEqual(len(result["metrics"]["wait_edges"]), 2)

    def test_no_cycle_when_one_process_is_not_waiting(self) -> None:
        payload = detection_payload(with_cycle=False)
        self.assertEqual(deadlocks.validate(payload), [])
        result = deadlocks.run(payload).model_dump()
        self.assertFalse(result["metrics"]["deadlock"])
        self.assertEqual(result["metrics"]["waiting_processes"], ["P0"])
        self.assertEqual(result["metrics"]["wait_edges"], [{"from": "P0", "to": "P1", "via": ["R1"]}])

    def test_trace_walks_one_process_at_a_time(self) -> None:
        result = deadlocks.run(detection_payload(with_cycle=True)).model_dump()
        phases = [step["state"]["phase"] for step in result["steps"]]
        self.assertEqual(phases, ["init", "build", "build", "detect", "complete"])
        inspected = [
            step["state"].get("inspecting")
            for step in result["steps"]
            if step["state"]["phase"] == "build"
        ]
        self.assertEqual(inspected, ["P0", "P1"])
        graph_steps = [
            step["state"]["wait_edges"]
            for step in result["steps"]
            if step["state"]["phase"] == "build"
        ]
        self.assertEqual(len(graph_steps[0]), 1)
        self.assertEqual(len(graph_steps[1]), 2)
        self.assertEqual(result["steps"][-1]["state"]["cycle"], ["P0", "P1", "P0"])


if __name__ == "__main__":
    unittest.main()
