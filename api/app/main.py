from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .engines import cpu_scheduling, memory_management, paging
from .engines.base import SimulationResult

ENGINES = {
    "cpu-scheduling": cpu_scheduling,
    "memory-management": memory_management,
    "paging": paging,
}

app = FastAPI(title="KernelVerse API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class SimulateRequest(BaseModel):
    topic: str
    payload: dict


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/simulate", response_model=SimulationResult)
def simulate(req: SimulateRequest) -> SimulationResult:
    engine = ENGINES.get(req.topic)
    if engine is None:
        raise HTTPException(status_code=501, detail=f"Topic '{req.topic}' not implemented yet")
    errors = engine.validate(req.payload)
    if errors:
        raise HTTPException(status_code=422, detail=errors)
    return engine.run(req.payload)
