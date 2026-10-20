# KernelVerse — Ready Queue (remaining work)

**One-line purpose:** This is the ordered backlog of everything left to build, sequenced so that no module is touched until the modules it depends on are already complete.

## How to read this queue

- Tasks are listed in **dependency order**. Do not start a task until every task under `dependsOn` is marked `done`.
- `layer` = `backend` (Python/FastAPI engine), `frontend` (Next.js visualizer), `infra` (Docker/CI), or `project` (testing/docs/release).
- `status` values: `todo`, `in-progress`, `done`, `blocked`.

## Remaining work assessment

| Area | Current state | What remains |
|------|--------------|--------------|
| CPU Scheduling | ✅ Complete (engine + visualizer + compare view) | Nothing |
| Memory Management | ✅ Complete (engine + visualizer) | Nothing |
| Paging | ✅ Complete (engine + visualizer + TLB) | Nothing |
| Deadlocks | ⚠️ Stub UI only; no backend engine | Engine + visualizer |
| Disk Scheduling | ⚠️ Stub UI only; no backend engine | Engine + visualizer |
| Testing | ❌ No unit/integration tests | Engine tests, API contract tests |
| Docker | ❌ Removed in last commit | Optional re-add (docker-compose + Dockerfiles) |
| Release hardening | ⚠️ Planned in ADR M5 | SEO pass, glossary, presets, CORS hardening, public-release checklist |

The shared foundation (`base.py` engine contract, `SimulationPlayer`, `types.ts`, `gantt.ts`, localStorage persistence) is already done, so new topics only need: **one Python engine module → one Next.js visualizer page**.

---

## Dependency-ordered ready queue

### Phase 1: Backend engines (depend only on the shared contract — already done)

| ID | Task | Layer | Depends On | Definition of Done | Status |
|----|------|-------|------------|-------------------|--------|
| B1 | Deadlocks engine: `api/app/engines/deadlocks.py` | backend | `base.py` contract | Implements `validate(payload)` and `run(payload)` per `SimulationEngine` protocol; supports Coffman conditions, detection, and Banker's algorithm avoidance; returns `SimulationResult` with steps + metrics | done |
| B2 | Disk Scheduling engine: `api/app/engines/disk_scheduling.py` | backend | `base.py` contract | Implements `validate(payload)` and `run(payload)`; supports FCFS, SSTF, SCAN, C-SCAN, LOOK; returns `SimulationResult` with head movement trace + seek-time metrics | done |
| B3 | Register both new topics in `api/app/main.py` `ENGINES` dict | backend | B1, B2 | `/simulate` accepts `topic: "deadlocks"` and `topic: "disk-scheduling"`; `/health` unchanged | done |

### Phase 2: Frontend visualizers (depend on their backend engines)

| ID | Task | Layer | Depends On | Definition of Done | Status |
|----|------|-------|------------|-------------------|--------|
| F1 | Deadlocks page: `web/src/app/simulator/deadlocks/page.tsx` | frontend | B1, B3 | Replaces stub; inputs for resources/allocation/max/need or requests; step-through visualization (resource allocation graph or state table); metrics (safe sequence / deadlock cycle); localStorage persistence; error handling for 422/501 | todo |
| F2 | Disk Scheduling page: `web/src/app/simulator/disk-scheduling/page.tsx` | frontend | B2, B3 | Replaces stub; inputs for request queue + head position + direction; step-through head movement visualization (track/seek plot); metrics (total seek time, avg seek); localStorage persistence; error handling | todo |
| F3 | Simulator index: add Deadlocks + Disk Scheduling to `web/src/app/simulator/page.tsx` TOPICS | frontend | F1, F2 | Status badge flips from "Planned" to "Complete"; route links work | todo |

### Phase 3: Comparison / quiz / hardening (depend on all engines)

| ID | Task | Layer | Depends On | Definition of Done | Status |
|----|------|-------|------------|-------------------|--------|
| P1 | Unit tests for all engines (CPU, Memory, Paging, Deadlocks, Disk) | project | B1, B2 | `pytest` suite under `api/tests/`; covers happy path, edge cases, invalid input validation | todo |
| P2 | API contract tests (`/simulate`, `/health`) | project | B1, B3 | Tests that unknown topics return 501, invalid payloads return 422, all five topics return valid `SimulationResult` | todo |
| P3 | CORS hardening: restrict `allow_origins` in `api/app/main.py` | backend | B3 | Production-ready CORS config (no `*` in production); documented env var | todo |
| P4 | SEO pass: per-topic title/meta, OG tags, sitemap/robots groundwork | project | F3 | ADR M5 SEO items addressed | todo |
| P5 | Glossary + presets (classic textbook scenarios per topic) | project | F3 | Preset scenarios loadable from UI; glossary page or tooltips | todo |
| P6 | Public-release checklist (README deploy steps, env vars, build verification) | project | P1–P5 | Release-ready `README.md` with production build/run instructions | todo |

### Phase 4: Optional infrastructure

| ID | Task | Layer | Depends On | Definition of Done | Status |
|----|------|-------|------------|-------------------|--------|
| I1 | Docker re-integration: `docker-compose.yml`, `api/Dockerfile`, `web/Dockerfile` | infra | P3 | `docker compose up` starts both services with hot-reload volumes | todo |

---

## Execution rule

> **Never touch a frontend visualizer until its backend engine is registered and returning 200 on `/simulate`.**  
> **Never touch Phase 3 until all five topics return complete `SimulationResult` objects.**

Mark each task `done` in this file as you complete it, then move to the next unblocked task.
