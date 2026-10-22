"""
Memory Management simulation engine.

Simulates placing processes into physical memory using contiguous allocation or
segmentation, with first-fit, best-fit, or worst-fit placement strategies.

Modes:
    contiguous  - one contiguous block per process (classic dynamic partitioning)
    segmentation - multiple named segments per process, each placed independently

Strategies:
    first-fit  - allocate the first hole large enough (scan by start address)
    best-fit   - allocate the smallest hole that fits (minimizes wasted space per hole)
    worst-fit  - allocate the largest hole (leaves the biggest leftover fragment)

If ``holes`` are provided, memory starts pre-fragmented; otherwise it is one
large free block of ``memory_size``.  For each process/segment the engine tries
to find a free hole, carves out an allocated block, and leaves any leftover as
a new free hole.  If no hole fits, the allocation fails.

The engine records one Step per allocation attempt and produces metrics on
utilization, free space, largest hole, external fragmentation, and failures.

Public contract (see base.py):
    validate(payload) -> list[str]
    run(payload)      -> SimulationResult
"""

from __future__ import annotations

from typing import Any

from .base import SimulationResult, Step

MODES = ["contiguous", "segmentation"]
STRATEGIES = ["first-fit", "best-fit", "worst-fit"]


def validate(payload: dict[str, Any]) -> list[str]:
    """
    Validate the memory-management input payload.

    Checks mode, strategy, memory size, process definitions (size for
    contiguous; segments for segmentation), and optional pre-existing holes.

    Args:
        payload: JSON dict with mode, strategy, memory_size, processes.

    Returns:
        List of human-readable error strings; empty list means valid.
    """
    errors: list[str] = []
    mode = payload.get("mode", "contiguous")
    strategy = payload.get("strategy", "first-fit")
    memory_size = payload.get("memory_size")

    if mode not in MODES:
        errors.append(f"mode must be one of {MODES}")
    if strategy not in STRATEGIES:
        errors.append(f"strategy must be one of {STRATEGIES}")
    if not isinstance(memory_size, int) or memory_size <= 0:
        errors.append("memory_size must be a positive integer")

    processes = payload.get("processes")
    if not isinstance(processes, list) or not processes:
        errors.append("processes must be a non-empty list")
    else:
        seen: set[str] = set()
        for i, p in enumerate(processes):
            pid = p.get("id")
            if not pid or pid in seen:
                errors.append(f"processes[{i}].id missing or duplicate")
            if mode == "contiguous":
                # Contiguous mode needs a single positive size for the whole process.
                if not isinstance(p.get("size"), int) or p["size"] <= 0:
                    errors.append(f"process '{pid}': size must be a positive integer")
            else:
                # Segmentation mode needs a non-empty list of named segments.
                segs = p.get("segments")
                if not isinstance(segs, list) or not segs:
                    errors.append(f"process '{pid}': segments must be a non-empty list")
                else:
                    for j, s in enumerate(segs):
                        if not s.get("name"):
                            errors.append(f"process '{pid}' segment {j}: name required")
                        if not isinstance(s.get("size"), int) or s["size"] <= 0:
                            errors.append(f"process '{pid}' segment '{s.get('name')}': size must be positive")

    # Optional pre-existing holes (for fragmentation experiments).
    holes = payload.get("holes")
    if holes is not None:
        if not isinstance(holes, list) or not holes:
            errors.append("holes must be a non-empty list when provided")
        else:
            covered = 0
            for h in holes:
                if not isinstance(h.get("start"), int) or not isinstance(h.get("size"), int) or h["start"] < 0 or h["size"] <= 0:
                    errors.append("each hole needs start >= 0 and size > 0")
                else:
                    covered += h["size"]
            if isinstance(memory_size, int) and covered > memory_size:
                errors.append("sum of hole sizes exceeds memory_size")
    return errors


