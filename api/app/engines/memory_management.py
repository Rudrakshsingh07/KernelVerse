from __future__ import annotations

from typing import Any

from .base import SimulationResult, Step

MODES = ["contiguous", "segmentation"]
STRATEGIES = ["first-fit", "best-fit", "worst-fit"]


def validate(payload: dict[str, Any]) -> list[str]:
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
                if not isinstance(p.get("size"), int) or p["size"] <= 0:
                    errors.append(f"process '{pid}': size must be a positive integer")
            else:
                segs = p.get("segments")
                if not isinstance(segs, list) or not segs:
                    errors.append(f"process '{pid}': segments must be a non-empty list")
                else:
                    for j, s in enumerate(segs):
                        if not s.get("name"):
                            errors.append(f"process '{pid}' segment {j}: name required")
                        if not isinstance(s.get("size"), int) or s["size"] <= 0:
                            errors.append(f"process '{pid}' segment '{s.get('name')}': size must be positive")

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
    if strategy == "first-fit":
        return min(free, key=lambda b: b["start"])
    if strategy == "best-fit":
        return min(free, key=lambda b: (b["size"], b["start"]))
    return max(free, key=lambda b: (b["size"], -b["start"]))


def _alloc(blocks: list[dict[str, Any]], size: int, owner: str, label: str, strategy: str) -> dict[str, Any] | None:
    free = [b for b in blocks if b["type"] == "free" and b["size"] >= size]
    if not free:
        return None
    hole = _pick(free, strategy)
    idx = blocks.index(hole)
    blocks[idx] = {"start": hole["start"], "size": size, "type": "allocated", "owner": owner, "label": label}
    if hole["size"] > size:
        blocks.insert(idx + 1, {"start": hole["start"] + size, "size": hole["size"] - size, "type": "free", "owner": None, "label": "free"})
    return blocks[idx]


def run(payload: dict[str, Any]) -> SimulationResult:
    mode = payload.get("mode", "contiguous")
    strategy = payload.get("strategy", "first-fit")
    memory_size = payload["memory_size"]
    processes = payload["processes"]

    holes = payload.get("holes")
    if holes:
        blocks: list[dict[str, Any]] = [
            {"start": h["start"], "size": h["size"], "type": "free", "owner": None, "label": "free"} for h in sorted(holes, key=lambda h: h["start"])
        ]
    else:
        blocks = [{"start": 0, "size": memory_size, "type": "free", "owner": None, "label": "free"}]

    steps: list[Step] = []
    warnings: list[str] = []
    segment_table: list[dict[str, Any]] = []
    failed: list[str] = []
    tick = 0

    steps.append(Step(tick=tick, state=_state(blocks, mode, segment_table, memory_size), explanation=f"Initial memory: {len(blocks)} free hole(s), {memory_size} units total."))

    if mode == "contiguous":
        for p in processes:
            tick += 1
            placed = _alloc(blocks, p["size"], p["id"], p["id"], strategy)
            if placed is None:
                failed.append(p["id"])
                steps.append(Step(tick=tick, state=_state(blocks, mode, segment_table, memory_size), explanation=f"{p['id']} ({p['size']}) could NOT be placed — no free hole large enough."))
            else:
                steps.append(Step(tick=tick, state=_state(blocks, mode, segment_table, memory_size), highlight=[p["id"]], explanation=f"{p['id']} ({p['size']}) placed at address {placed['start']} using {strategy}."))
    else:
        for p in processes:
            for seg in p["segments"]:
                tick += 1
                placed = _alloc(blocks, seg["size"], p["id"], f"{p['id']}:{seg['name']}", strategy)
                if placed is None:
                    failed.append(f"{p['id']}:{seg['name']}")
                    segment_table.append({"process": p["id"], "segment": seg["name"], "size": seg["size"], "base": None, "status": "failed"})
                    steps.append(Step(tick=tick, state=_state(blocks, mode, segment_table, memory_size), explanation=f"{p['id']}:{seg['name']} ({seg['size']}) could NOT be placed."))
                else:
                    segment_table.append({"process": p["id"], "segment": seg["name"], "size": seg["size"], "base": placed["start"], "limit": placed["start"] + seg["size"], "status": "allocated"})
                    steps.append(Step(tick=tick, state=_state(blocks, mode, segment_table, memory_size), highlight=[f"{p['id']}:{seg['name']}"], explanation=f"{p['id']}:{seg['name']} ({seg['size']}) placed at {placed['start']} using {strategy}."))

    total_free = sum(b["size"] for b in blocks if b["type"] == "free")
    largest_free = max((b["size"] for b in blocks if b["type"] == "free"), default=0)
    allocated = memory_size - total_free if total_free <= memory_size else memory_size - sum(b["size"] for b in blocks if b["type"] == "free")
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


def _state(blocks: list[dict[str, Any]], mode: str, segment_table: list[dict[str, Any]], memory_size: int = 0) -> dict[str, Any]:
    return {
        "mode": mode,
        "blocks": [dict(b) for b in blocks],
        "segment_table": [dict(s) for s in segment_table],
        "memory_size": memory_size or sum(b["size"] for b in blocks),
    }
