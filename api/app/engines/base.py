from __future__ import annotations

from typing import Any, Protocol

from pydantic import BaseModel, Field


class Step(BaseModel):
    """One tick/event in a simulation trace."""

    tick: int
    state: dict[str, Any]
    highlight: list[str] = Field(default_factory=list)
    explanation: str = ""


class SimulationResult(BaseModel):
    steps: list[Step]
    metrics: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)


class SimulationEngine(Protocol):
    """Contract every topic module implements."""

    name: str

    def validate(self, payload: dict[str, Any]) -> list[str]:
        """Return a list of human-readable errors; empty list means valid."""
        ...

    def run(self, payload: dict[str, Any]) -> SimulationResult:
        ...
