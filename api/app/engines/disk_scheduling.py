"""
Disk Scheduling simulation engine.

Simulates disk-head movement across a set of I/O requests.  Supports five
algorithms:

    FCFS - First Come, First Served (serve requests in arrival order)
    SSTF - Shortest Seek Time First (always pick the closest request)
    SCAN - Elevator algorithm (move in one direction to disk end, reverse)
    C-SCAN - Circular SCAN (go to end, jump to start, continue same direction)
    LOOK - Like SCAN but only go as far as the last request in each direction

The engine records one Step per head movement so the frontend can animate the
head position and the sequence of served requests.  It produces total seek
distance, average seek, head movement count, and the full head path.

Public contract (see base.py):
    validate(payload) -> list[str]
    run(payload)      -> SimulationResult
"""

from __future__ import annotations

from typing import Any

from .base import SimulationResult, Step

ALGORITHMS = ["fcfs", "sstf", "scan", "cscan", "look"]


def validate(payload: dict[str, Any]) -> list[str]:
    """
    Validate the disk-scheduling input payload.

    Checks algorithm name, initial head position, disk size, request list, and
    direction (required for SCAN/C-SCAN/LOOK).

    Args:
        payload: JSON dict with algorithm, head, disk_size, requests, direction.

    Returns:
        List of human-readable error strings; empty list means valid.
    """
    errors: list[str] = []
    algorithm = payload.get("algorithm")
    if algorithm not in ALGORITHMS:
        errors.append(f"algorithm must be one of {ALGORITHMS}")

    head = payload.get("head")
    if not isinstance(head, int) or head < 0:
        errors.append("head must be an integer >= 0")

    disk_size = payload.get("disk_size")
    if not isinstance(disk_size, int) or disk_size <= 0:
        errors.append("disk_size must be a positive integer")
    elif isinstance(head, int) and head >= disk_size:
        errors.append("head must be less than disk_size")

    requests = payload.get("requests")
    if not isinstance(requests, list) or not requests:
        errors.append("requests must be a non-empty list")
    else:
        for i, r in enumerate(requests):
            if not isinstance(r, int) or r < 0:
                errors.append(f"requests[{i}] must be a non-negative integer")
            elif isinstance(disk_size, int) and r >= disk_size:
                errors.append(f"requests[{i}] ({r}) must be less than disk_size ({disk_size})")

    direction = payload.get("direction", "right")
    if algorithm in ("scan", "cscan", "look") and direction not in ("left", "right"):
        errors.append("direction must be 'left' or 'right'")
    return errors


