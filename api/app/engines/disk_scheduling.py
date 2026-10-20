from __future__ import annotations

from typing import Any

from .base import SimulationResult, Step

ALGORITHMS = ["fcfs", "sstf", "scan", "cscan", "look"]


def validate(payload: dict[str, Any]) -> list[str]:
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
    algorithm = payload["algorithm"]
    head_start = int(payload["head"])
    disk_size = int(payload["disk_size"])
    requests = [int(r) for r in payload["requests"]]
    direction = payload.get("direction", "right")

    steps: list[Step] = []
    warnings: list[str] = []
    tick = 0

    head = head_start
    remaining = list(requests)
    sequence: list[int] = [head_start]
    seek_distances: list[int] = []
    total_seek = 0

    def _state(extra: dict[str, Any] | None = None) -> dict[str, Any]:
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

    steps.append(
        Step(
            tick=tick,
            state=_state({"note": "Initial state. Head starts at position."}),
            explanation=f"Disk scheduling with {algorithm.upper()}. Head starts at {head_start}.",
        )
    )

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

    elif algorithm == "sstf":
        current = head_start
        while remaining:
            # pick closest request
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

    elif algorithm in ("scan", "cscan", "look"):
        current = head_start
        pending = sorted(remaining)

        if direction == "right":
            # service requests >= current in ascending order
            upper = sorted([r for r in pending if r >= current])
            lower = sorted([r for r in pending if r < current], reverse=True)

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
                # go to disk end then reverse
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
                # jump to start (0) without servicing, then continue right
                if current != 0:
                    dist = current  # jump back to 0 (not counted as seek in some conventions; here we count movement)
                    # C-SCAN typically does not count the jump as servicing but the head moves
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
                # go only to last request in direction, then reverse (no disk end travel)
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
        else:  # direction == "left"
            lower = sorted([r for r in pending if r <= current], reverse=True)
            upper = sorted([r for r in pending if r > current])

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
