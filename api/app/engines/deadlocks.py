"""
Deadlock simulation engine.

Supports two modes:

    banker     - Banker's safety algorithm (deadlock avoidance).
                 Computes Need = Max - Allocation, then repeatedly finds a
                 process whose Need <= Work, simulates it finishing, and
                 releases its resources.  If all processes finish, the state
                 is safe and a safe sequence is returned; otherwise it is
                 unsafe and deadlock is possible.

    detection  - Wait-for-graph deadlock detection.
                 Builds a directed graph where P_i -> P_j if P_i needs a
                 resource held by P_j, then runs DFS cycle detection.
                 A cycle means deadlock exists.

Public contract (see base.py):
    validate(payload) -> list[str]
    run(payload)      -> SimulationResult
"""

from __future__ import annotations

from typing import Any

from .base import SimulationResult, Step

MODES = ["banker", "detection"]


def validate(payload: dict[str, Any]) -> list[str]:
    """
    Validate the deadlocks input payload.

    Checks mode, process list, resource list (each with id and total),
    allocation/max matrices, and available vector.  In banker mode also
    checks allocation <= max and that available + total allocated <= total
    instances for every resource.

    Args:
        payload: JSON dict with mode, processes, resources, allocation, max, available.

    Returns:
        List of human-readable error strings; empty list means valid.
    """
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

    # Build a flat list of valid resource IDs for matrix validation.
    rid_list = [r["id"] for r in resources if isinstance(r, dict) and r.get("id")]

    def _check_matrix(name: str, matrix: Any) -> None:
        """Validate an allocation/max matrix: process -> {resource: instances}."""
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

    # Banker-specific consistency checks.
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
            # available + total allocated must not exceed total instances.
            total_alloc = sum(
                allocation.get(other, {}).get(rname, 0) for other in seen
            )
            if available.get(rname, 0) + total_alloc > total_map[rname]:
                errors.append(
                    f"available['{rname}'] plus total allocated exceeds total instances ({total_map[rname]})"
                )
    return errors


