from __future__ import annotations

from collections import deque
from typing import Any

from .base import SimulationResult, Step

ALGORITHMS = ["fifo", "lru", "optimal"]


def validate(payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if payload.get("algorithm") not in ALGORITHMS:
        errors.append(f"algorithm must be one of {ALGORITHMS}")

    refs = payload.get("reference_string")
    if not isinstance(refs, list) or not refs:
        errors.append("reference_string must be a non-empty list of page numbers")
    else:
        for i, r in enumerate(refs):
            if not isinstance(r, int) or r < 0:
                errors.append(f"reference_string[{i}] must be a non-negative integer")

    frames = payload.get("frames")
    if not isinstance(frames, int) or frames < 1:
        errors.append("frames must be an integer >= 1")

    tlb_size = payload.get("tlb_size", 0)
    if not isinstance(tlb_size, int) or tlb_size < 0:
        errors.append("tlb_size must be an integer >= 0")
    return errors


def run(payload: dict[str, Any]) -> SimulationResult:
    algorithm = payload["algorithm"]
    refs: list[int] = payload["reference_string"]
    frame_count = payload["frames"]
    tlb_size = int(payload.get("tlb_size", 0))

    frames: list[int | None] = [None] * frame_count
    loaded_order: deque[int] = deque()  # FIFO
    last_used: dict[int, int] = {}
    tlb: list[int] = []

    steps: list[Step] = []
    faults = 0
    tlb_hits = 0
    tlb_misses = 0
    frame_hits = 0

    for i, page in enumerate(refs):
        note = f"Access page {page}. "
        tlb_hit = False

        if tlb_size > 0 and page in tlb:
            tlb_hit = True
            tlb_hits += 1
            note += "TLB hit — translation cached, no page-table walk. "
            if page in last_used:
                last_used[page] = i
            steps.append(_step(i, page, frames, tlb, True, True, False, faults, tlb_hits, tlb_misses, frame_hits, note, refs))
            continue

        if tlb_size > 0:
            tlb_misses += 1
            note += "TLB miss — checking frames. "

        if page in frames:
            frame_hits += 1
            last_used[page] = i
            _tlb_add(tlb, page, tlb_size)
            note += "Page already in a frame (hit)."
            steps.append(_step(i, page, frames, tlb, True, tlb_hit, False, faults, tlb_hits, tlb_misses, frame_hits, note, refs))
            continue

        # page fault
        faults += 1
        victim: int | None = None
        if None in frames:
            slot = frames.index(None)
            frames[slot] = page
            note += f"Page fault — loaded into empty frame {slot}."
        else:
            victim = _victim(algorithm, frames, refs, i, loaded_order, last_used)
            slot = frames.index(victim)
            frames[slot] = page
            loaded_order = deque(p for p in loaded_order if p != victim)
            last_used.pop(victim, None)
            if victim in tlb:
                tlb.remove(victim)
            note += f"Page fault — evicted page {victim} (frame {slot}), loaded {page}."

        loaded_order.append(page)
        last_used[page] = i
        _tlb_add(tlb, page, tlb_size)
        steps.append(_step(i, page, frames, tlb, False, tlb_hit, True, faults, tlb_hits, tlb_misses, frame_hits, note, refs))

    n = len(refs)
    metrics = {
        "page_faults": faults,
        "frame_hits": frame_hits,
        "fault_rate": round(faults / n, 3),
        "hit_ratio": round(frame_hits / n, 3),
        "tlb_hits": tlb_hits,
        "tlb_misses": tlb_misses,
        "tlb_hit_ratio": round(tlb_hits / n, 3) if tlb_size > 0 else None,
        "total_references": n,
    }
    return SimulationResult(steps=steps, metrics=metrics, warnings=[])


def _tlb_add(tlb: list[int], page: int, tlb_size: int) -> None:
    if tlb_size <= 0:
        return
    if page in tlb:
        tlb.remove(page)
    tlb.append(page)  # most-recently-used at the end
    while len(tlb) > tlb_size:
        tlb.pop(0)  # FIFO/LRU evict oldest-used


def _victim(algorithm: str, frames: list[int | None], refs: list[int], i: int, loaded_order: deque, last_used: dict[str, int]) -> int:
    present = [f for f in frames if f is not None]
    if algorithm == "fifo":
        return loaded_order[0]
    if algorithm == "lru":
        return min(present, key=lambda p: last_used[p])
    # optimal: page not used again for the longest time
    def next_use(p: int) -> int:
        try:
            return refs.index(p, i + 1)
        except ValueError:
            return float("inf")  # type: ignore[return-value]

    return max(present, key=lambda p: next_use(p))


def _step(i, page, frames, tlb, hit, tlb_hit, fault, faults, tlb_hits, tlb_misses, frame_hits, note, refs) -> Step:
    return Step(
        tick=i,
        state={
            "reference_index": i,
            "current": page,
            "references": refs,
            "frames": list(frames),
            "tlb": list(tlb),
            "hit": hit,
            "tlb_hit": tlb_hit,
            "fault": fault,
            "faults_so_far": faults,
        },
        highlight=[str(page)],
        explanation=note,
    )
