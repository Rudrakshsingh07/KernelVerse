"""Unit tests for the disk-scheduling engine.

Run from the repository root with:

    python -m unittest discover -s api/tests -v
"""

from __future__ import annotations

import sys
import unittest
from collections import Counter
from pathlib import Path

# Make ``app`` importable when the tests are run from the repository root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engines import disk_scheduling  # noqa: E402

CLASSIC_REQUESTS = [98, 183, 37, 122, 14, 124, 65, 67]
CLASSIC_TOTALS = {
    "fcfs": 640,
    "sstf": 236,
    "scan": 331,
    "cscan": 382,
    "look": 299,
}


class DiskSchedulingEngineTests(unittest.TestCase):
    def run_engine(self, algorithm: str, **overrides) -> dict:
        payload = {
            "algorithm": algorithm,
            "head": 53,
            "disk_size": 200,
            "requests": CLASSIC_REQUESTS,
        }
        payload.update(overrides)
        self.assertEqual(disk_scheduling.validate(payload), [])
        return disk_scheduling.run(payload).model_dump()

    def test_classic_total_seek(self) -> None:
        for algorithm, expected in CLASSIC_TOTALS.items():
            with self.subTest(algorithm=algorithm):
                result = self.run_engine(algorithm)
                self.assertEqual(result["metrics"]["total_seek"], expected)

    def test_every_request_is_served_once(self) -> None:
        for algorithm in disk_scheduling.ALGORITHMS:
            with self.subTest(algorithm=algorithm):
                result = self.run_engine(algorithm)
                self.assertEqual(
                    Counter(result["metrics"]["service_order"]),
                    Counter(CLASSIC_REQUESTS),
                )
                self.assertEqual(result["steps"][-1]["state"]["remaining"], [])
                self.assertEqual(
                    len(result["steps"]),
                    result["metrics"]["head_movements"] + 1,
                )

    def test_step_snapshots_track_the_head(self) -> None:
        result = self.run_engine("scan")
        sequence = result["metrics"]["sequence"]
        for index, step in enumerate(result["steps"]):
            with self.subTest(index=index):
                self.assertEqual(step["tick"], index)
                self.assertEqual(step["state"]["head"], sequence[index])
                self.assertEqual(
                    step["state"]["total_seek"],
                    sum(step["state"]["seek_distances"]),
                )

    def test_scan_touches_edge_and_reverses(self) -> None:
        result = self.run_engine("scan")
        self.assertIn(199, result["metrics"]["sequence"])
        service_order = result["metrics"]["service_order"]
        self.assertGreater(service_order.index(183), service_order.index(65))
        self.assertGreater(service_order.index(37), service_order.index(183))

    def test_cscan_wraps_to_zero(self) -> None:
        result = self.run_engine("cscan")
        self.assertIn(0, result["metrics"]["sequence"])
        # Requests below the start are served after the wrap, in ascending order.
        self.assertEqual(result["metrics"]["service_order"][-2:], [14, 37])

    def test_cscan_can_start_left_and_continues_descending_after_wrap(self) -> None:
        # The nearest request (90) is left of the head (100), so the engine
        # starts the sweep toward lower cylinders.
        result = self.run_engine(
            "cscan",
            head=100,
            requests=[10, 20, 90, 120, 130, 140],
        )
        self.assertEqual(result["metrics"]["initial_direction"], "left")
        self.assertEqual(result["metrics"]["sequence"][:5], [100, 90, 20, 10, 0])
        self.assertEqual(result["metrics"]["service_order"][-3:], [140, 130, 120])

    def test_look_does_not_touch_unneeded_edge(self) -> None:
        result = self.run_engine("look")
        self.assertNotIn(199, result["metrics"]["sequence"])
        self.assertNotIn(0, result["metrics"]["sequence"])

    def test_duplicate_requests(self) -> None:
        payload = {
            "algorithm": "fcfs",
            "head": 10,
            "disk_size": 20,
            "requests": [5, 5, 5],
        }
        self.assertEqual(disk_scheduling.validate(payload), [])
        result = disk_scheduling.run(payload)
        self.assertEqual(result.metrics["service_order"], [5, 5, 5])
        self.assertEqual(result.metrics["total_seek"], 5)

    def test_direction_is_chosen_by_the_engine(self) -> None:
        # The classic workload's nearest request is 65 (right of 53).
        result = self.run_engine("scan")
        self.assertEqual(result["metrics"]["initial_direction"], "right")
        self.assertEqual(result["metrics"]["direction_source"], "engine")

        # A legacy direction field must not override the engine's choice.
        overridden = self.run_engine("scan", direction="left")
        self.assertEqual(overridden["metrics"]["initial_direction"], "right")
        self.assertEqual(overridden["metrics"]["total_seek"], 331)

    def test_nearest_request_sets_initial_direction(self) -> None:
        left = self.run_engine(
            "look",
            head=100,
            requests=[10, 20, 90, 120, 130, 140],
        )
        self.assertEqual(left["metrics"]["initial_direction"], "left")

        right = self.run_engine(
            "look",
            head=100,
            requests=[10, 20, 110, 120, 130, 140],
        )
        self.assertEqual(right["metrics"]["initial_direction"], "right")

    def test_fcfs_starts_toward_first_request(self) -> None:
        right = self.run_engine("fcfs", head=50, requests=[80, 10])
        self.assertEqual(right["metrics"]["initial_direction"], "right")

        left = self.run_engine("fcfs", head=50, requests=[10, 80])
        self.assertEqual(left["metrics"]["initial_direction"], "left")

    def test_sstf_starts_toward_nearest_request(self) -> None:
        result = self.run_engine("sstf", head=50, requests=[80, 40])
        self.assertEqual(result["metrics"]["initial_direction"], "left")

    def test_ties_break_toward_lower_cylinder(self) -> None:
        result = self.run_engine("scan", head=50, requests=[40, 60])
        self.assertEqual(result["metrics"]["initial_direction"], "left")

    def test_head_at_edges_picks_the_only_direction(self) -> None:
        lower = self.run_engine("scan", head=0, requests=[10, 20])
        self.assertEqual(lower["metrics"]["initial_direction"], "right")

        upper = self.run_engine("scan", head=199, requests=[10, 20])
        self.assertEqual(upper["metrics"]["initial_direction"], "left")

    def test_all_requests_at_head(self) -> None:
        for algorithm in disk_scheduling.ALGORITHMS:
            with self.subTest(algorithm=algorithm):
                result = self.run_engine(
                    algorithm,
                    head=10,
                    disk_size=20,
                    requests=[10, 10],
                )
                self.assertEqual(result["metrics"]["service_order"], [10, 10])
                self.assertEqual(result["metrics"]["total_seek"], 0)
                self.assertEqual(result["metrics"]["head_movements"], 2)

    def test_validation_errors(self) -> None:
        bad_payloads = [
            {
                "algorithm": "nope",
                "head": 10,
                "disk_size": 20,
                "requests": [1],
            },
            {
                "algorithm": "scan",
                "head": 20,
                "disk_size": 20,
                "requests": [1],
            },
            {
                "algorithm": "fcfs",
                "head": 10,
                "disk_size": 20,
                "requests": [],
            },
            {
                "algorithm": "sstf",
                "head": -1,
                "disk_size": 20,
                "requests": [1],
            },
            {
                "algorithm": "look",
                "head": 10,
                "disk_size": 20,
                "requests": [25],
            },
        ]
        for payload in bad_payloads:
            with self.subTest(payload=payload):
                self.assertNotEqual(disk_scheduling.validate(payload), [])


if __name__ == "__main__":
    unittest.main()
