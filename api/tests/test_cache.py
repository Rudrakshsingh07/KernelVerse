"""Unit tests for the set-associative cache engine.

Run from the repository root with:

    python -m unittest discover -s api/tests -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

# Make ``app`` importable when the tests are run from the repository root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engines import cache  # noqa: E402


def cache_payload(**overrides) -> dict:
    payload = {
        "algorithm": "fifo",
        "references": [1, 2, 1, 3, 1, 2],
        "cache_lines": 2,
        "associativity": 2,
    }
    payload.update(overrides)
    return payload


class CacheValidationTests(unittest.TestCase):
    def test_valid_payload(self) -> None:
        self.assertEqual(cache.validate(cache_payload()), [])

    def test_bad_algorithm_is_rejected(self) -> None:
        errors = cache.validate(cache_payload(algorithm="random"))
        self.assertTrue(any("algorithm" in error for error in errors))

    def test_opt_algorithm_is_rejected(self) -> None:
        errors = cache.validate(cache_payload(algorithm="opt"))
        self.assertTrue(any("algorithm" in error for error in errors))

    def test_empty_references_are_rejected(self) -> None:
        errors = cache.validate(cache_payload(references=[]))
        self.assertTrue(any("references" in error for error in errors))

    def test_invalid_reference_is_rejected(self) -> None:
        errors = cache.validate(cache_payload(references=[1, -2]))
        self.assertTrue(any("references[1]" in error for error in errors))

    def test_associativity_must_divide_lines(self) -> None:
        errors = cache.validate(cache_payload(cache_lines=5, associativity=2))
        self.assertTrue(any("divisible" in error for error in errors))

    def test_associativity_cannot_exceed_lines(self) -> None:
        errors = cache.validate(cache_payload(cache_lines=2, associativity=4))
        self.assertTrue(any("cannot exceed" in error for error in errors))


class CacheEngineTests(unittest.TestCase):
    def test_fifo_fully_associative(self) -> None:
        result = cache.run(cache_payload()).model_dump()
        self.assertEqual(result["metrics"]["hits"], 1)
        self.assertEqual(result["metrics"]["misses"], 5)
        self.assertEqual(result["metrics"]["evictions"], 3)
        self.assertEqual(result["metrics"]["sets"], 1)
        self.assertEqual(len(result["steps"]), 6)
        self.assertEqual(result["steps"][0]["state"]["lines"], [1, None])
        self.assertEqual(result["steps"][3]["state"]["evicted"], 1)

    def test_lru_keeps_recently_used_block(self) -> None:
        result = cache.run(cache_payload(algorithm="lru")).model_dump()
        self.assertEqual(result["metrics"]["hits"], 2)
        self.assertEqual(result["metrics"]["misses"], 4)
        # Block 1 is used at index 2 and again at index 4, so the miss at
        # index 3 must evict block 2 rather than block 1.
        self.assertEqual(result["steps"][3]["state"]["evicted"], 2)

    def test_mru_evicts_most_recently_used_block(self) -> None:
        payload = cache_payload(
            algorithm="mru",
            references=[1, 2, 3, 1],
            cache_lines=2,
            associativity=2,
        )
        result = cache.run(payload).model_dump()
        # 1 and 2 fill the cache; 3 must evict 2 (the most recent) so the
        # final access to 1 still hits.
        self.assertEqual(result["steps"][2]["state"]["evicted"], 2)
        self.assertEqual(result["metrics"]["hits"], 1)
        self.assertEqual(result["metrics"]["misses"], 3)

    def test_direct_mapped_hit_in_own_line(self) -> None:
        payload = cache_payload(
            algorithm="lru",
            references=[0, 1, 0],
            cache_lines=2,
            associativity=1,
        )
        result = cache.run(payload).model_dump()
        self.assertEqual(result["metrics"]["hits"], 1)
        self.assertEqual(result["metrics"]["misses"], 2)
        self.assertEqual(result["steps"][2]["state"]["set_index"], 0)
        self.assertTrue(result["steps"][2]["state"]["hit"])

    def test_set_mapping_uses_block_modulo_sets(self) -> None:
        payload = cache_payload(
            references=[0, 1, 2, 3],
            cache_lines=4,
            associativity=2,
        )
        result = cache.run(payload).model_dump()
        self.assertEqual(result["metrics"]["sets"], 2)
        self.assertEqual(
            [step["state"]["set_index"] for step in result["steps"]],
            [0, 1, 0, 1],
        )
        # Every reference is a compulsory miss in a cold cache.
        self.assertEqual(result["metrics"]["misses"], 4)

    def test_every_step_snapshots_every_line(self) -> None:
        result = cache.run(cache_payload(cache_lines=4, associativity=2)).model_dump()
        for step in result["steps"]:
            state = step["state"]
            self.assertEqual(len(state["lines"]), 4)
            self.assertEqual(state["reference_index"], step["tick"])
            self.assertEqual(state["references"], [1, 2, 1, 3, 1, 2])


if __name__ == "__main__":
    unittest.main()