def run(payload: dict[str, Any]) -> SimulationResult:
    """
    Execute the deadlock simulation in either banker or detection mode.

    Banker mode:
        1. Normalize allocation/max/available matrices (missing entries = 0).
        2. Compute Need = Max - Allocation.
        3. Repeatedly scan for an unfinished process whose Need <= Work.
        4. When found, simulate it finishing: release its allocated resources
           back to Work, append to safe sequence.
        5. If all finish -> safe. Otherwise -> unsafe / possible deadlock.
        6. Append a final verdict step (complete or stuck).

    Detection mode:
        1. Build a wait-for graph one process at a time: P_i waits for P_j if
           P_i needs more of a resource than is available and P_j holds an
           instance of that resource.  Each inspected process gets a step so
           the frontend can animate the graph being assembled.
        2. Run DFS with white/gray/black coloring to detect a cycle.
        3. A cycle = deadlock; report the cycle path and append a verdict step.

    Args:
        payload: Validated input with mode, processes, resources, matrices.

    Returns:
        SimulationResult with steps, metrics, and warnings.
    """
    mode = payload.get("mode", "banker")
    processes: list[str] = payload["processes"]
    resources: list[dict[str, Any]] = payload["resources"]
    rid_list = [r["id"] for r in resources]
    total_map = {r["id"]: r["total"] for r in resources}

    allocation = payload.get("allocation", {})
    max_mat = payload.get("max", {})
    available = dict(payload.get("available", {}))

    # --- Normalize matrices: missing entries default to 0 -----------------
    alloc: dict[str, dict[str, int]] = {
        p: {r: int(allocation.get(p, {}).get(r, 0)) for r in rid_list} for p in processes
    }
    maxm: dict[str, dict[str, int]] = {
        p: {r: int(max_mat.get(p, {}).get(r, 0)) for r in rid_list} for p in processes
    }
    work: dict[str, int] = {r: int(available.get(r, 0)) for r in rid_list}
    initial_available: dict[str, int] = dict(work)
    need: dict[str, dict[str, int]] = {
        p: {r: maxm[p][r] - alloc[p][r] for r in rid_list} for p in processes
    }

    steps: list[Step] = []
    warnings: list[str] = []
    tick = 0

    def _state(extra: dict[str, Any] | None = None) -> dict[str, Any]:
        """Build the state dict for a Step (matrices, available, work, etc.)."""
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
            "initial_available": dict(initial_available),
            # Which processes currently hold at least one instance of each
            # resource.  The frontend uses this to label wait-for edges.
            "holders": {
                r: [p for p in processes if alloc[p][r] > 0] for r in rid_list
            },
        }
        if extra:
            base_state.update(extra)
        return base_state

    # Record the initial state (Need computed from Max - Allocation).
    initial_extra: dict[str, Any] = {
        "phase": "init",
        "note": "Initial state. Need = Max - Allocation.",
    }
    if mode == "banker":
        initial_extra.update(
            {"safe_sequence": [], "finished": [], "unfinished": list(processes)}
        )
    else:
        initial_extra.update(
            {
                "wait_for": {p: [] for p in processes},
                "wait_edges": [],
                "inspecting": None,
            }
        )
    steps.append(
        Step(
            tick=tick,
            state=_state(initial_extra),
            explanation="Computed need matrix: Need = Max − Allocation.",
        )
    )

    # Helper for human-readable vector strings such as "A=3, B=3, C=2".
    def _fmt_vec(vec: dict[str, int], *, only_nonzero: bool = False) -> str:
        items = [
            (r, vec[r]) for r in rid_list if not only_nonzero or vec[r] != 0
        ]
        return ", ".join(f"{r}={value}" for r, value in items) or "none"

    # ==================================================================
    # MODE: Banker's safety algorithm (deadlock avoidance)
    # ==================================================================
    if mode == "banker":
        finish: dict[str, bool] = {p: False for p in processes}
        safe_sequence: list[str] = []
        can_proceed = True

        # Repeatedly scan processes; when one can finish, restart the scan.
        while can_proceed:
            can_proceed = False
            for p in processes:
                if finish[p]:
                    continue
                # Check if this process's remaining need can be satisfied.
                if all(need[p][r] <= work[r] for r in rid_list):
                    # Simulate P finishing: release all its allocated resources.
                    work_before = dict(work)
                    released = dict(alloc[p])
                    for r in rid_list:
                        work[r] += alloc[p][r]
                    finish[p] = True
                    safe_sequence.append(p)
                    can_proceed = True
                    tick += 1
                    release_text = _fmt_vec(released, only_nonzero=True)
                    release_phrase = (
                        f"releases {release_text}"
                        if release_text != "none"
                        else "releases no instances"
                    )
                    steps.append(
                        Step(
                            tick=tick,
                            state=_state(
                                {
                                    "phase": "safety-check",
                                    "safe_sequence": list(safe_sequence),
                                    "finished": [q for q in processes if finish[q]],
                                    "unfinished": [
                                        q for q in processes if not finish[q]
                                    ],
                                    "last_executed": p,
                                    "work_before": work_before,
                                    "released": released,
                                    "note": (
                                        f"{p} can finish because Need <= Work. "
                                        f"Its allocation returns to Work."
                                    ),
                                }
                            ),
                            highlight=[p],
                            explanation=(
                                f"{p} selected: Need({_fmt_vec(need[p])}) "
                                f"≤ Work({_fmt_vec(work_before)}). "
                                f"{p} finishes and {release_phrase}; "
                                f"Work becomes {_fmt_vec(work)}."
                            ),
                        )
                    )
                    break  # restart scan from beginning (standard safety algorithm)

        # Decide safe vs unsafe based on whether every process finished.
        if all(finish.values()):
            metrics = {
                "safe": True,
                "safe_sequence": safe_sequence,
                "deadlock": False,
                "unfinished_processes": [],
                "finished_processes": list(safe_sequence),
                "process_count": len(processes),
                "resource_count": len(rid_list),
                "algorithm": "banker's safety algorithm",
            }
            tick += 1
            steps.append(
                Step(
                    tick=tick,
                    state=_state(
                        {
                            "phase": "complete",
                            "safe_sequence": list(safe_sequence),
                            "finished": list(safe_sequence),
                            "unfinished": [],
                            "note": (
                                "Every process finished. The current state is safe."
                            ),
                        }
                    ),
                    explanation=(
                        f"All {len(processes)} processes finished. "
                        f"Safe sequence: {' → '.join(safe_sequence)}."
                    ),
                )
            )
        else:
            unfinished = [p for p in processes if not finish[p]]
            metrics = {
                "safe": False,
                "safe_sequence": safe_sequence,
                "deadlock": True,
                "unfinished_processes": unfinished,
                "finished_processes": [p for p in processes if finish[p]],
                "process_count": len(processes),
                "resource_count": len(rid_list),
                "algorithm": "banker's safety algorithm",
            }
            warnings.append(
                f"Unsafe state: processes {', '.join(unfinished)} cannot finish — deadlock possible."
            )
            tick += 1
            steps.append(
                Step(
                    tick=tick,
                    state=_state(
                        {
                            "phase": "stuck",
                            "safe_sequence": list(safe_sequence),
                            "finished": [p for p in processes if finish[p]],
                            "unfinished": unfinished,
                            "note": (
                                "No unfinished process has Need <= Work, so the "
                                "safety algorithm cannot make progress."
                            ),
                        }
                    ),
                    highlight=unfinished,
                    explanation=(
                        "No unfinished process can satisfy Need <= Work. "
                        f"The state is unsafe; unfinished: {', '.join(unfinished)}."
                    ),
                )
            )

    # ==================================================================
    # MODE: Deadlock detection via wait-for graph cycle detection
    # ==================================================================
    else:
        # Build the wait-for graph one process at a time.  P_i waits for P_j
        # when P_i still needs more of resource r than Work[r] provides and
        # P_j currently holds at least one instance of r.
        wait_for: dict[str, set[str]] = {p: set() for p in processes}
        edge_resources: dict[tuple[str, str], list[str]] = {}

        def _edge_list(
            edges: dict[tuple[str, str], list[str]]
        ) -> list[dict[str, Any]]:
            """Convert an edge -> resource map into a JSON-friendly list."""
            return [
                {"from": src, "to": dst, "via": sorted(set(resources))}
                for (src, dst), resources in sorted(edges.items())
            ]

        for p in processes:
            added_resources: list[str] = []
            for r in rid_list:
                if need[p][r] <= work[r]:
                    continue
                for other in processes:
                    if other != p and alloc[other][r] > 0:
                        wait_for[p].add(other)
                        edge_resources.setdefault((p, other), []).append(r)
                        added_resources.append(r)

            tick += 1
            if wait_for[p]:
                targets = ", ".join(sorted(wait_for[p]))
                via = ", ".join(sorted(set(added_resources))) or "none"
                edge_word = "edge" if len(wait_for[p]) == 1 else "edges"
                explanation = (
                    f"{p} cannot satisfy its remaining Need from Work. "
                    f"Resource(s) {via} are held by {targets}; "
                    f"add wait-for {edge_word} from {p} to {targets}."
                )
            else:
                explanation = (
                    f"{p} does not need a resource that is held by another "
                    f"process. No outgoing wait-for edge."
                )

            steps.append(
                Step(
                    tick=tick,
                    state=_state(
                        {
                            "phase": "build",
                            "wait_for": {q: sorted(wait_for[q]) for q in processes},
                            "wait_edges": _edge_list(edge_resources),
                            "inspecting": p,
                            "note": f"Inspecting {p}'s unmet resource needs.",
                        }
                    ),
                    highlight=[p],
                    explanation=explanation,
                )
            )

        full_wait_for = {p: sorted(wait_for[p]) for p in processes}
        full_edges = _edge_list(edge_resources)

        tick += 1
        steps.append(
            Step(
                tick=tick,
                state=_state(
                    {
                        "phase": "detect",
                        "wait_for": full_wait_for,
                        "wait_edges": full_edges,
                        "inspecting": None,
                        "note": (
                            "Wait-for graph complete. Running DFS cycle detection."
                        ),
                    }
                ),
                explanation=(
                    f"Wait-for graph complete with {len(full_edges)} "
                    f"edge{'' if len(full_edges) == 1 else 's'}. "
                    "Searching for a cycle with DFS."
                ),
            )
        )

        # Detect a cycle using DFS with three-color marking.
        WHITE, GRAY, BLACK = 0, 1, 2
        color: dict[str, int] = {p: WHITE for p in processes}
        cycle: list[str] = []

        def dfs(u: str, path: list[str]) -> bool:
            """
            Depth-first search for a back-edge (cycle) in the wait-for graph.

            Colors: WHITE = unvisited, GRAY = on current recursion stack,
            BLACK = fully processed.  Encountering a GRAY node means a cycle.
            """
            color[u] = GRAY
            path.append(u)
            for v in sorted(wait_for[u]):
                if color[v] == GRAY:
                    # Cycle found: slice the path from v to the current node.
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

        waiting_processes = [p for p in processes if wait_for[p]]
        if deadlock_cycle:
            metrics = {
                "safe": False,
                "deadlock": True,
                "deadlock_cycle": deadlock_cycle,
                "waiting_processes": waiting_processes,
                "wait_edges": full_edges,
                "unfinished_processes": [],
                "process_count": len(processes),
                "resource_count": len(rid_list),
                "algorithm": "wait-for-graph cycle detection",
            }
            warnings.append(f"Deadlock detected: cycle {' -> '.join(deadlock_cycle)}.")
            tick += 1
            steps.append(
                Step(
                    tick=tick,
                    state=_state(
                        {
                            "phase": "complete",
                            "wait_for": full_wait_for,
                            "wait_edges": full_edges,
                            "inspecting": None,
                            "cycle": deadlock_cycle,
                            "deadlock": True,
                            "note": (
                                f"Cycle found: {' → '.join(deadlock_cycle)}. "
                                "Deadlock exists."
                            ),
                        }
                    ),
                    highlight=list(dict.fromkeys(deadlock_cycle[:-1])),
                    explanation=(
                        f"Cycle detected: {' → '.join(deadlock_cycle)}. "
                        "The wait-for graph contains a cycle, so a deadlock exists."
                    ),
                )
            )
        else:
            metrics = {
                "safe": True,
                "deadlock": False,
                "deadlock_cycle": [],
                "waiting_processes": waiting_processes,
                "wait_edges": full_edges,
                "unfinished_processes": [],
                "process_count": len(processes),
                "resource_count": len(rid_list),
                "algorithm": "wait-for-graph cycle detection",
            }
            tick += 1
            steps.append(
                Step(
                    tick=tick,
                    state=_state(
                        {
                            "phase": "complete",
                            "wait_for": full_wait_for,
                            "wait_edges": full_edges,
                            "inspecting": None,
                            "cycle": [],
                            "deadlock": False,
                            "note": (
                                "No cycle found in the wait-for graph. "
                                "No deadlock exists."
                            ),
                        }
                    ),
                    explanation=(
                        "No cycle was found in the wait-for graph, so the "
                        "system is not deadlocked."
                    ),
                )
            )

    return SimulationResult(steps=steps, metrics=metrics, warnings=warnings)
