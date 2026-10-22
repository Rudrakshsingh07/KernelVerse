"""
Shared data contract for all KernelVerse simulation engines.

This module defines the common data structures and the interface contract that
every OS-topic engine module (CPU scheduling, memory management, paging,
deadlocks, disk scheduling) must implement.

The frontend (Next.js) and the FastAPI backend exchange data using these
Pydantic models, so the simulation result is always a deterministic,
JSON-serializable trace that can be stepped through tick-by-tick.
"""

from __future__ import annotations

from typing import Any, Protocol

from pydantic import BaseModel, Field


class Step(BaseModel):
    """
    Represents a single tick (time unit) or event in a simulation trace.

    The frontend's SimulationPlayer renders one Step at a time, allowing the
    user to play, pause, step forward/backward, and scrub through the
    simulation.  Each Step captures a full snapshot of system state at that
    instant so the UI can redraw Gantt charts, memory blocks, page tables,
    wait-for graphs, or disk head position.

    Attributes:
        tick: The simulated time tick (integer CPU unit / time unit) at which
              this step occurs.  Starts at 0 and increments by 1 each tick.
        state: A dictionary containing the complete system state at this tick.
               Contents vary by engine (e.g. ready queue, running process,
               memory blocks, page frames, disk head position).
        highlight: A list of identifiers (process IDs, page numbers, etc.)
                   that should be visually highlighted in the UI at this step.
        explanation: A plain-English sentence describing what happened at this
                     tick, intended to be shown to the user as a teaching aid.
    """

    tick: int
    state: dict[str, Any]
    highlight: list[str] = Field(default_factory=list)
    explanation: str = ""


class SimulationResult(BaseModel):
    """
    The complete output of a single engine ``run()`` call.

    The FastAPI /simulate endpoint serializes this to JSON and returns it to
    the frontend, which replays it step-by-step.

    Attributes:
        steps: Ordered list of ``Step`` objects forming the full trace from
               tick 0 to completion (or to the time cap).
        metrics: Dictionary of computed aggregate metrics (e.g. average waiting
                 time, page fault count, total seek distance).  Contents vary
                 by engine.
        warnings: Human-readable warning strings (e.g. "simulation hit time
                  cap", "high fragmentation") for the UI to display.
    """

    steps: list[Step]
    metrics: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)


class SimulationEngine(Protocol):
    """
    Protocol (interface) that every topic engine module must satisfy.

    Each engine module under ``api/app/engines/`` exposes two functions:
    ``validate(payload)`` and ``run(payload)``.  The FastAPI router in
    ``main.py`` dispatches to these based on the ``topic`` field of the
    request, so adding a new topic only requires a new module that follows
    this contract plus an entry in the ENGINES dictionary.

    Attributes:
        name: Human-readable name of the engine/topic.

    Methods:
        validate: Check the input payload for errors; return [] if valid.
        run:   Execute the simulation and return a SimulationResult.
    """

    name: str

    def validate(self, payload: dict[str, Any]) -> list[str]:
        """
        Validate the user-supplied input payload.

        Args:
            payload: The JSON body sent by the frontend for this topic.

        Returns:
            A list of human-readable error strings.  An empty list means the
            payload is valid and safe to pass to ``run()``.
        """
        ...

    def run(self, payload: dict[str, Any]) -> SimulationResult:
        """
        Execute the simulation and produce a full trace plus metrics.

        Args:
            payload: The validated input payload.

        Returns:
            A SimulationResult containing the step trace, aggregate metrics,
            and any warnings.
        """
        ...
