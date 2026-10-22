"""
KernelVerse FastAPI application entry point.

This module creates the FastAPI app, configures CORS, and exposes two HTTP
endpoints:

    GET  /health          -> simple health check
    POST /simulate        -> runs a simulation engine and returns the trace

The simulation logic lives entirely in the Python engine modules under
``api/app/engines/``.  This file only handles HTTP routing, input dispatch,
and error translation.
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Import every engine module so they can be dispatched by topic name.
# Each module must expose `validate(payload)` and `run(payload)` per the
# SimulationEngine protocol defined in base.py.
from .engines import cpu_scheduling, memory_management, paging, deadlocks, disk_scheduling
from .engines.base import SimulationResult

# ENGINES maps the frontend-facing "topic" string to the corresponding
# Python engine module.  When a new topic is added, insert a new entry here
# and create the matching engine module under engines/.
ENGINES = {
    "cpu-scheduling": cpu_scheduling,   # FCFS, SJF, SRTF, Priority, RR, MLQ
    "memory-management": memory_management,  # contiguous + segmentation, fit strategies
    "paging": paging,                   # FIFO, LRU, Optimal page replacement (+ TLB)
    "deadlocks": deadlocks,             # Banker's avoidance + wait-for-graph detection
    "disk-scheduling": disk_scheduling, # FCFS, SSTF, SCAN, C-SCAN, LOOK
}

app = FastAPI(title="KernelVerse API", version="0.1.0")

# Allow cross-origin requests so the Next.js frontend (served on port 3000)
# can call this API (served on port 8000) during development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],        # TODO: restrict to specific origins in production
    allow_methods=["*"],
    allow_headers=["*"],
)


class SimulateRequest(BaseModel):
    """
    Incoming request body for POST /simulate.

    Attributes:
        topic:   Which OS topic to simulate (must be a key in ENGINES).
        payload: Engine-specific input parameters (processes, memory size,
                 reference string, etc.).  Passed straight to the engine's
                 validate() and run() functions.
    """

    topic: str
    payload: dict


@app.get("/health")
def health() -> dict:
    """
    Health-check endpoint.

    Returns a simple JSON object so the frontend or a load balancer can
    confirm the backend is running.
    """
    return {"status": "ok"}


@app.post("/simulate", response_model=SimulationResult)
def simulate(req: SimulateRequest) -> SimulationResult:
    """
    Main simulation endpoint.

    Receives a topic and payload, looks up the correct engine module,
    validates the input, runs the simulation, and returns the full
    step-by-step trace plus metrics as JSON.

    Args:
        req: SimulateRequest with `topic` and `payload`.

    Returns:
        SimulationResult (steps, metrics, warnings) serialized to JSON.

    Raises:
        HTTPException(501): if the requested topic is not implemented.
        HTTPException(422): if the payload fails engine validation.
    """
    # Resolve the topic string to an engine module.
    engine = ENGINES.get(req.topic)
    if engine is None:
        # Topic not recognized — tell the client it isn't implemented yet.
        raise HTTPException(
            status_code=501,
            detail=f"Topic '{req.topic}' not implemented yet",
        )

    # Run the engine's validation function.  It returns a list of error
    # strings; if non-empty, we reject the request with HTTP 422 so the
    # frontend can show the user exactly what to fix.
    errors = engine.validate(req.payload)
    if errors:
        raise HTTPException(status_code=422, detail=errors)

    # Validation passed — execute the simulation and return the result.
    # FastAPI automatically serializes the SimulationResult to JSON.
    return engine.run(req.payload)
