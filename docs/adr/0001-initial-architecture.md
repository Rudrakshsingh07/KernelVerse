# ADR 0001: KernelVerse — Initial Architecture & Build Plan

**Status:** Accepted (proposed, pending review)
**Date:** 2026-10-05
**Deciders:** Project owner

## Context

KernelVerse is an OS Concepts Simulator aimed primarily at professors demonstrating
hard-to-illustrate topics in class, with practice/testing features later. It must visualize
topics that 2D tables/images cannot:

| Topic | Sub-concepts |
| --- | --- |
| CPU Scheduling | FCFS, SJF, Priority, Round Robin, Multilevel Queue |
| Memory Management | Contiguous allocation, fragmentation, segmentation |
| Paging | Page tables, page faults, TLB, replacement (FIFO/LRU/Optimal) |
| Deadlocks | Coffman conditions, detection, Banker's algorithm, prevention |

Build order: CPU Scheduling → Memory Management → Paging → Deadlocks.

Key requirements:
- Shared interaction pattern per topic (inputs → step through → chart/table → metrics)
- Simulations run instantly AND step-by-step (pause, rewind, replay, speed control)
- Side-by-side algorithm comparison in v1; quiz mode deferred
- FastAPI backend; simulation engines written in Python
- Next.js + Tailwind frontend (SSR/SSG for future SEO/public release)
- LocalStorage persistence only (no DB)
- Docker containerization, .gitignore, deployed-website path later
- Apple-style fluid design (springs, interruptible transitions, reduced-motion support)

## Decision

### Architecture

    Next.js frontend  →(HTTP/JSON)→  FastAPI backend (Python engines, one module per topic)
    LocalStorage: custom scenarios, last inputs, scores

- Simulation logic lives in Python behind a shared engine interface:
    validate(payload) -> errors
    run(payload) -> SimulationResult
- SimulationResult = { steps: [Step], metrics: dict, warnings: [str] }
- Step = { tick, state: dict, highlight: [...], explanation: str }
- The backend returns the full step trace + metrics in one call; the frontend is a
  player that steps/rewinds/scrubs through it (no per-tick requests), so the UI stays
  interruptible and replayable from one fetch.

### Topic modules (input → visualization → metrics)

| Module | Inputs | Visualization | Metrics |
| --- | --- | --- | --- |
| cpu_scheduling | processes, quantum, algorithm(s) | Gantt chart, ready-queue strip | waiting/turnaround/response, throughput, utilization, context switches |
| memory_management | memory size, holes, process sizes, fit strategy | block map | internal/external fragmentation, utilization |
| paging | reference string, frames, algorithm | page-table grid, frame fill/evict | page faults, hit ratio, fault rate |
| deadlocks | resources, allocation/max/need, request | resource allocation graph | safe sequence or deadlock cycle |

### Frontend
- Next.js App Router + Tailwind; prerendered topic pages for SEO; client-side player.
- One shared SimulationPlayer: play/pause, step fwd/back, rewind, speed, scrubber.
  Topic visualizers are pure functions of step.state.
- Compare view: same input through N algorithms → N traces → metrics table + overlaid charts.
- Spring animations (Motion); honor prefers-reduced-motion / reduced-transparency.
- LocalStorage for last inputs and custom scenarios.

### Infrastructure
- docker-compose.yml with `web` (Next.js) and `api` (FastAPI), dev hot-reload volumes.
- .gitignore for Python, Node, Docker, .obsidian, env files.
- SEO groundwork: per-topic title/meta, OG tags, sitemap/robots at deploy time.

## Consequences

- Positive: one shared contract → new topic = one Python engine + one visualizer;
  Docker simplifies class demos; LocalStorage avoids DB ops; Next.js gives the SEO path.
- Negative: full-trace responses can be large → cap steps, validate input sizes;
  compare view costs N calls — acceptable at this scale.
- Risks: deadlock/paging step design is the hard part; step granularity must be
  fixed before UI work to keep the contract stable.

## Milestones

1. M0 Scaffold: repo layout, FastAPI + Next.js skeletons, Docker, .gitignore, engine contract + player shell
2. M1 CPU Scheduling (first full vertical slice, all algorithms, compare view, presets)
3. M2 Memory Management
4. M3 Paging
5. M4 Deadlocks
6. M5 SEO pass, glossary, presets, hardening, public-release checklist
