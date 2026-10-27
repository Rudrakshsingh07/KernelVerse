"""
Disk Scheduling simulation engine.

Simulates disk-head movement across a set of I/O requests.  Supports five
algorithms:

    FCFS  - First Come, First Served (serve requests in arrival order)
    SSTF  - Shortest Seek Time First (always pick the closest request)
    SCAN  - Elevator algorithm (sweep to the disk edge, then reverse)
    C-SCAN - Circular SCAN (sweep to the edge, wrap to the other edge,
             and keep travelling in the same logical direction)
    LOOK  - Like SCAN, but reverse at the last request instead of the edge

The engine records one Step per head movement so the frontend can animate the
head position and the sequence of served requests.  It produces total seek
distance, average seek, head movement count, and the full head path.

State contract used by the web UI (in ``Step.state``):
    algorithm, head, direction, disk_size, requests, remaining, served,
    sequence, seek_distances, total_seek, total_requests, last_served,
    seek_distance, head_from, head_to, last_move_kind, is_service, note

Public contract (see base.py):
    validate(payload) -> list[str]
    run(payload)      -> SimulationResult
"""

from __future__ import annotations

from typing import Any

from .base import SimulationResult, Step

ALGORITHMS = ["fcfs", "sstf", "scan", "cscan", "look"]

# Algorithms whose behaviour depends on the initial head direction.
DIRECTIONAL_ALGORITHMS = {"scan", "cscan", "look"}


def _is_int(value: Any) -> bool:
    """Return True only for real integers (``bool`` is a subclass of ``int``)."""
    return isinstance(value, int) and not isinstance(value, bool)


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
    if not _is_int(head) or head < 0:
        errors.append("head must be an integer >= 0")

    disk_size = payload.get("disk_size")
    if not _is_int(disk_size) or disk_size <= 0:
        errors.append("disk_size must be a positive integer")
    elif _is_int(head) and head >= disk_size:
        errors.append("head must be less than disk_size")

    requests = payload.get("requests")
    if not isinstance(requests, list) or not requests:
        errors.append("requests must be a non-empty list")
    else:
        for i, request in enumerate(requests):
            if not _is_int(request) or request < 0:
                errors.append(f"requests[{i}] must be a non-negative integer")
            elif _is_int(disk_size) and request >= disk_size:
                errors.append(
                    f"requests[{i}] ({request}) must be less than disk_size ({disk_size})"
                )

    direction = payload.get("direction", "right")
    if algorithm in DIRECTIONAL_ALGORITHMS and direction not in ("left", "right"):
        errors.append("direction must be 'left' or 'right'")
    return errors


