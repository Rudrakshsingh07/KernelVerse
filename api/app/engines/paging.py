"""
Paging simulation engine.

Simulates virtual-memory page replacement over a reference string with a fixed
number of page frames.  Supports three replacement algorithms:

    FIFO   - First-In, First-Out (evict the page loaded earliest)
    LRU    - Least Recently Used (evict the page with the oldest access)
    Optimal - evict the page whose next use is farthest in the future (clairvoyant)

An optional TLB (Translation Lookaside Buffer) can be modeled: on each page
reference the engine checks the TLB first (TLB hit), then the frames (frame
hit), and on a page fault loads the page, possibly evicting a victim.

One Step is recorded per reference so the frontend can animate frame contents,
page faults, hits, and TLB state.

Public contract (see base.py):
    validate(payload) -> list[str]
    run(payload)      -> SimulationResult
"""

from collections import deque
from typing import Any

from .base import SimulationResult, Step

ALGORITHMS = ["fifo", "lru", "optimal"]


def validate(payload: dict[str, Any]) -> list[str]:
    """
    Validate the paging input payload.

    Checks the algorithm name, reference string (non-empty list of ints),
    frame count (>= 1), and optional TLB size (>= 0).

    Args:
        payload: JSON dict with algorithm, reference_string, frames, tlb_size.

    Returns:
        List of human-readable error strings; empty list means valid.
    """
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
    """
    Execute the page-replacement simulation over the reference string.

    For each page reference in order:
      1. Check the TLB -> TLB hit if present (no page-table walk needed).
      2. Otherwise check the frames -> frame hit if the page is resident.
      3. On a page fault:
         - If an empty frame exists, load the page there.
         - Otherwise pick a victim using the chosen algorithm, evict it,
           and load the new page.
      4. Update TLB and record a Step.

    After processing all references, compute fault/hit counts, rates, and TLB stats.

    Args:
        payload: Validated input with algorithm, reference_string, frames, tlb_size.

    Returns:
        SimulationResult with steps, metrics, and warnings.
    """
    algorithm = payload["algorithm"]
    refs: list[int] = payload["reference_string"]
    frame_count = payload["frames"]
    tlb_size = int(payload.get("tlb_size", 0))

    # frames: list of page IDs currently in memory; None = empty frame.
    frames: list[int | None] = [None] * frame_count
    # loaded_order: FIFO queue of pages currently in frames (for FIFO victim selection).
    loaded_order: deque[int] = deque()
    # last_used: page ID -> last reference index (for LRU victim selection).
    last_used: dict[int, int] = {}
    # tlb: ordered list of page IDs cached in the TLB (MRU at end).
    tlb: list[int] = []

    steps: list[Step] = []
    faults = 0
    tlb_hits = 0
    tlb_misses = 0
    frame_hits = 0

    for i, page in enumerate(refs):
        note = f"Access page {page}. "
        tlb_hit = False

        # --- Step 1: TLB lookup ------------------------------------
        if tlb_size > 0 and page in tlb:
            tlb_hit = True
            tlb_hits += 1
            note += "TLB hit — translation cached, no page-table walk. "
            if page in last_used:
                last_used[page] = i
            steps.append(
                _step(
                    i, page, frames, tlb, True, True, False,
                    faults, tlb_hits, tlb_misses, frame_hits, note, refs,
                )
            )
            continue

        if tlb_size > 0:
            tlb_misses += 1
            note += "TLB miss — checking frames. "

        # --- Step 2: Frame lookup (page-table walk) ----------------
        if page in frames:
            frame_hits += 1
            last_used[page] = i
            _tlb_add(tlb, page, tlb_size)
            note += "Page already in a frame (hit)."
            steps.append(
                _step(
                    i, page, frames, tlb, True, tlb_hit, False,
                    faults, tlb_hits, tlb_misses, frame_hits, note, refs,
                )
            )
            continue

        # --- Step 3: Page fault ------------------------------------
        faults += 1
        victim: int | None = None
        if None in frames:
            # Empty frame available — load without eviction.
            slot = frames.index(None)
            frames[slot] = page
            note += f"Page fault — loaded into empty frame {slot}."
        else:
            # No free frame — pick a victim and evict.
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
        steps.append(
            _step(
                i, page, frames, tlb, False, tlb_hit, True,
                faults, tlb_hits, tlb_misses, frame_hits, note, refs,
            )
        )

    # --- Aggregate metrics ------------------------------------------
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
    """
    Insert a page into the TLB, maintaining MRU-at-end order and size limit.

    If the page is already in the TLB it is moved to the end (most recently
    used).  If adding exceeds tlb_size, the oldest entry (front) is evicted.

    Args:
        tlb: The current TLB contents (list of page IDs).
        page: The page ID to add or refresh.
        tlb_size: Maximum number of entries the TLB can hold.
    """
    if tlb_size <= 0:
        return
    if page in tlb:
        tlb.remove(page)
    tlb.append(page)  # most-recently-used at the end
    while len(tlb) > tlb_size:
        tlb.pop(0)    # evict oldest-used entry


def _victim(
    algorithm: str,
    frames: list[int | None],
    refs: list[int],
    i: int,
    loaded_order: deque,
    last_used: dict[str, int],
) -> int:
    """
    Select which resident page to evict when a page fault occurs and no frame is free.

    Args:
        algorithm: "fifo", "lru", or "optimal".
        frames: Current frame contents (page IDs or None).
        refs: The full reference string.
        i: Index of the current reference (used by Optimal for look-ahead).
        loaded_order: FIFO queue of resident pages (FIFO algorithm).
        last_used: page ID -> last reference index (LRU algorithm).

    Returns:
        The page ID to evict.
    """
    present = [f for f in frames if f is not None]
    if algorithm == "fifo":
        # Evict the page that has been in memory the longest (front of queue).
        return loaded_order[0]
    if algorithm == "lru":
        # Evict the page with the oldest last-use reference index.
        return min(present, key=lambda p: last_used[p])
    # Optimal: evict the page whose next use is farthest in the future
    # (or never used again).  Requires knowledge of the full reference string.
    def next_use(p: int) -> int:
        try:
            return refs.index(p, i + 1)   # next occurrence after current index
        except ValueError:
            return float("inf")           # never used again -> best candidate to evict

    return max(present, key=lambda p: next_use(p))


def _step(
    i, page, frames, tlb, hit, tlb_hit, fault, faults, tlb_hits, tlb_misses,
    frame_hits, note, refs,
) -> Step:
    """
    Build a ``Step`` for a single page reference.

    Captures the current reference index, page being accessed, full frame
    contents, TLB contents, hit/fault status, and running counters so the
    frontend can animate the page-table state.

    Args:
        i: Index of the current reference in the reference string.
        page: The page ID being accessed.
        frames: Current frame contents.
        tlb: Current TLB contents.
        hit: True if the page was already in a frame.
        tlb_hit: True if the translation was found in the TLB.
        fault: True if this reference caused a page fault.
        faults: Running page-fault count.
        tlb_hits: Running TLB-hit count.
        tlb_misses: Running TLB-miss count.
        frame_hits: Running frame-hit count.
        note: Explanation string for this step.
        refs: The full reference string (included in state for context).

    Returns:
        A populated ``Step`` object.
    """
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
