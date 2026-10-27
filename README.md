# KernelVerse

KernelVerse is an interactive OS concepts simulator and teaching aid. It lets a professor (or student) configure OS workloads, **step through** the resulting simulation tick-by-tick or event-by-event, and inspect metrics — instead of relying on static tables or diagrams.

Topics in scope (build order):

1. CPU Scheduling — FCFS, SJF, SRTF, Round Robin (with I/O blocking)
2. Memory Management — contiguous allocation (first/best/worst fit) + segmentation, fragmentation
3. Paging — FIFO / LRU / Optimal replacement, optional TLB
4. Deadlocks — wait-for-graph detection, avoidance (Banker's algorithm)
5. Disk Scheduling — FCFS, SSTF, SCAN, C-SCAN, LOOK

Status: all five topics are fully runnable end-to-end (FastAPI engines + Next.js visualizers).

## Architecture (no Docker)

```
Next.js frontend (web/)  --HTTP/JSON-->  FastAPI backend (api/)  [Python engines]
        |
        +-- LocalStorage: last inputs, scenarios
```

- Backend: FastAPI + Pydantic, one engine module per topic behind a shared `validate/run` contract.
- Frontend: Next.js App Router + Tailwind, shared `SimulationPlayer` (play/pause, step ±1, reset, loop, speed, scrubber).
- The backend returns a **full step trace + metrics in one call**; the frontend is a player that steps/rewinds/scrubs through it.

## Requirements

- Python **3.13+** (3.11+ should also work)
- Node.js **20+** (22 recommended) + npm
- No Docker, no database

## Install dependencies

### Backend (`api/`)

```bash
cd api
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Dependencies: `fastapi`, `uvicorn[standard]`, `pydantic` (see `api/requirements.txt`).

### Frontend (`web/`)

```bash
cd web
npm install
```

Main dependencies: `next`, `react`, `react-dom`, `tailwindcss` (see `web/package.json`).

## Run the project

### macOS / Linux / WSL / Git Bash (two terminals)

Terminal 1 — API:
```bash
cd api
source .venv/bin/activate
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Terminal 2 — Web:
```bash
cd web
npm run dev
```

### Windows (two terminals, Command Prompt)

Terminal 1 — API:
```bat
cd api
.venv\Scripts\activate.bat
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Terminal 2 — Web:
```bat
cd web
npm run dev
```

### Windows (two terminals, PowerShell)

Terminal 1 — API:
```powershell
cd api
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Terminal 2 — Web:
```powershell
cd web
npm run dev
```

> If PowerShell refuses to run the activation script, run once:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`


Then open:

- App: http://localhost:3000
- Simulators: http://localhost:3000/simulator
- API health: http://localhost:8000/health
- API docs (Swagger): http://localhost:8000/docs

### One-command local runner (optional)

Unix / macOS / WSL / Git Bash:
```bash
./start.sh
```
`start.sh` starts both servers locally (no Docker), waits for them to be ready, and prints the URLs. Logs go to `/tmp/opencode/`.

Windows (PowerShell):
```powershell
.\start.ps1
```

Windows (Command Prompt):
```bat
start.bat
```
Both Windows scripts also install missing dependencies on first run and open the app at http://127.0.0.1:3000.

Notes for Windows:
- Double-click `start.bat` or run it from Command Prompt.
- `start.ps1` is for PowerShell and stops both servers when you press Enter.
- If ports 3000/8000 are busy, edit the chosen script or use the manual commands above.

## Environment variables

| Variable | Where | Purpose | Default |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | `web/` (build/dev) | Base URL of the API | `http://localhost:8000` |

Set it before running/building the web, e.g.:

```bash
NEXT_PUBLIC_API_URL=http://localhost:8000 npm run dev
```

## Build for production

```bash
# backend (run with multiple workers if desired)
cd api && uvicorn app.main:app --host 0.0.0.0 --port 8000

# frontend
cd web && npm run build && npm run start
```

## Project layout

```
KernelVerse/
├── api/                      FastAPI backend
│   ├── app/
│   │   ├── main.py           /health, /simulate routes
│   │   └── engines/          base.py, cpu_scheduling.py,
│   │                         memory_management.py, paging.py,
│   │                         deadlocks.py, disk_scheduling.py
│   ├── tests/                engine unit tests
│   └── requirements.txt
├── web/                      Next.js frontend
│   └── src/
│       ├── app/simulator/    per-topic pages
│       ├── components/       SimulationPlayer
│       └── lib/              types, gantt
├── docs/adr/                 architecture decision records
├── Project Requirements Document Questionare.md
├── SKILL.md
├── Objectives.png
├── start.sh                  local (non-Docker) runner
└── README.md
```

## API quick example

```bash
curl -s -X POST http://127.0.0.1:8000/simulate \
  -H 'Content-Type: application/json' \
  -d '{"topic":"cpu-scheduling","payload":{"algorithm":"rr","quantum":2,"processes":[{"id":"P1","arrival":0,"burst":5},{"id":"P2","arrival":1,"burst":3},{"id":"P3","arrival":2,"burst":1}]}}'
```

## Troubleshooting

- Port already in use: change the port in the commands above (and update `NEXT_PUBLIC_API_URL`).
- CORS errors: backend currently allows `*` for development; restrict in `api/app/main.py` for production.
- Frontend can't reach API: confirm `NEXT_PUBLIC_API_URL` and that the backend is running on the expected port.

## Notes

- No Docker containerization is used or required.
- Simulation results are computed fully on the backend and replayed client-side; nothing is persisted server-side.