def run(payload: dict[str, Any]) -> SimulationResult:
    """
    Execute the disk-scheduling simulation.

    Each movement of the head is recorded as a Step.  A movement is marked as
    a service (``is_service=True`` and a ``last_served`` request) when it lands
    on a pending I/O request.  SCAN/C-SCAN also record non-service turnaround
    and wrap movements so the seek-time calculation includes the full sweep.

    Args:
        payload: Validated input with algorithm, head, disk_size, requests, direction.

    Returns:
        SimulationResult with steps, metrics, and warnings.
    """
    algorithm = payload["algorithm"]
    head_start = int(payload["head"])
    disk_size = int(payload["disk_size"])
    requests = [int(r) for r in payload["requests"]]

    # FCFS and SSTF do not conceptually use a direction.  Keep "right" as the
    # default so every Step has a consistent shape for the UI.
    initial_direction = payload.get("direction", "right")
    if initial_direction not in ("left", "right"):
        initial_direction = "right"

    steps: list[Step] = []
    warnings: list[str] = []
    tick = 0

    head = head_start                 # current head position
    direction = initial_direction     # most recent travel direction
    remaining = list(requests)        # requests not yet served
    served: list[int] = []            # requests in service order
    sequence: list[int] = [head_start]  # full path the head takes (starts at head)
    seek_distances: list[int] = []      # distance of each individual move
    total_seek = 0                      # cumulative seek distance

    # Snapshot values describing the most recent movement.  They are stored in
    # every Step so the UI can draw the "from → to" motion arrow.
    last_served: int | None = None
    last_seek = 0
    last_from = head_start
    last_to = head_start
    last_move_kind = "init"

    def _state(extra: dict[str, Any] | None = None) -> dict[str, Any]:
        """Build the complete state dict for a Step."""
        base_state = {
            "algorithm": algorithm,
            "head": head,
            "direction": direction,
            "disk_size": disk_size,
            "requests": requests,
            "remaining": list(remaining),
            "served": list(served),
            "sequence": list(sequence),
            "seek_distances": list(seek_distances),
            "total_seek": total_seek,
            "total_requests": len(requests),
            "last_served": last_served,
            "seek_distance": last_seek,
            "head_from": last_from,
            "head_to": last_to,
            "last_move_kind": last_move_kind,
            "is_service": last_move_kind == "serve",
        }
        if extra:
            base_state.update(extra)
        return base_state

    def record_move(
        position: int,
        *,
        served_request: int | None = None,
        kind: str,
        note: str,
        explanation: str,
    ) -> None:
        """
        Move the head to ``position`` and append a Step.

        Args:
            position: Destination cylinder.
            served_request: Request served by this move, or None for a
                turnaround/wrap movement.
            kind: "serve", "turn" (edge reversal), or "wrap" (C-SCAN jump).
            note: Short state-machine note stored in the Step state.
            explanation: Teaching sentence shown by the player.
        """
        nonlocal head, direction, tick, total_seek
        nonlocal last_served, last_seek, last_from, last_to, last_move_kind

        origin = head
        distance = abs(position - origin)

        # Track the physical direction of travel.  Zero-distance moves (serving
        # a request already under the head) keep the previous direction.
        if position > origin:
            direction = "right"
        elif position < origin:
            direction = "left"

        total_seek += distance
        seek_distances.append(distance)
        head = position
        sequence.append(position)
        tick += 1

        last_from = origin
        last_to = position
        last_seek = distance
        last_move_kind = kind
        highlight: list[str] = []

        if served_request is not None:
            if served_request in remaining:
                remaining.remove(served_request)
            served.append(served_request)
            last_served = served_request
            highlight = [str(served_request)]

        steps.append(
            Step(
                tick=tick,
                state=_state({"note": note}),
                highlight=highlight,
                explanation=explanation,
            )
        )

    # Record the initial state (tick 0).
    steps.append(
        Step(
            tick=tick,
            state=_state(
                {
                    "note": "Initial state. No requests have been served yet.",
                }
            ),
            explanation=(
                f"Disk scheduling with {algorithm.upper()}. "
                f"Head starts at cylinder {head_start} moving {direction}."
            ),
        )
    )

    # ==================================================================
    # FCFS — serve requests in the exact order given
    # ==================================================================
    if algorithm == "fcfs":
        for request in list(requests):
            origin = head
            record_move(
                request,
                served_request=request,
                kind="serve",
                note=f"FCFS: serve {request} next.",
                explanation=(
                    f"FCFS: serve request {request}; head moves {origin} → "
                    f"{request}, seek = {abs(request - origin)}."
                ),
            )

    # ==================================================================
    # SSTF — always serve the closest remaining request
    # ==================================================================
    elif algorithm == "sstf":
        while remaining:
            origin = head
            # Break distance ties by cylinder number so traces are deterministic.
            closest = min(remaining, key=lambda r: (abs(r - origin), r))
            record_move(
                closest,
                served_request=closest,
                kind="serve",
                note=f"SSTF: nearest request to {origin} is {closest}.",
                explanation=(
                    f"SSTF: serve {closest}, the shortest seek from {origin} "
                    f"(distance {abs(closest - origin)})."
                ),
            )

    # ==================================================================
    # SCAN / C-SCAN / LOOK — directional (elevator-style) algorithms
    # ==================================================================
    elif algorithm in DIRECTIONAL_ALGORITHMS:
        start = head_start

        if initial_direction == "right":
            # Requests ahead of the head are served in ascending order.
            upper = sorted([r for r in requests if r >= start])
            # Requests behind the head are served on the return/wrap pass.
            lower = sorted([r for r in requests if r < start], reverse=True)

            for request in upper:
                origin = head
                record_move(
                    request,
                    served_request=request,
                    kind="serve",
                    note=f"{algorithm.upper()}: moving right, serve {request}.",
                    explanation=(
                        f"{algorithm.upper()} (right): serve {request}; head moves "
                        f"{origin} → {request}, seek = {abs(request - origin)}."
                    ),
                )

            if algorithm == "scan" and remaining:
                # SCAN continues to the physical end of the disk before
                # reversing, even if the last request was earlier.
                end = disk_size - 1
                if head != end:
                    origin = head
                    record_move(
                        end,
                        kind="turn",
                        note=f"SCAN: reached disk end {end}; reversing direction.",
                        explanation=(
                            f"SCAN: continue to the end of the disk ({end}), then "
                            f"reverse (seek to edge = {abs(end - origin)})."
                        ),
                    )
                for request in lower:
                    origin = head
                    record_move(
                        request,
                        served_request=request,
                        kind="serve",
                        note=f"SCAN: moving left, serve {request}.",
                        explanation=(
                            f"SCAN (left): serve {request}; head moves {origin} → "
                            f"{request}, seek = {abs(request - origin)}."
                        ),
                    )

            elif algorithm == "look" and remaining:
                # LOOK reverses at the last request instead of the disk edge.
                for request in lower:
                    origin = head
                    record_move(
                        request,
                        served_request=request,
                        kind="serve",
                        note=f"LOOK: reversed at last request; serve {request}.",
                        explanation=(
                            f"LOOK (left): reverse at the last request and serve "
                            f"{request}; seek = {abs(request - origin)}."
                        ),
                    )

            elif algorithm == "cscan" and remaining:
                # C-SCAN returns to cylinder 0 and continues rightward.
                end = disk_size - 1
                if head != end:
                    origin = head
                    record_move(
                        end,
                        kind="turn",
                        note=f"C-SCAN: travel to disk end {end}.",
                        explanation=(
                            f"C-SCAN: travel to the end of the disk ({end}) before "
                            f"wrapping (seek to edge = {abs(end - origin)})."
                        ),
                    )
                origin = head
                record_move(
                    0,
                    kind="wrap",
                    note="C-SCAN: wrapped from end to cylinder 0.",
                    explanation=(
                        f"C-SCAN: wrap from {origin} back to cylinder 0 without "
                        f"serving requests (return seek = {origin})."
                    ),
                )
                for request in sorted(remaining):
                    origin = head
                    record_move(
                        request,
                        served_request=request,
                        kind="serve",
                        note=f"C-SCAN: wrapped pass, serve {request}.",
                        explanation=(
                            f"C-SCAN (wrapped pass): serve {request}; head moves "
                            f"{origin} → {request}, seek = {abs(request - origin)}."
                        ),
                    )

        else:
            # ----------------------------------------------------------
            # direction == "left"
            # ----------------------------------------------------------
            lower = sorted([r for r in requests if r <= start], reverse=True)
            upper = sorted([r for r in requests if r > start])

            for request in lower:
                origin = head
                record_move(
                    request,
                    served_request=request,
                    kind="serve",
                    note=f"{algorithm.upper()}: moving left, serve {request}.",
                    explanation=(
                        f"{algorithm.upper()} (left): serve {request}; head moves "
                        f"{origin} → {request}, seek = {abs(request - origin)}."
                    ),
                )

            if algorithm == "scan" and remaining:
                # SCAN continues to cylinder 0 before reversing right.
                if head != 0:
                    origin = head
                    record_move(
                        0,
                        kind="turn",
                        note="SCAN: reached disk start 0; reversing direction.",
                        explanation=(
                            f"SCAN: continue to the start of the disk (0), then "
                            f"reverse (seek to edge = {origin})."
                        ),
                    )
                for request in upper:
                    origin = head
                    record_move(
                        request,
                        served_request=request,
                        kind="serve",
                        note=f"SCAN: moving right, serve {request}.",
                        explanation=(
                            f"SCAN (right): serve {request}; head moves {origin} → "
                            f"{request}, seek = {abs(request - origin)}."
                        ),
                    )

            elif algorithm == "look" and remaining:
                # LOOK reverses at the last request instead of cylinder 0.
                for request in upper:
                    origin = head
                    record_move(
                        request,
                        served_request=request,
                        kind="serve",
                        note=f"LOOK: reversed at last request; serve {request}.",
                        explanation=(
                            f"LOOK (right): reverse at the last request and serve "
                            f"{request}; seek = {abs(request - origin)}."
                        ),
                    )

            elif algorithm == "cscan" and remaining:
                # C-SCAN goes to 0, jumps to the last cylinder, and keeps
                # moving left (descending cylinders) on the wrapped pass.
                if head != 0:
                    origin = head
                    record_move(
                        0,
                        kind="turn",
                        note="C-SCAN: travel to disk start 0.",
                        explanation=(
                            f"C-SCAN: travel to the start of the disk (0) before "
                            f"wrapping (seek to edge = {origin})."
                        ),
                    )
                origin = head
                record_move(
                    disk_size - 1,
                    kind="wrap",
                    note=f"C-SCAN: wrapped from 0 to cylinder {disk_size - 1}.",
                    explanation=(
                        f"C-SCAN: wrap from 0 to cylinder {disk_size - 1} without "
                        f"serving requests (return seek = {disk_size - 1})."
                    ),
                )
                for request in sorted(remaining, reverse=True):
                    origin = head
                    record_move(
                        request,
                        served_request=request,
                        kind="serve",
                        note=f"C-SCAN: wrapped pass, serve {request}.",
                        explanation=(
                            f"C-SCAN (wrapped pass): serve {request}; head moves "
                            f"{origin} → {request}, seek = {abs(request - origin)}."
                        ),
                    )

    # --- Aggregate metrics -------------------------------------------
    avg_seek = round(total_seek / len(requests), 3) if requests else 0
    metrics = {
        "total_seek": total_seek,
        "average_seek": avg_seek,
        "head_movements": len(seek_distances),
        "service_order": list(served),
        "request_count": len(requests),
        "initial_head": head_start,
        "initial_direction": initial_direction,
        "disk_size": disk_size,
        "sequence": sequence,
        "seek_distances": seek_distances,
        "algorithm": algorithm,
    }

    if len(served) != len(requests):
        warnings.append(
            f"Only {len(served)} of {len(requests)} requests were served."
        )
    if requests and total_seek > disk_size * len(requests):
        warnings.append(
            "High total seek distance — try SCAN, C-SCAN, or LOOK to reduce travel."
        )

    return SimulationResult(steps=steps, metrics=metrics, warnings=warnings)