def _pick(free: list[dict[str, Any]], strategy: str) -> dict[str, Any]:
    """
    Choose which free hole to allocate from, based on the placement strategy.

    Args:
        free: List of free-hole blocks that are large enough for the request.
        strategy: One of "first-fit", "best-fit", "worst-fit".

    Returns:
        The selected hole block (a dict with start/size/type/owner/label).
    """
    if strategy == "first-fit":
        # First hole in address order (lowest start address).
        return min(free, key=lambda b: b["start"])
    if strategy == "best-fit":
        # Smallest hole that fits (minimizes leftover fragment per allocation).
        return min(free, key=lambda b: (b["size"], b["start"]))
    # Worst-fit: largest hole (leaves the biggest possible leftover fragment).
    return max(free, key=lambda b: (b["size"], -b["start"]))


def _alloc(
    blocks: list[dict[str, Any]],
    size: int,
    owner: str,
    label: str,
    strategy: str,
) -> dict[str, Any] | None:
    """
    Attempt to allocate ``size`` units of memory from the free holes.

    Scans the block list for free holes large enough, picks one using the
    strategy, carves out an allocated block of exactly ``size``, and (if the
    hole was larger) leaves the remainder as a new free hole immediately
    after the allocated block.

    Args:
        blocks: The current list of memory blocks (free + allocated).
        size: Number of memory units to allocate.
        owner: Process ID that owns the allocation.
        label: Human-readable label (process ID, or "PID:segment name").
        strategy: Placement strategy ("first-fit", "best-fit", "worst-fit").

    Returns:
        The newly allocated block dict, or None if no hole is large enough.
    """
    # Filter to free holes that can satisfy the request.
    free = [b for b in blocks if b["type"] == "free" and b["size"] >= size]
    if not free:
        return None
    hole = _pick(free, strategy)
    idx = blocks.index(hole)
    # Replace the hole with an allocated block of the requested size.
    blocks[idx] = {
        "start": hole["start"],
        "size": size,
        "type": "allocated",
        "owner": owner,
        "label": label,
    }
    # If there was leftover space, insert a new free hole after the allocation.
    if hole["size"] > size:
        blocks.insert(
            idx + 1,
            {
                "start": hole["start"] + size,
                "size": hole["size"] - size,
                "type": "free",
                "owner": None,
                "label": "free",
            },
        )
    return blocks[idx]


