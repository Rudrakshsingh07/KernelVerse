# KernelVerse — Architecture & File Map

**Purpose:** This file is a directory map. Every folder and source file is listed with a one-line description in brackets so a new programmer can browse the repository and immediately understand where they are and what each piece does.

> Tip: dependency/output folders (`node_modules/`, `.venv/`, `.next/`, `__pycache__/`, `.git/`) are intentionally omitted — they are generated, not authored.

---

## Repository root

```
KernelVerse/
├── .gitignore                        # tells Git which files/folders to ignore (node_modules, .venv, builds, etc.)
├── Objectives.png                    # project objectives / goals diagram (image)
├── Project Requirements Document Questionare.md   # PRD question bank used to define project scope and features
├── README.md                         # project overview, install & run instructions, API examples
├── running-page.html                 # standalone HTML page (scratch/legacy visualization)
├── SKILL.md                          # skill/instruction notes for OpenCode agents
├── architecture.md                   # this file — project directory map
├── readyQueue.md                     # notes on the ready-queue simulation concept
├── start.bat                         # Windows (Cmd) one-click launcher for API + frontend
├── start.ps1                         # Windows (PowerShell) one-click launcher for API + frontend
├── start.sh                          # Linux/macOS one-click launcher for API + frontend
├── api/                              # BACKEND — FastAPI Python simulation engine
├── docs/                             # DOCS — architecture decision records
├── web/                              # FRONTEND — Next.js 16 + React simulator UI
```

---

## Backend — `api/`

The backend is a FastAPI application. Each OS topic has its own Python engine module under `api/app/engines/`, all sharing a common `validate/run` contract defined in `base.py`.

```
api/
├── requirements.txt                  # Python dependencies: fastapi, uvicorn, pydantic
├── tests/                            # backend unit tests
│   └── test_disk_scheduling.py       # disk-scheduling engine regression tests
├── app/                              # FastAPI application package
│   ├── __init__.py                   # marks app/ as a Python package
│   ├── main.py                       # FastAPI app: /health, /simulate, engine dispatcher routing by topic
│   └── engines/                      # one module per simulation topic
│       ├── __init__.py               # marks engines/ as a Python package
│       ├── base.py                   # shared Step / SimulationResult models + SimulationEngine protocol contract
│       ├── cpu_scheduling.py         # FCFS, SJF, SRTF, Round Robin (+ I/O blocking)
│       ├── memory_management.py      # contiguous allocation & segmentation; first/best/worst-fit strategies
│       ├── paging.py                 # FIFO, LRU, Optimal page replacement + optional TLB simulation
│       ├── deadlocks.py              # Banker's safety algorithm + wait-for-graph deadlock detection
│       └── disk_scheduling.py        # FCFS, SSTF, SCAN, C-SCAN, LOOK disk head scheduling
```

### What each engine does (one-liner)

| File | Algorithm(s) covered |
|------|----------------------|
| `cpu_scheduling.py` | FCFS, SJF, SRTF, Round Robin |
| `memory_management.py` | Contiguous allocation, segmentation, first/best/worst-fit |
| `paging.py` | FIFO, LRU, Optimal page replacement, TLB hits/misses |
| `deadlocks.py` | Banker's avoidance, wait-for-graph detection |
| `disk_scheduling.py` | FCFS, SSTF, SCAN, C-SCAN, LOOK |

---

## Docs — `docs/`

```
docs/
└── adr/                              # Architecture Decision Records (design decisions)
    └── 0001-initial-architecture.md  # initial architecture ADR & build plan
```

---

## Frontend — `web/`

The frontend is a Next.js 16 (App Router) + React 19 application with Tailwind CSS. It calls the FastAPI backend and lets the user step through simulations tick-by-tick.

```
web/
├── AGENTS.md                         # agent context notes for AI coding assistants
├── CLAUDE.md                         # Claude-specific project instructions
├── eslint.config.mjs                 # ESLint linting configuration
├── .gitignore                        # Git ignore rules for the frontend
├── next.config.ts                    # Next.js configuration
├── next-env.d.ts                     # Next.js TypeScript environment declarations
├── package.json                      # npm dependencies & scripts (next, react, tailwind)
├── package-lock.json                 # locked npm dependency versions
├── postcss.config.mjs                # PostCSS config for Tailwind
├── tsconfig.json                     # TypeScript compiler configuration
├── README.md                         # frontend-specific notes
├── public/                           # static assets served directly
│   ├── file.svg                      # generic file icon
│   ├── globe.svg                     # globe icon
│   ├── next.svg                      # Next.js logo
│   ├── vercel.svg                    # Vercel logo
│   └── window.svg                    # window icon
├── src/                              # frontend source code
│   ├── app/                          # Next.js App Router pages & layouts
│   │   ├── favicon.ico               # site favicon
│   │   ├── globals.css               # global CSS / Tailwind imports
│   │   ├── layout.tsx                # root layout: metadata, fonts, nav shell
│   │   ├── page.tsx                  # home / landing page
│   │   └── simulator/                # per-topic simulator pages
│   │       ├── page.tsx              # simulator index / topic selection page
│   │       ├── cpu-scheduling/page.tsx   # CPU scheduling simulator UI
│   │       ├── memory-management/page.tsx# memory management simulator UI
│   │       ├── paging/page.tsx               # paging simulator UI
│   │       ├── disk-scheduling/page.tsx    # disk scheduling simulator UI
│   │       └── deadlocks/page.tsx          # deadlocks simulator UI
│   ├── components/                   # shared React components
│   │   └── SimulationPlayer.tsx      # shared play/pause, step, scrubber, speed, loop controls
│   └── lib/                          # shared frontend utilities
│       ├── gantt.ts                  # Gantt chart segment extraction + PID color palette
│       └── types.ts                  # shared TypeScript interfaces (Step, SimulationResult)
```

---

## Data flow (quick reference)

```
User input (web UI)
        │ HTTP POST /simulate {topic, payload}
        ▼
FastAPI main.py  ──► dispatches to engine module (engines/<topic>.py)
        │
        ├─ validate(payload)  → input errors or OK
        └─ run(payload)       → SimulationResult {steps, metrics, warnings}
        │
        ▼ JSON response with full step trace + metrics
Frontend SimulationPlayer replays steps tick-by-tick (Gantt / table / metrics)
```

---

## How to use this map

- **Working on an algorithm?** → `api/app/engines/<topic>.py` (e.g. `cpu_scheduling.py`)
- **Adding a new topic?** → create `api/app/engines/<new_topic>.py` following the `base.py` contract, then wire it into `main.py`'s `ENGINES` dict and add a page under `web/src/app/simulator/<new-topic>/page.tsx`
- **Changing the API route?** → `api/app/main.py`
- **Changing shared step/metrics types?** → `api/app/engines/base.py` (Python) and `web/src/lib/types.ts` (TypeScript)
- **Changing the Gantt visual?** → `web/src/lib/gantt.ts`
- **Changing the player controls?** → `web/src/components/SimulationPlayer.tsx`