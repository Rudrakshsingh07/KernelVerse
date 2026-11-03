"""
Cache simulation engine.

Models a set-associative data cache over a sequence of memory block
references.  Each block maps to a set with ``block % number_of_sets``; the
cache chooses a line within that set using FIFO, LRU or MRU replacement.

Replacement policies:

    fifo - evict the block that entered the set first.
    lru  - evict the least recently used block in the set.
    mru  - evict the most recently used block in the set.

One line per set is a direct-mapped cache.  A set containing every line is a
fully associative cache.  Values in between model a set-associative cache with
N lines per set.

Public contract (see base.py):
    validate(payload) -> list[str]
    run(payload)      -> SimulationResult
"""

from __future__ import annotations

from collections import deque
from typing import Any

from .base import SimulationResult, Step

ALGORITHMS = ["fifo", "lru", "mru"]


def validate(payload: dict[str, Any]) -> list[str]:
    """
    Validate a cache payload.

    Args:
        payload: dict with algorithm, references, cache_lines and associativity.

    Returns:
        List of human-readable errors; empty means valid.
    """
    errors: list[str] = []
    if payload.get("algorithm") not in ALGORITHMS:
        errors.append(f"algorithm must be one of {ALGORITHMS}")

    references = payload.get("references")
    if not isinstance(references, list) or not references:
        errors.append("references must be a non-empty list of block numbers")
    else:
        for index, block in enumerate(references):
            if not isinstance(block, int) or block < 0:
                errors.append(f"references[{index}] must be a non-negative integer")

    cache_lines = payload.get("cache_lines")
    if not isinstance(cache_lines, int) or cache_lines < 1:
        errors.append("cache_lines must be an integer >= 1")

    associativity = payload.get("associativity", 1)
    if not isinstance(associativity, int) or associativity < 1:
        errors.append("lines per set must be an integer >= 1")
    elif isinstance(cache_lines, int) and cache_lines >= 1:
        if associativity > cache_lines:
            errors.append("lines per set cannot exceed cache_lines")
        elif cache_lines % associativity != 0:
            errors.append("cache_lines must be divisible by lines per set")

    return errors


def run(payload: dict[str, Any]) -> SimulationResult:
    """
    Simulate cache hits, misses and evictions.

    For every referenced block:
      1. Map it to a set.
      2. If it is resident in that set, count a hit.
      3. Otherwise count a miss, use a free line when possible, or evict a
         victim chosen by FIFO/LRU/MRU.
      4. Record a step with the complete cache line contents.

    Returns:
        SimulationResult with per-access steps and aggregate metrics.
    """
    algorithm: str = payload["algorithm"]
    references: list[int] = payload["references"]
    cache_lines: int = payload["cache_lines"]
    associativity: int = int(payload.get("associativity", 1))
    set_count = cache_lines // associativity

    # line contents; None means the line is empty.
    lines: list[int | None] = [None] * cache_lines
    # FIFO queues kept per set, oldest at the front.
    fifo_queues: list[deque[int]] = [deque() for _ in range(set_count)]
    # Last access index for LRU / MRU, per block.
    last_used: dict[int, int] = {}

    steps: list[Step] = []
    hits = 0
    misses = 0
    evictions = 0

    for index, block in enumerate(references):
        set_index = block % set_count
        line_indices = list(
            range(set_index * associativity, (set_index + 1) * associativity)
        )
        resident = [lines[line] for line in line_indices if lines[line] is not None]
        hit = block in resident
        evicted: int | None = None

        if hit:
            hits += 1
            last_used[block] = index
            note = (
                f"Block {block} maps to set {set_index} and is already cached "
                f"— cache hit."
            )
        else:
            misses += 1
            free_line = next(
                (line for line in line_indices if lines[line] is None), None
            )
            if free_line is not None:
                slot = free_line
                note = (
                    f"Block {block} maps to set {set_index} and is not cached. "
                    f"Loaded into empty line {slot}."
                )
            else:
                if algorithm == "fifo":
                    evicted = fifo_queues[set_index][0]
                elif algorithm == "lru":
                    evicted = min(
                        resident,
                        key=lambda page: last_used.get(page, -1),
                    )
                else:  # mru
                    evicted = max(
                        resident,
                        key=lambda page: last_used.get(page, -1),
                    )
                slot = lines.index(evicted)
                evictions += 1
                fifo_queues[set_index] = deque(
                    page for page in fifo_queues[set_index] if page != evicted
                )
                last_used.pop(evicted, None)
                note = (
                    f"Block {block} maps to set {set_index}. Cache full — "
                    f"evicted block {evicted} from line {slot} ({algorithm.upper()})."
                )

            lines[slot] = block
            fifo_queues[set_index].append(block)
            last_used[block] = index

        steps.append(
            Step(
                tick=index,
                state={
                    "reference_index": index,
                    "current": block,
                    "references": references,
                    "lines": list(lines),
                    "cache_lines": cache_lines,
                    "associativity": associativity,
                    "set_count": set_count,
                    "set_index": set_index,
                    "algorithm": algorithm,
                    "hit": hit,
                    "miss": not hit,
                    "evicted": evicted,
                    "hits_so_far": hits,
                    "misses_so_far": misses,
                },
                highlight=[str(block)],
                explanation=note,
            )
        )

    total = len(references)
    metrics = {
        "hits": hits,
        "misses": misses,
        "evictions": evictions,
        "hit_ratio": round(hits / total, 3),
        "miss_ratio": round(misses / total, 3),
        "total_references": total,
        "cache_lines": cache_lines,
        "associativity": associativity,
        "sets": set_count,
    }
    return SimulationResult(steps=steps, metrics=metrics, warnings=[])