def run(payload: dict[str, Any]) -> SimulationResult:
    """
    Execute the memory-allocation simulation.

    Builds the initial block layout (either from ``holes`` or one big free
    block), then iterates over processes (and their segments in segmentation
    mode), attempting to place each one using the chosen strategy.  One Step is
    recorded per placement attempt so the frontend can animate block carving.

    After all placements, it computes utilization, free space, largest hole,
    external fragmentation, and the list of failed allocations.

    Args:
        payload: Validated input with mode, strategy, memory_size, processes.

    Returns:
        SimulationResult with steps, metrics, and warnings.
    """
    mode = payload.get("mode", "contiguous")
    strategy = payload.get("strategy", "first-fit")
    memory_size = payload["memory_size"]
    processes = payload["processes"]

    # --- Build initial memory layout ----------------------------------
    holes = payload.get("holes")
    if holes:
        # Start from pre-existing holes (allows fragmentation experiments).
        blocks: list[dict[str, Any]] = [
            {
                "start": h["start"],
                "size": h["size"],
                "type": "free",
                "owner": None,
                "label": "free",
            }
            for h in sorted(holes, key=lambda h: h["start"])
        ]
    else:
        # One large free block covering the entire memory.
        blocks = [{"start": 0, "size": memory_size, "type": "free", "owner": None, "label": "free"}]

    steps: list[Step] = []
    warnings: list[str] = []
    segment_table: list[dict[str, Any]] = []   # only populated in segmentation mode
    failed: list[str] = []                      # processes/segments that couldn't be placed
    tick = 0

    # Record the initial state before any allocation.
    steps.append(
        Step(
            tick=tick,
            state=_state(blocks, mode, segment_table, memory_size),
            explanation=f"Initial memory: {len(blocks)} free hole(s), {memory_size} units total.",
        )
    )

    # --- Allocate each process (or each segment) ---------------------
    if mode == "contiguous":
        for p in processes:
            tick += 1
            placed = _alloc(blocks, p["size"], p["id"], p["id"], strategy)
            if placed is None:
                failed.append(p["id"])
                steps.append(
                    Step(
                        tick=tick,
                        state=_state(blocks, mode, segment_table, memory_size),
                        explanation=f"{p['id']} ({p['size']}) could NOT be placed — no free hole large enough.",
                    )
                )
            else:
                steps.append(
                    Step(
                        tick=tick,
                        state=_state(blocks, mode, segment_table, memory_size),
                        highlight=[p["id"]],
                        explanation=f"{p['id']} ({p['size']}) placed at address {placed['start']} using {strategy}.",
                    )
                )
    else:
        # Segmentation mode: place each named segment independently.
        for p in processes:
            for seg in p["segments"]:
                tick += 1
                placed = _alloc(blocks, seg["size"], p["id"], f"{p['id']}:{seg['name']}", strategy)
                if placed is None:
                    failed.append(f"{p['id']}:{seg['name']}")
                    segment_table.append(
                        {"process": p["id"], "segment": seg["name"], "size": seg["size"], "base": None, "status": "failed"}
                    )
                    steps.append(
                        Step(
                            tick=tick,
                            state=_state(blocks, mode, segment_table, memory_size),
                            explanation=f"{p['id']}:{seg['name']} ({seg['size']}) could NOT be placed.",
                        )
                    )
                else:
                    segment_table.append(
                        {
                            "process": p["id"],
                            "segment": seg["name"],
                            "size": seg["size"],
                            "base": placed["start"],
                            "limit": placed["start"] + seg["size"],
                            "status": "allocated",
                        }
                    )
                    steps.append(
                        Step(
                            tick=tick,
                            state=_state(blocks, mode, segment_table, memory_size),
                            highlight=[f"{p['id']}:{seg['name']}"],
                            explanation=f"{p['id']}:{seg['name']} ({seg['size']}) placed at {placed['start']} using {strategy}.",
                        )
                    )

    # --- Compute aggregate metrics -----------------------------------
    total_free = sum(b["size"] for b in blocks if b["type"] == "free")
    largest_free = max((b["size"] for b in blocks if b["type"] == "free"), default=0)
    allocated = memory_size - total_free
    # External fragmentation: 1 - (largest_free_hole / total_free).
    # Value near 0 means free space is consolidated; near 1 means heavily fragmented.
    external_frag = round(1 - (largest_free / total_free), 3) if total_free > 0 else 0.0

    metrics = {
        "memory_utilization": round(allocated / memory_size, 3),
        "total_free": total_free,
        "largest_free_hole": largest_free,
        "external_fragmentation": external_frag,
        "failed_allocations": failed,
        "segment_table": segment_table if mode == "segmentation" else [],
    }
    if failed:
        warnings.append(f"Could not place: {', '.join(failed)}")
    return SimulationResult(steps=steps, metrics=metrics, warnings=warnings)


def _state(
    blocks: list[dict[str, Any]],
    mode: str,
    segment_table: list[dict[str, Any]],
    memory_size: int = 0,
) -> dict[str, Any]:
    """
    Build the state dictionary for a Step.

    Captures the current block layout (allocated vs free), the mode, and the
    segment table (for segmentation mode).  Used both for the initial state
    and after every placement attempt.

    Args:
        blocks: Current list of memory blocks.
        mode: "contiguous" or "segmentation".
        segment_table: List of segment placement records (segmentation only).
        memory_size: Total memory size (defaults to sum of all block sizes).

    Returns:
        A dict for the ``state`` field of a ``Step``.
    """
    return {
        "mode": mode,
        "blocks": [dict(b) for b in blocks],          # deep-ish copy so history isn't mutated
        "segment_table": [dict(s) for s in segment_table],
        "memory_size": memory_size or sum(b["size"] for b in blocks),
    }
