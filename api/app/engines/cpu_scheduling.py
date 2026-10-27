"""
CPU Scheduling simulation engine.

Simulates process execution on a single CPU, tick by tick (1 tick = 1 CPU time
unit).  Supports four algorithms:

    FCFS  - First Come, First Served (non-preemptive)
    SJF   - Shortest Job First (non-preemptive)
    SRTF  - Shortest Remaining Time First (preemptive SJF)
    RR    - Round Robin (preemptive by time quantum)

Each process may optionally perform I/O: after consuming ``after_cpu`` units of
CPU time, it blocks for ``duration`` ticks and then re-enters the ready queue.

The engine is deterministic: ties are broken by arrival time, then process ID,
then enqueue order.  It produces a full step trace (one Step per tick) plus
aggregate metrics (avg waiting, turnaround, response, throughput, CPU
utilization, context switches) and per-process results.

Public contract (see base.py):
    validate(payload) -> list[str]
    run(payload)      -> SimulationResult
"""

from __future__ import annotations

from typing import Any, Callable

from .base import SimulationResult, Step

# All algorithm names this engine accepts.  Used by validate() and by the
# frontend to populate the algorithm dropdown.
ALGORITHMS = ["fcfs", "sjf", "srtf", "rr"]

# Safety cap: the simulation loop stops after this many ticks even if not all
# processes have finished.  Prevents runaway loops on bad input.
MAX_TIME = 5000


def validate(payload: dict[str, Any]) -> list[str]:
    """
    Validate the CPU-scheduling input payload.

    Checks that the algorithm is supported, the process list is well-formed,
    and algorithm-specific fields (quantum for RR, I/O timing) are present and
    correct.

    Args:
        payload: JSON dict with keys "algorithm" and "processes".

    Returns:
        List of human-readable error strings; empty list means valid.
    """
    errors: list[str] = []
    processes = payload.get("processes")
    algorithm = payload.get("algorithm")

    # 1. Algorithm must be one of the supported names.
    if algorithm not in ALGORITHMS:
        errors.append(f"algorithm must be one of {ALGORITHMS}")

    # 2. Processes must be a non-empty list.  If not, we can't validate further.
    if not isinstance(processes, list) or not processes:
        errors.append("processes must be a non-empty list")
        return errors

    seen: set[str] = set()  # track process IDs to detect duplicates
    for i, p in enumerate(processes):
        pid = p.get("id")
        if not pid or not isinstance(pid, str):
            errors.append(f"processes[{i}].id must be a non-empty string")
        elif pid in seen:
            errors.append(f"duplicate process id '{pid}'")
        else:
            seen.add(pid)

        # Arrival time: integer >= 0 (when the process enters the ready queue).
        arrival = p.get("arrival")
        burst = p.get("burst")
        if not isinstance(arrival, int) or arrival < 0:
            errors.append(f"process '{pid}': arrival must be an integer >= 0")
        # Burst time: integer > 0 (total CPU time the process needs).
        if not isinstance(burst, int) or burst <= 0:
            errors.append(f"process '{pid}': burst must be an integer > 0")

        # I/O specification: io_arrival (CPU units consumed before blocking)
        # and io_duration (how many ticks the process stays blocked).
        io_dur = p.get("io_duration", 0) or 0
        io_at = p.get("io_arrival", 0) or 0
        if p.get("io") is not None and not isinstance(p["io"], dict):
            errors.append(f"process '{pid}': io must be an object")
        if not isinstance(io_dur, int) or io_dur < 0:
            errors.append(f"process '{pid}': io_duration must be an integer >= 0")
        if not isinstance(io_at, int) or io_at < 0:
            errors.append(f"process '{pid}': io_arrival must be an integer >= 0")
        # I/O must trigger during the burst, not after it finishes.
        if io_dur > 0:
            burst = p.get("burst")
            if isinstance(burst, int) and io_at >= burst:
                errors.append(f"process '{pid}': io_arrival must be less than its burst")

    # Round Robin requires a positive quantum.
    if algorithm == "rr":
        q = payload.get("quantum", 2)
        if not isinstance(q, int) or q < 1:
            errors.append("quantum must be an integer >= 1")
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
    """
    Capture a complete snapshot of system state at the current tick.

    This dictionary is stored inside each ``Step`` so the frontend can render
    the state of the CPU, ready queue, blocked processes, and finished
    processes at any point in the trace.

    Args:
        time: Current simulation tick.
        running: ID of the process currently on the CPU, or None if idle.
        ready: List of process IDs waiting in the ready queue (in order).
        completed: List of process IDs that have finished execution.
        remaining: Map of process ID -> remaining CPU burst time.
        processes: Full process list (for arrival/burst metadata).
        blocked: Map of process ID -> remaining I/O ticks (optional).

    Returns:
        A dict suitable for the ``state`` field of a ``Step``.
    """
    return {
        "time": time,
        "running": running,
        "ready": list(ready),                      # copy so later mutation doesn't alter history
        "completed": list(completed),
        "remaining": dict(remaining),
        "blocked": ([{"id": pid, "remaining": r} for pid, r in (blocked or {}).items()]),
        "processes": [
            {
                "id": p["id"],
                "arrival": p["arrival"],
                "burst": p["burst"],
                "remaining": remaining[p["id"]],
            }
            for p in processes
        ],
    }