def run(payload: dict[str, Any]) -> SimulationResult:
    """
    Execute the disk-scheduling simulation.

    Depending on the algorithm, the head moves across the disk servicing
    requests.  Each movement (including travel to the disk end or the jump
    back in C-SCAN) is recorded as a Step with the seek distance and an
    explanation.

    After all requests are served, compute total seek, average seek, movement
    count, and the full head sequence.

    Args:
        payload: Validated input with algorithm, head, disk_size, requests, direction.

    Returns:
        SimulationResult with steps, metrics, and warnings.
    """
    algorithm = payload["algorithm"]
    head_start = int(payload["head"])
    disk_size = int(payload["disk_size"])
    requests = [int(r) for r in payload["requests"]]
    direction = payload.get("direction", "right")

    steps: list[Step] = []
    warnings: list[str] = []
    tick = 0

    head = head_start           # current head position
    remaining = list(requests)  # requests not yet served
    sequence: list[int] = [head_start]  # full path the head takes (starts at head)
    seek_distances: list[int] = []      # distance of each individual move
    total_seek = 0                      # cumulative seek distance

    def _state(extra: dict[str, Any] | None = None) -> dict[str, Any]:
        """Build the state dict for a Step (head, remaining, sequence, etc.)."""
        base_state = {
            "algorithm": algorithm,
            "head": head,
            "direction": direction,
            "disk_size": disk_size,
            "requests": requests,
            "remaining": list(remaining),
            "sequence": list(sequence),
            "seek_distances": list(seek_distances),
            "total_seek": total_seek,
        }
        if extra:
            base_state.update(extra)
        return base_state

    # Record the initial state.
    steps.append(
        Step(
            tick=tick,
            state=_state({"note": "Initial state. Head starts at position."}),
            explanation=f"Disk scheduling with {algorithm.upper()}. Head starts at {head_start}.",
        )
    )

    # ==================================================================
    # ALGORITHM: FCFS — serve requests in the exact order given
    # ==================================================================
    if algorithm == "fcfs":
        for req in remaining:
            dist = abs(req - head)
            total_seek += dist
            seek_distances.append(dist)
            head = req
            sequence.append(req)
            tick += 1
            steps.append(
                Step(
                    tick=tick,
                    state=_state(
                        {
                            "last_served": req,
                            "seek_distance": dist,
                            "note": f"Moved head from {sequence[-2]} to {req} (seek {dist}).",
                        }
                    ),
                    highlight=[str(req)],
                    explanation=f"Serve request {req}: head moves {sequence[-2]} → {req}, seek = {dist}.",
                )
            )

    # ==================================================================
    # ALGORITHM: SSTF — always serve the closest remaining request
    # ==================================================================
    elif algorithm == "sstf":
        current = head_start
        while remaining:
            # Pick the request with the smallest distance from current head.
            closest = min(remaining, key=lambda r: (abs(r - current), r))
            dist = abs(closest - current)
            total_seek += dist
            seek_distances.append(dist)
            remaining.remove(closest)
            current = closest
            sequence.append(closest)
            tick += 1
            steps.append(
                Step(
                    tick=tick,
                    state=_state(
                        {
                            "last_served": closest,
                            "seek_distance": dist,
                            "note": f"SSTF: closest to {sequence[-2]} is {closest} (seek {dist}).",
                        }
                    ),
                    highlight=[str(closest)],
                    explanation=f"SSTF: serve {closest} (shortest seek from {sequence[-2]}, distance {dist}).",
                )
            )
        head = current

    # ==================================================================
    # ALGORITHM: SCAN / C-SCAN / LOOK — directional (elevator-style)
    # ==================================================================
    elif algorithm in ("scan", "cscan", "look"):
        current = head_start
        pending = sorted(remaining)

        if direction == "right":
            # Service requests at or above the current head, ascending.
            upper = sorted([r for r in pending if r >= current])
            # Requests below current head, descending (for the return pass).
            lower = sorted([r for r in pending if r < current], reverse=True)

            # --- First pass: move right, servicing upper requests ------
            for req in upper:
                dist = abs(req - current)
                total_seek += dist
                seek_distances.append(dist)
                current = req
                sequence.append(req)
                remaining.remove(req)
                tick += 1
                steps.append(
                    Step(
                        tick=tick,
                        state=_state(
                            {
                                "last_served": req,
                                "seek_distance": dist,
                                "note": f"Moving right: serve {req} (seek {dist}).",
                            }
                        ),
                        highlight=[str(req)],
                        explanation=f"SCAN (right): serve {req}, head moves {sequence[-2]} → {req}, seek = {dist}.",
                    )
                )

            if algorithm == "scan":
                # SCAN: travel to the disk end, then reverse direction.
                end = disk_size - 1
                if current != end:
                    dist = abs(end - current)
                    total_seek += dist
                    seek_distances.append(dist)
                    current = end
                    sequence.append(end)
                    tick += 1
                    steps.append(
                        Step(
                            tick=tick,
                            state=_state(
                                {
                                    "last_served": end,
                                    "seek_distance": dist,
                                    "note": f"Reached disk end {end}; reversing direction.",
                                }
                            ),
                            highlight=[],
                            explanation=f"Reached end of disk ({end}), reversing direction.",
                        )
                    )
                # --- Return pass: move left, servicing lower requests ---
                for req in lower:
                    dist = abs(req - current)
                    total_seek += dist
                    seek_distances.append(dist)
                    current = req
                    sequence.append(req)
                    remaining.remove(req)
                    tick += 1
                    steps.append(
                        Step(
                            tick=tick,
                            state=_state(
                                {
                                    "last_served": req,
                                    "seek_distance": dist,
                                    "note": f"Moving left: serve {req} (seek {dist}).",
                                }
                            ),
                            highlight=[str(req)],
                            explanation=f"SCAN (left): serve {req}, head moves {sequence[-2]} → {req}, seek = {dist}.",
                        )
                    )

            elif algorithm == "cscan":
                # C-SCAN: jump back to the start (0) without servicing,
                # then continue servicing requests below the original head.
                if current != 0:
                    dist = current  # jump back to 0 (counted as movement here)
                    total_seek += dist
                    seek_distances.append(dist)
                    current = 0
                    sequence.append(0)
                    tick += 1
                    steps.append(
                        Step(
                            tick=tick,
                            state=_state(
                                {
                                    "last_served": 0,
                                    "seek_distance": dist,
                                    "note": "C-SCAN: jump back to start of disk.",
                                }
                            ),
                            highlight=[],
                            explanation="C-SCAN: jump back to start (0) without servicing intermediate requests.",
                        )
                    )
                # Service the requests that were below the starting head.
                for req in sorted([r for r in pending if r < head_start]):
                    dist = abs(req - current)
                    total_seek += dist
                    seek_distances.append(dist)
                    current = req
                    sequence.append(req)
                    remaining.remove(req)
                    tick += 1
                    steps.append(
                        Step(
                            tick=tick,
                            state=_state(
                                {
                                    "last_served": req,
                                    "seek_distance": dist,
                                    "note": f"C-SCAN wrap: serve {req} (seek {dist}).",
                                }
                            ),
                            highlight=[str(req)],
                            explanation=f"C-SCAN: serve {req}, head moves {sequence[-2]} → {req}, seek = {dist}.",
                        )
                    )

            elif algorithm == "look":
                # LOOK: reverse direction at the last request (no travel to
                # the physical disk end).
                for req in lower:
                    dist = abs(req - current)
                    total_seek += dist
                    seek_distances.append(dist)
                    current = req
                    sequence.append(req)
                    remaining.remove(req)
                    tick += 1
                    steps.append(
                        Step(
                            tick=tick,
                            state=_state(
                                {
                                    "last_served": req,
                                    "seek_distance": dist,
                                    "note": f"LOOK reverse: serve {req} (seek {dist}).",
                                }
                            ),
                            highlight=[str(req)],
                            explanation=f"LOOK: serve {req}, head moves {sequence[-2]} → {req}, seek = {dist}.",
                        )
                    )

        else:
            # ==========================================================
            # direction == "left"
            # ==========================================================
            # Service requests at or below the current head, descending.
            lower = sorted([r for r in pending if r <= current], reverse=True)
            # Requests above current head, ascending (for the return pass).
            upper = sorted([r for r in pending if r > current])

            # --- First pass: move left, servicing lower requests ------
            for req in lower:
                dist = abs(req - current)
                total_seek += dist
                seek_distances.append(dist)
                current = req
                sequence.append(req)
                remaining.remove(req)
                tick += 1
                steps.append(
                    Step(
                        tick=tick,
                        state=_state(
                            {
                                "last_served": req,
                                "seek_distance": dist,
                                "note": f"Moving left: serve {req} (seek {dist}).",
                            }
                        ),
                        highlight=[str(req)],
                        explanation=f"SCAN/LOOK (left): serve {req}, head moves {sequence[-2]} → {req}, seek = {dist}.",
                    )
                )

            if algorithm == "scan":
                # SCAN: travel to disk start (0), then reverse right.
                end = 0
                if current != end:
                    dist = abs(end - current)
                    total_seek += dist
                    seek_distances.append(dist)
                    current = end
                    sequence.append(end)
                    tick += 1
                    steps.append(
                        Step(
                            tick=tick,
                            state=_state(
                                {
                                    "last_served": end,
                                    "seek_distance": dist,
                                    "note": f"Reached disk start {end}; reversing direction.",
                                }
                            ),
                            highlight=[],
                            explanation=f"Reached start of disk ({end}), reversing direction.",
                        )
                    )
                # --- Return pass: move right, servicing upper requests ---
                for req in upper:
                    dist = abs(req - current)
                    total_seek += dist
                    seek_distances.append(dist)
                    current = req
                    sequence.append(req)
                    remaining.remove(req)
                    tick += 1
                    steps.append(
                        Step(
                            tick=tick,
                            state=_state(
                                {
                                    "last_served": req,
                                    "seek_distance": dist,
                                    "note": f"Moving right: serve {req} (seek {dist}).",
                                }
                            ),
                            highlight=[str(req)],
                            explanation=f"SCAN (right): serve {req}, head moves {sequence[-2]} → {req}, seek = {dist}.",
                        )
                    )

            elif algorithm == "cscan":
                # C-SCAN left: jump to disk end, then service requests above
                # the original head wrapping around.
                if current != disk_size - 1:
                    end = disk_size - 1
                    dist = abs(end - current)
                    total_seek += dist
                    seek_distances.append(dist)
                    current = end
                    sequence.append(end)
                    tick += 1
                    steps.append(
                        Step(
                            tick=tick,
                            state=_state(
                                {
                                    "last_served": end,
                                    "seek_distance": dist,
                                    "note": "C-SCAN: jump to end of disk.",
                                }
                            ),
                            highlight=[],
                            explanation="C-SCAN: jump to end of disk without servicing.",
                        )
                    )
                # Service requests that were above the starting head.
                for req in sorted([r for r in pending if r > head_start]):
                    dist = abs(req - current)
                    total_seek += dist
                    seek_distances.append(dist)
                    current = req
                    sequence.append(req)
                    remaining.remove(req)
                    tick += 1
                    steps.append(
                        Step(
                            tick=tick,
                            state=_state(
                                {
                                    "last_served": req,
                                    "seek_distance": dist,
                                    "note": f"C-SCAN wrap: serve {req} (seek {dist}).",
                                }
                            ),
                            highlight=[str(req)],
                            explanation=f"C-SCAN: serve {req}, head moves {sequence[-2]} → {req}, seek = {dist}.",
                        )
                    )

            elif algorithm == "look":
                # LOOK left: reverse at the last request, then service upper.
                for req in upper:
                    dist = abs(req - current)
                    total_seek += dist
                    seek_distances.append(dist)
                    current = req
                    sequence.append(req)
                    remaining.remove(req)
                    tick += 1
                    steps.append(
                        Step(
                            tick=tick,
                            state=_state(
                                {
                                    "last_served": req,
                                    "seek_distance": dist,
                                    "note": f"LOOK reverse: serve {req} (seek {dist}).",
                                }
                            ),
                            highlight=[str(req)],
                            explanation=f"LOOK: serve {req}, head moves {sequence[-2]} → {req}, seek = {dist}.",
                        )
                    )

        head = current

    # --- Aggregate metrics -------------------------------------------
    avg_seek = round(total_seek / len(requests), 3) if requests else 0
    metrics = {
        "total_seek": total_seek,
        "average_seek": avg_seek,
        "head_movements": len(seek_distances),
        "sequence": sequence,
        "seek_distances": seek_distances,
        "algorithm": algorithm,
    }
    if total_seek > disk_size * len(requests):
        warnings.append("High total seek time — consider a different algorithm or direction.")
    return SimulationResult(steps=steps, metrics=metrics, warnings=warnings)
