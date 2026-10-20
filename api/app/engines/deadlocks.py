from __future__ import annotations

from typing import Any

from .base import SimulationResult, Step

MODES = ["banker", "detection"]


def validate(payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    mode = payload.get("mode", "banker")
    if mode not in MODES:
        errors.append(f"mode must be one of {MODES}")

    processes = payload.get("processes")
    if not isinstance(processes, list) or not processes:
        errors.append("processes must be a non-empty list")
    else:
        seen: set[str] = set()
        for i, p in enumerate(processes):
            if not isinstance(p, str) or not p:
                errors.append(f"processes[{i}] must be a non-empty string")
            elif p in seen:
                errors.append(f"duplicate process '{p}'")
            else:
                seen.add(p)

    resources = payload.get("resources")
    if not isinstance(resources, list) or not resources:
        errors.append("resources must be a non-empty list")
        resources = []
    else:
        seen_r: set[str] = set()
        for i, r in enumerate(resources):
            if not isinstance(r, dict):
                errors.append(f"resources[{i}] must be an object")
                continue
            rid = r.get("id")
            total = r.get("total")
            if not rid or not isinstance(rid, str):
                errors.append(f"resources[{i}].id must be a non-empty string")
            elif rid in seen_r:
                errors.append(f"duplicate resource '{rid}'")
            else:
                seen_r.add(rid)
            if not isinstance(total, int) or total <= 0:
                errors.append(f"resource '{rid}': total must be a positive integer")

    rid_list = [r["id"] for r in resources if isinstance(r, dict) and r.get("id")]

    def _check_matrix(name: str, matrix: Any) -> None:
        if not isinstance(matrix, dict):
            errors.append(f"{name} must be an object mapping process -> {{resource: instances}}")
            return
        for pid, row in matrix.items():
            if pid not in seen:
                errors.append(f"{name}: unknown process '{pid}'")
                continue
            if not isinstance(row, dict):
                errors.append(f"{name}['{pid}'] must be an object mapping resource -> instances")
                continue
            for rname, val in row.items():
                if rname not in rid_list:
                    errors.append(f"{name}['{pid}']: unknown resource '{rname}'")
                elif not isinstance(val, int) or val < 0:
                    errors.append(f"{name}['{pid}']['{rname}'] must be a non-negative integer")

    _check_matrix("allocation", payload.get("allocation"))
    _check_matrix("max", payload.get("max"))

    available = payload.get("available")
    if not isinstance(available, dict):
        errors.append("available must be an object mapping resource -> instances")
    else:
        for rname, val in available.items():
            if rname not in rid_list:
                errors.append(f"available: unknown resource '{rname}'")
            elif not isinstance(val, int) or val < 0:
                errors.append(f"available['{rname}'] must be a non-negative integer")

    # Banker's mode: validate allocation <= max and available + allocation <= total
    if mode == "banker" and not errors:
        allocation = payload.get("allocation", {})
        max_mat = payload.get("max", {})
        total_map = {r["id"]: r["total"] for r in resources if isinstance(r, dict)}
        for pid in seen:
            alloc_row = allocation.get(pid, {})
            max_row = max_mat.get(pid, {})
            for rname in rid_list:
                a = alloc_row.get(rname, 0)
                m = max_row.get(rname, 0)
                if a > m:
                    errors.append(f"allocation['{pid}']['{rname}'] ({a}) exceeds max ({m})")
            total_alloc = sum(
                allocation.get(other, {}).get(rname, 0) for other in seen
            )
            if available.get(rname, 0) + total_alloc > total_map[rname]:
                errors.append(
                    f"available['{rname}'] plus total allocated exceeds total instances ({total_map[rname]})"
                )
    return errors


def run(payload: dict[str, Any]) -> SimulationResult:
    mode = payload.get("mode", "banker")
    processes: list[str] = payload["processes"]
    resources: list[dict[str, Any]] = payload["resources"]
    rid_list = [r["id"] for r in resources]
    total_map = {r["id"]: r["total"] for r in resources}

    allocation = payload.get("allocation", {})
    max_mat = payload.get("max", {})
    available = dict(payload.get("available", {}))

    # Normalize missing entries to 0
    alloc: dict[str, dict[str, int]] = {
        p: {r: int(allocation.get(p, {}).get(r, 0)) for r in rid_list} for p in processes
    }
    maxm: dict[str, dict[str, int]] = {
        p: {r: int(max_mat.get(p, {}).get(r, 0)) for r in rid_list} for p in processes
    }
    work: dict[str, int] = {r: int(available.get(r, 0)) for r in rid_list}
    need: dict[str, dict[str, int]] = {
        p: {r: maxm[p][r] - alloc[p][r] for r in rid_list} for p in processes
    }

    steps: list[Step] = []
    warnings: list[str] = []
    tick = 0

    def _state(extra: dict[str, Any] | None = None) -> dict[str, Any]:
        base_state = {
            "mode": mode,
            "processes": processes,
            "resources": rid_list,
            "total": {r: total_map[r] for r in rid_list},
            "allocation": {p: dict(alloc[p]) for p in processes},
            "max": {p: dict(maxm[p]) for p in processes},
            "need": {p: dict(need[p]) for p in processes},
            "available": dict(work),
            "work": dict(work),
        }
        if extra:
            base_state.update(extra)
        return base_state

    steps.append(
        Step(
            tick=tick,
            state=_state({"note": "Initial state. Need = Max - Allocation."}),
            explanation="Computed need matrix: Need = Max − Allocation.",
        )
    )

    if mode == "banker":
        # Banker's safety algorithm
        finish: dict[str, bool] = {p: False for p in processes}
        safe_sequence: list[str] = []
        can_proceed = True

        while can_proceed:
            can_proceed = False
            for p in processes:
                if finish[p]:
                    continue
                # check if need[p] <= work
                if all(need[p][r] <= work[r] for r in rid_list):
                    # simulate P finishing and releasing resources
                    for r in rid_list:
                        work[r] += alloc[p][r]
                    finish[p] = True
                    safe_sequence.append(p)
                    can_proceed = True
                    tick += 1
                    steps.append(
                        Step(
                            tick=tick,
                            state=_state(
                                {
                                    "safe_sequence": list(safe_sequence),
                                    "finished": list(finish.keys()),
                                    "last_executed": p,
                                    "note": f"{p} can finish (Need <= Work); releases {alloc[p]}.",
                                }
                            ),
                            highlight=[p],
                            explanation=f"{p} selected: Need({{r: need[p][r] for r in rid_list}}) <= Work({{r: work[r] for r in rid_list}}). "
                            f"{p} finishes and releases its allocated resources.",
                        )
                    )
                    break  # restart scan from beginning (standard safety algorithm)

        if all(finish.values()):
            metrics = {
                "safe": True,
                "safe_sequence": safe_sequence,
                "deadlock": False,
                "unfinished_processes": [],
                "algorithm": "banker's safety algorithm",
            }
        else:
            unfinished = [p for p in processes if not finish[p]]
            metrics = {
                "safe": False,
                "safe_sequence": safe_sequence,
                "deadlock": True,
                "unfinished_processes": unfinished,
                "algorithm": "banker's safety algorithm",
            }
            warnings.append(f"Unsafe state: processes {', '.join(unfinished)} cannot finish — deadlock possible.")
    else:
        # Deadlock detection via wait-for graph cycle detection
        # Build wait-for graph: P_i waits for P_j if P_i needs a resource held by P_j
        wait_for: dict[str, set[str]] = {p: set() for p in processes}
        holder: dict[str, str] = {}  # resource -> process holding it (simplified: single-instance assumption)
        # For multi-instance, P waits if need > 0 for a resource that is not fully available
        for p in processes:
            for r in rid_list:
                if need[p][r] > 0 and work[r] <= 0:
                    # find a process holding r
                    for other in processes:
                        if other != p and alloc[other].get(r, 0) > 0:
                            wait_for[p].add(other)

        # Detect cycle using DFS
        WHITE, GRAY, BLACK = 0, 1, 2
        color: dict[str, int] = {p: WHITE for p in processes}
        cycle: list[str] = []

        def dfs(u: str, path: list[str]) -> bool:
            color[u] = GRAY
            path.append(u)
            for v in sorted(wait_for[u]):
                if color[v] == GRAY:
                    # found cycle
                    cycle_start = path.index(v)
                    cycle.extend(path[cycle_start:])
                    cycle.append(v)
                    return True
                if color[v] == WHITE and dfs(v, path):
                    return True
            path.pop()
            color[u] = BLACK
            return False

        deadlock_cycle: list[str] = []
        for p in processes:
            if color[p] == WHITE:
                if dfs(p, []):
                    deadlock_cycle = list(cycle)
                    break

        tick += 1
        steps.append(
            Step(
                tick=tick,
                state=_state({"wait_for": {p: sorted(wait_for[p]) for p in processes}}),
                explanation="Built wait-for graph from unmet resource needs.",
            )
        )

        if deadlock_cycle:
            metrics = {
                "safe": False,
                "deadlock": True,
                "deadlock_cycle": deadlock_cycle,
                "unfinished_processes": [],
                "algorithm": "wait-for-graph cycle detection",
            }
            warnings.append(f"Deadlock detected: cycle {' -> '.join(deadlock_cycle)}.")
        else:
            metrics = {
                "safe": True,
                "deadlock": False,
                "deadlock_cycle": [],
                "unfinished_processes": [],
                "algorithm": "wait-for-graph cycle detection",
            }

    return SimulationResult(steps=steps, metrics=metrics, warnings=warnings)
