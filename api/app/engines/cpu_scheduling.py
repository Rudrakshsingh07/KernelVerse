from __future__ import annotations

from typing import Any, Callable

from .base import SimulationResult, Step

ALGORITHMS = ["fcfs", "sjf", "srtf", "priority", "rr", "mlq"]

MAX_TIME = 5000


def validate(payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    processes = payload.get("processes")
    algorithm = payload.get("algorithm")

    if algorithm not in ALGORITHMS:
        errors.append(f"algorithm must be one of {ALGORITHMS}")
    if not isinstance(processes, list) or not processes:
        errors.append("processes must be a non-empty list")
        return errors

    seen: set[str] = set()
    for i, p in enumerate(processes):
        pid = p.get("id")
        if not pid or not isinstance(pid, str):
            errors.append(f"processes[{i}].id must be a non-empty string")
        elif pid in seen:
            errors.append(f"duplicate process id '{pid}'")
        else:
            seen.add(pid)

        arrival = p.get("arrival")
        burst = p.get("burst")
        if not isinstance(arrival, int) or arrival < 0:
            errors.append(f"process '{pid}': arrival must be an integer >= 0")
        if not isinstance(burst, int) or burst <= 0:
            errors.append(f"process '{pid}': burst must be an integer > 0")
        if algorithm in ("priority", "mlq") and not isinstance(p.get("priority", 1), int):
            errors.append(f"process '{pid}': priority must be an integer")
        if algorithm == "mlq" and p.get("queue", 0) not in (0, 1):
            errors.append(f"process '{pid}': queue must be 0 (high) or 1 (low)")

        # I/O complexity: io_arrival = CPU units consumed before blocking, io_duration = I/O wait
        io_dur = p.get("io_duration", 0) or 0
        io_at = p.get("io_arrival", 0) or 0
        if p.get("io") is not None and not isinstance(p["io"], dict):
            errors.append(f"process '{pid}': io must be an object")
        if not isinstance(io_dur, int) or io_dur < 0:
            errors.append(f"process '{pid}': io_duration must be an integer >= 0")
        if not isinstance(io_at, int) or io_at < 0:
            errors.append(f"process '{pid}': io_arrival must be an integer >= 0")
        if io_dur > 0:
            burst = p.get("burst")
            if isinstance(burst, int) and io_at >= burst:
                errors.append(f"process '{pid}': io_arrival must be less than its burst")

    if algorithm == "rr":
        q = payload.get("quantum", 2)
        if not isinstance(q, int) or q < 1:
            errors.append("quantum must be an integer >= 1")
    if algorithm == "mlq":
        q = payload.get("quantum", 2)
        if not isinstance(q, int) or q < 1:
            errors.append("quantum must be an integer >= 1 (used by the high-priority queue)")
    return errors


def _snapshot(
    time: int,
    running: str | None,
    ready: list[str],
    completed: list[str],
    remaining: dict[str, int],
    processes: list[dict[str, Any]],
    blocked: dict[str, int] | None = None,
) -> dict[str, Any]:
    return {
        "time": time,
        "running": running,
        "ready": list(ready),
        "completed": list(completed),
        "remaining": dict(remaining),
        "blocked": ([{"id": pid, "remaining": r} for pid, r in (blocked or {}).items()]),
        "processes": [
            {
                "id": p["id"],
                "arrival": p["arrival"],
                "burst": p["burst"],
                "priority": p.get("priority", 1),
                "queue": p.get("queue", 0),
                "remaining": remaining[p["id"]],
            }
            for p in processes
        ],
    }


def run(payload: dict[str, Any]) -> SimulationResult:
    algorithm = payload["algorithm"]
    quantum = int(payload.get("quantum", 2))
    processes = sorted(
        [dict(p) for p in payload["processes"]],
        key=lambda p: (p["arrival"], p["id"]),
    )
    for p in processes:
        p.setdefault("priority", 1)
        p.setdefault("queue", 0)
        # normalize I/O spec: flat fields or nested {after_cpu, duration}
        if isinstance(p.get("io"), dict):
            pass
        elif (p.get("io_duration") or 0) > 0:
            p["io"] = {"after_cpu": int(p.get("io_arrival") or 0), "duration": int(p["io_duration"])}
        else:
            p.pop("io", None)

    remaining = {p["id"]: p["burst"] for p in processes}
    waiting = {p["id"]: 0 for p in processes}
    blocked: dict[str, int] = {}
    io_issued: set[str] = set()
    enqueued_at: dict[str, int] = {}  # when the process last entered the ready queue (arrival or I/O completion)
    started: dict[str, int] = {}
    finished_at: dict[str, int] = {}
    completed: list[str] = []

    warnings: list[str] = []
    steps: list[Step] = []

    # order keys for deterministic tie-breaks
    by_id = {p["id"]: p for p in processes}

    ready: list[str] = []
    running: str | None = None
    last_running: str | None = None
    quantum_used = 0
    context_switches = 0
    busy_ticks = 0
    time = 0
    arrived_idx = 0

    def enqueue_arrivals(t: int) -> list[str]:
        nonlocal arrived_idx
        newly = [p["id"] for p in processes if p["arrival"] == t]
        ready.extend(newly)
        for pid in newly:
            enqueued_at[pid] = t
        return newly

    def pick(queue: list[str], key: Callable[[str], Any]) -> str:
        chosen = min(queue, key=key)
        queue.remove(chosen)
        return chosen

    total_burst = sum(p["burst"] for p in processes)
    if total_burst > MAX_TIME:
        warnings.append("Total burst time is very large; trace may be truncated.")

    while len(completed) < len(processes) and time < MAX_TIME:
        arrivals = enqueue_arrivals(time)

        note = ""
        if arrivals:
            note = f"{', '.join(arrivals)} arrived. "

        # processes whose I/O completed re-enter the ready queue
        for pid in list(blocked):
            blocked[pid] -= 1
            if blocked[pid] <= 0:
                del blocked[pid]
                ready.append(pid)
                enqueued_at[pid] = time
                note += f"{pid} finished its I/O and re-entered the ready queue. "

        # decide preemption / next process
        if running is not None and remaining[running] == 0:
            finished_at[running] = time
            completed.append(running)
            note += f"{running} finished. "
            running = None
            quantum_used = 0

        if algorithm == "rr" and running is not None and quantum_used >= quantum:
            ready.append(running)
            enqueued_at[running] = time
            note += f"{running}'s quantum ({quantum}) expired; moved to the back of the ready queue. "
            running = None
            quantum_used = 0

        if algorithm == "srtf" and running is not None:
            contenders = ready
            if contenders:
                shortest = min(
                    contenders,
                    key=lambda pid: (remaining[pid], enqueued_at[pid], pid),
                )
                if remaining[shortest] < remaining[running]:
                    ready.append(running)
                    enqueued_at[running] = time
                    note += f"{running} preempted: {shortest} has shorter remaining time. "
                    running = None
                    quantum_used = 0

        if algorithm == "mlq":
            high_ready = [pid for pid in ready if by_id[pid]["queue"] == 0]
            if running is not None and by_id[running]["queue"] == 1 and high_ready:
                ready.append(running)
                enqueued_at[running] = time
                note += f"{running} preempted by high-priority queue. "
                running = None
                quantum_used = 0
            if running is not None and by_id[running]["queue"] == 0 and quantum_used >= quantum:
                ready.append(running)
                enqueued_at[running] = time
                note += f"{running}'s quantum ({quantum}) expired. "
                running = None
                quantum_used = 0

        if running is None and ready:
            if algorithm == "fcfs":
                running = ready.pop(0)
            elif algorithm == "sjf":
                running = pick(ready, lambda pid: (by_id[pid]["burst"], enqueued_at[pid], pid))
            elif algorithm == "srtf":
                running = pick(ready, lambda pid: (remaining[pid], enqueued_at[pid], pid))
            elif algorithm == "priority":
                running = pick(ready, lambda pid: (by_id[pid]["priority"], enqueued_at[pid], pid))
            elif algorithm == "rr":
                running = pick(ready, lambda pid: (enqueued_at[pid], pid))
            elif algorithm == "mlq":
                highs = [pid for pid in ready if by_id[pid]["queue"] == 0]
                if highs:
                    running = pick(ready, lambda pid: (0 if by_id[pid]["queue"] == 0 else 1, enqueued_at[pid], pid))
                else:
                    running = pick(ready, lambda pid: (enqueued_at[pid], pid))
            quantum_used = 0
            note += f"{running} starts running. "
            if running not in started:
                started[running] = time

        if running is None:
            last_running = None
            steps.append(
                Step(
                    tick=time,
                    state=_snapshot(time, None, ready, completed, remaining, processes),
                    explanation=note + "CPU idle." if note else "CPU idle.",
                )
            )
        else:
            if last_running is not None and last_running != running:
                context_switches += 1
            last_running = running
            if running not in started:
                started[running] = time
            busy_ticks += 1
            quantum_used += 1
            remaining[running] -= 1
            for pid in ready:
                waiting[pid] += 1

            # I/O trigger: the process has now consumed after_cpu units of CPU time
            blocked_now: str | None = None
            io = by_id[running].get("io")
            executed = by_id[running]["burst"] - remaining[running]
            if io and running not in io_issued and executed == io["after_cpu"]:
                io_issued.add(running)
                blocked[running] = io["duration"]
                blocked_now = running

            note += f"{running} runs (remaining {remaining[running]})."
            if blocked_now:
                note += f" {blocked_now} then issues an I/O request and blocks for {io['duration']}ms."
            steps.append(
                Step(
                    tick=time,
                    state=_snapshot(time, running, [r for r in ready if r != running], completed, remaining, processes, blocked),
                    highlight=[running],
                    explanation=note,
                )
            )
            if blocked_now:
                running = None
                quantum_used = 0
        time += 1

    if time >= MAX_TIME and len(completed) < len(processes):
        warnings.append("Simulation hit the time cap; some processes did not complete.")

    per_process = []
    for p in processes:
        pid = p["id"]
        turnaround = (finished_at[pid] - p["arrival"]) if pid in finished_at else None
        response = (started[pid] - p["arrival"]) if pid in started else None
        per_process.append(
            {
                "id": pid,
                "arrival": p["arrival"],
                "burst": p["burst"],
                "priority": p["priority"],
                "queue": p["queue"],
                "waiting": waiting[pid],
                "turnaround": turnaround,
                "response": response,
                "finished_at": finished_at.get(pid),
            }
        )

    n = len(processes)
    avg = lambda key: round(sum(x[key] for x in per_process if x[key] is not None) / n, 2) if n else 0
    metrics = {
        "avg_waiting": avg("waiting"),
        "avg_turnaround": avg("turnaround"),
        "avg_response": avg("response"),
        "throughput": round(len(completed) / time, 3) if time else 0,
        "cpu_utilization": round(busy_ticks / time, 3) if time else 0,
        "context_switches": context_switches,
        "total_time": time,
        "per_process": per_process,
    }
    return SimulationResult(steps=steps, metrics=metrics, warnings=warnings)