def run(payload: dict[str, Any]) -> SimulationResult:
    """
    Execute the CPU-scheduling simulation tick by tick.

    This is the core simulation loop.  At each tick it:
      1. Adds newly arrived processes to the ready queue.
      2. Decrements I/O timers for blocked processes and re-queues completed ones.
      3. Handles preemption (SRTF and RR quantum expiry).
      4. Dispatches the next process from the ready queue if the CPU is idle.
      5. Runs the current process for one tick (decrements remaining burst,
         increments waiting time for all ready processes, checks for I/O
         blocking).
      6. Records a Step snapshot.

    After the loop ends (all processes done or MAX_TIME reached), it computes
    per-process and aggregate metrics.

    Args:
        payload: Validated input with algorithm, processes, and optional quantum.

    Returns:
        SimulationResult with the full step trace, metrics, and warnings.
    """
    algorithm = payload["algorithm"]
    quantum = int(payload.get("quantum", 2))
    # Sort processes by arrival time then ID for deterministic tie-breaking.
    processes = sorted(
        [dict(p) for p in payload["processes"]],
        key=lambda p: (p["arrival"], p["id"]),
    )
    # Apply defaults and normalize the optional I/O specification.
    for p in processes:
        # Normalize I/O spec: flat fields (io_duration/io_arrival) or nested dict.
        if isinstance(p.get("io"), dict):
            pass                          # already in {after_cpu, duration} form
        elif (p.get("io_duration") or 0) > 0:
            p["io"] = {"after_cpu": int(p.get("io_arrival") or 0), "duration": int(p["io_duration"])}
        else:
            p.pop("io", None)             # no I/O for this process

    # remaining: how much CPU burst each process still needs.
    remaining = {p["id"]: p["burst"] for p in processes}
    # waiting: cumulative time each process has spent in the ready queue.
    waiting = {p["id"]: 0 for p in processes}
    # blocked: process ID -> remaining I/O ticks (processes waiting for I/O).
    blocked: dict[str, int] = {}
    io_issued: set[str] = set()           # processes that have already triggered their I/O
    enqueued_at: dict[str, int] = {}      # when a process last entered the ready queue
    started: dict[str, int] = {}          # tick when a process first started running
    finished_at: dict[str, int] = {}      # tick when each process finished
    completed: list[str] = []             # order in which processes finished

    warnings: list[str] = []
    steps: list[Step] = []

    # Deterministic lookup of process dict by ID.
    by_id = {p["id"]: p for p in processes}

    ready: list[str] = []                 # FIFO-ish ready queue (order depends on algorithm)
    running: str | None = None            # process currently using the CPU
    last_running: str | None = None       # process that ran in the previous tick
    quantum_used = 0                      # ticks the current process has run in its quantum
    context_switches = 0                  # count of CPU handoffs between different processes
    busy_ticks = 0                        # total ticks the CPU was busy (for utilization)
    time = 0                              # simulation clock
    arrived_idx = 0                       # not used directly; arrivals handled by enqueue_arrivals

    def enqueue_arrivals(t: int) -> list[str]:
        """
        Add every process whose arrival time equals the current tick to ready.

        Also records enqueued_at for tie-breaking.  Returns the list of newly
        arrived process IDs (used for the step explanation).
        """
        nonlocal arrived_idx
        newly = [p["id"] for p in processes if p["arrival"] == t]
        ready.extend(newly)
        for pid in newly:
            enqueued_at[pid] = t
        return newly

    def pick(queue: list[str], key: Callable[[str], Any]) -> str:
        """
        Select and remove the best process from a queue according to a key.

        Used by SJF, SRTF, and RR to choose the next process.  The
        key returns a sortable tuple; Python's min() picks the smallest.
        """
        chosen = min(queue, key=key)
        queue.remove(chosen)
        return chosen

    total_burst = sum(p["burst"] for p in processes)
    if total_burst > MAX_TIME:
        warnings.append("Total burst time is very large; trace may be truncated.")

    # ================================================================
    # MAIN SIMULATION LOOP — one iteration per simulated tick
    # ================================================================
    while len(completed) < len(processes) and time < MAX_TIME:
        # --- Step A: New processes arrive at this tick ---------------
        arrivals = enqueue_arrivals(time)

        note = ""
        if arrivals:
            note = f"{', '.join(arrivals)} arrived. "

        # --- Step B: Blocked processes finish I/O and return to ready ---
        for pid in list(blocked):
            blocked[pid] -= 1                    # one tick of I/O has passed
            if blocked[pid] <= 0:
                del blocked[pid]                 # I/O complete
                ready.append(pid)                # re-enter ready queue
                enqueued_at[pid] = time
                note += f"{pid} finished its I/O and re-entered the ready queue. "

        # --- Step C: Running process finished? ----------------------
        if running is not None and remaining[running] == 0:
            finished_at[running] = time          # record completion tick
            completed.append(running)
            note += f"{running} finished. "
            running = None                       # CPU becomes idle
            quantum_used = 0                     # reset quantum for next process

        # --- Step D: Round Robin quantum expiry ---------------------
        if algorithm == "rr" and running is not None and quantum_used >= quantum:
            ready.append(running)                # go to back of ready queue
            enqueued_at[running] = time
            note += f"{running}'s quantum ({quantum}) expired; moved to the back of the ready queue. "
            running = None
            quantum_used = 0

        # --- Step E: SRTF preemption --------------------------------
        if algorithm == "srtf" and running is not None:
            contenders = ready
            if contenders:
                # Pick the ready process with the smallest remaining burst.
                shortest = min(
                    contenders,
                    key=lambda pid: (remaining[pid], enqueued_at[pid], pid),
                )
                # Preempt if the new arrival has strictly less remaining time.
                if remaining[shortest] < remaining[running]:
                    ready.append(running)
                    enqueued_at[running] = time
                    note += f"{running} preempted: {shortest} has shorter remaining time. "
                    running = None
                    quantum_used = 0

        # --- Step F: CPU idle? Dispatch next process from ready -----
        if running is None and ready:
            if algorithm == "fcfs":
                # FCFS: pick the process that arrived first (front of queue).
                running = ready.pop(0)
            elif algorithm == "sjf":
                # SJF: pick the process with the smallest original burst.
                running = pick(ready, lambda pid: (by_id[pid]["burst"], enqueued_at[pid], pid))
            elif algorithm == "srtf":
                # SRTF: pick the process with the smallest remaining burst.
                running = pick(ready, lambda pid: (remaining[pid], enqueued_at[pid], pid))
            elif algorithm == "rr":
                # RR: pick the process that has been waiting longest (FIFO).
                running = pick(ready, lambda pid: (enqueued_at[pid], pid))
            quantum_used = 0                     # new process starts a fresh quantum
            note += f"{running} starts running. "
            if running not in started:
                started[running] = time          # record first-run tick (for response time)

        # --- Step G: Record the step (CPU idle or running) -----------
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
            # Count a context switch if the CPU changed processes since last tick.
            if last_running is not None and last_running != running:
                context_switches += 1
            last_running = running
            if running not in started:
                started[running] = time
            busy_ticks += 1
            quantum_used += 1
            remaining[running] -= 1              # this process consumed one CPU tick

            # Every process sitting in the ready queue accumulates waiting time.
            for pid in ready:
                waiting[pid] += 1

            # --- Step H: Check if the running process should block for I/O ---
            blocked_now: str | None = None
            io = by_id[running].get("io")
            executed = by_id[running]["burst"] - remaining[running]
            if io and running not in io_issued and executed == io["after_cpu"]:
                io_issued.add(running)
                blocked[running] = io["duration"]   # block for `duration` ticks
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
                running = None                     # CPU becomes idle while process does I/O
                quantum_used = 0

        time += 1                                  # advance the simulation clock

    # If we hit the time cap, warn that some processes may not have finished.
    if time >= MAX_TIME and len(completed) < len(processes):
        warnings.append("Simulation hit the time cap; some processes did not complete.")

    # ================================================================
    # COMPUTE PER-PROCESS AND AGGREGATE METRICS
    # ================================================================
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
                "waiting": waiting[pid],
                "turnaround": turnaround,
                "response": response,
                "started_at": started.get(pid),
                "finished_at": finished_at.get(pid),
            }
        )

    n = len(processes)
    # Helper to compute an average while guarding against missing values.
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
