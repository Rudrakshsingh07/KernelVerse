"use client";

import { useEffect, useRef, useState } from "react";
import SimulationPlayer from "@/components/SimulationPlayer";
import type { SimulationResult, Step } from "@/lib/types";
import { getGantt, pidColor } from "@/lib/gantt";

interface Row {
  id: string;
  arrival: number;
  burst: number;
  io_arrival: number;
  io_duration: number;
}

interface ProcessMetrics {
  id: string;
  waiting: number;
  turnaround: number | null;
  response: number | null;
  started_at: number | null;
  finished_at: number | null;
}

interface RunResult {
  algorithm: string;
  result: SimulationResult;
}

const ALGS = [
  { id: "fcfs", label: "FCFS" },
  { id: "sjf", label: "SJF" },
  { id: "srtf", label: "SRTF" },
  { id: "rr", label: "Round Robin" },
] as const;

const QUANTUM_ALGORITHMS = new Set<string>(["rr"]);

const DEFAULT_ROWS: Row[] = [
  { id: "P1", arrival: 0, burst: 5, io_arrival: 0, io_duration: 0 },
  { id: "P2", arrival: 1, burst: 3, io_arrival: 0, io_duration: 0 },
  { id: "P3", arrival: 2, burst: 1, io_arrival: 0, io_duration: 0 },
];

const STORAGE_KEY = "kv:cpu-scheduling";

/**
 * Arrival times must strictly increase down the process list: P1 arrives
 * before P2, P2 before P3, and so on.  Restored/older workloads are repaired
 * here so the table can never hold a P2 that arrives before P1.
 */
function normalizeArrivals(rows: Row[]): Row[] {
  let previousArrival: number | null = null;
  return rows.map((row) => {
    const requested = Math.max(0, Number(row.arrival) || 0);
    const arrival = previousArrival === null ? requested : Math.max(requested, previousArrival + 1);
    previousArrival = arrival;
    return arrival === row.arrival ? row : { ...row, arrival };
  });
}

/** Index the engine's per-process results by process ID. */
function buildProcessMetrics(result: SimulationResult | null): Map<string, ProcessMetrics> {
  const metrics = new Map<string, ProcessMetrics>();
  const perProcess = result?.metrics.per_process;
  if (!Array.isArray(perProcess)) return metrics;

  for (const item of perProcess) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string") continue;
    metrics.set(record.id, {
      id: record.id,
      waiting: typeof record.waiting === "number" ? record.waiting : 0,
      turnaround: typeof record.turnaround === "number" ? record.turnaround : null,
      response: typeof record.response === "number" ? record.response : null,
      started_at: typeof record.started_at === "number" ? record.started_at : null,
      finished_at: typeof record.finished_at === "number" ? record.finished_at : null,
    });
  }
  return metrics;
}

function formatMetric(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.length > 0) return value;
  return "—";
}

function formatAverage(value: unknown): string {
  const formatted = formatMetric(value);
  return formatted === "—" ? formatted : `${formatted} ms`;
}

export default function CPUSchedulingPage() {
  const [rows, setRows] = useState<Row[]>(DEFAULT_ROWS);
  const [algorithm, setAlgorithm] = useState<string>("rr");
  const [quantum, setQuantum] = useState(2);
  const [ioEnabled, setIoEnabled] = useState(false);
  const [run, setRun] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (Array.isArray(saved.rows)) setRows(normalizeArrivals(saved.rows));
        // Ignore algorithms that are no longer offered (e.g. the removed
        // Priority scheduler) instead of leaving no algorithm selected.
        if (ALGS.some((item) => item.id === saved.algorithm)) setAlgorithm(saved.algorithm);
        if (saved.quantum) setQuantum(saved.quantum);
        if (typeof saved.ioEnabled === "boolean") {
          setIoEnabled(saved.ioEnabled);
        } else if (Array.isArray(saved.rows)) {
          // Older saves always showed the I/O columns; keep them visible if the
          // saved workload actually used I/O.
          setIoEnabled(saved.rows.some((row: Row) => Number(row.io_duration) > 0));
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ rows, algorithm, quantum, ioEnabled }));
  }, [rows, algorithm, quantum, ioEnabled]);

  const usesQuantum = QUANTUM_ALGORITHMS.has(algorithm);
  const activeLabel = ALGS.find((a) => algorithm === a.id)?.label ?? "—";
  const processMetrics = buildProcessMetrics(run?.result ?? null);

  function clearRun() {
    setRun(null);
    setError(null);
  }

  async function runAll() {
    setLoading(true);
    setError(null);
    setRun(null);
    const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
    try {
      const payload: Record<string, unknown> = {
        algorithm,
        processes: rows.map((row) => ({
          id: row.id,
          arrival: row.arrival,
          burst: row.burst,
          // Hidden I/O values must not leak into a run when the feature is off.
          io_arrival: ioEnabled ? row.io_arrival : 0,
          io_duration: ioEnabled ? row.io_duration : 0,
        })),
      };
      if (usesQuantum) payload.quantum = quantum;

      const res = await fetch(`${api}/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: "cpu-scheduling", payload }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(Array.isArray(detail.detail) ? detail.detail.join(", ") : detail.detail ?? res.statusText);
      }
      setRun({ algorithm, result: (await res.json()) as SimulationResult });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  function updateArrival(index: number, value: string) {
    clearRun();
    setRows((current) => {
      // A process can never arrive before the one above it.  Raising an
      // earlier arrival also pushes every later process forward so the whole
      // column stays strictly ascending.
      const lowerBound = index === 0 ? 0 : current[index - 1].arrival + 1;
      const requested = Number(value);
      const arrival = Math.max(lowerBound, Number.isFinite(requested) ? Math.floor(requested) : lowerBound);
      const updated = current.map((row, idx) => (idx === index ? { ...row, arrival } : row));
      return normalizeArrivals(updated);
    });
  }

  function updateRow(i: number, key: keyof Row, value: string) {
    if (key === "arrival") {
      updateArrival(i, value);
      return;
    }
    clearRun();
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [key]: key === "id" ? value : Number(value) } : r)));
  }

  return (
    <main className="flex flex-col gap-6">
      {/* Context subheader */}
      <header className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 p-4 rounded-xl bg-surface-container shadow-[6px_6px_14px_rgba(0,0,0,0.65),-5px_-5px_12px_rgba(255,255,255,0.04)]">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-surface-container-lowest shadow-[inset_3px_3px_7px_rgba(0,0,0,0.7)]">
            <span className="material-symbols-outlined text-primary-fixed-dim text-base">memory</span>
            <span className="font-mono text-[11px] text-on-surface-variant uppercase tracking-wider">Subsystem</span>
            <span className="text-on-surface-variant">/</span>
            <span className="font-display text-sm text-primary font-medium">CPU Scheduling</span>
            <span className="material-symbols-outlined text-outline text-sm">chevron_right</span>
            <span className="font-mono text-xs text-primary-fixed font-semibold">{activeLabel}{usesQuantum ? ` (q=${quantum}ms)` : ""}</span>
          </div>
        </div>
        <button onClick={runAll} disabled={loading} className="neo-btn px-6 py-2.5 font-display font-semibold text-primary disabled:opacity-40">
          {loading ? "Running…" : "▶ Run Simulation"}
        </button>
      </header>

      {error && <p className="text-sm text-error px-1" role="alert">{error}</p>}

      {/* Workload table: the dominant surface of the page. */}
      <section className="neo-panel flex h-[calc(80vh-6rem)] min-h-[560px] flex-col gap-4 overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary-fixed-dim text-lg">table_chart</span>
              <h2 className="font-display font-semibold tracking-tight">Process Workload</h2>
              <span className="px-2 py-0.5 rounded font-mono text-[11px] bg-surface-container-lowest text-on-surface-variant shadow-[inset_1px_1px_3px_rgba(0,0,0,0.7)]">{rows.length} processes</span>
            </div>
            <p className="font-mono text-[10px] leading-relaxed text-on-surface-variant">
              Edit any cell directly. Arrival times stay strictly ascending from P1 → Pn.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => {
              clearRun();
              setRows((current) => {
                const lastArrival = current[current.length - 1]?.arrival ?? -1;
                return [...current, { id: `P${current.length + 1}`, arrival: lastArrival + 1, burst: 2, io_arrival: 0, io_duration: 0 }];
              });
            }} className="neo-btn flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium hover:text-primary">
              <span className="material-symbols-outlined text-base">add_circle</span>Add Process
            </button>
            <button onClick={() => {
              clearRun();
              setRows((current) => {
                let previousArrival = -1;
                return current.map((r) => {
                  const arrival = previousArrival + 1 + Math.floor(Math.random() * 2);
                  previousArrival = arrival;
                  const burst = 1 + Math.floor(Math.random() * 8);
                  return {
                    ...r,
                    arrival,
                    burst,
                    io_arrival: ioEnabled ? Math.floor(Math.random() * burst) : 0,
                    io_duration: ioEnabled ? Math.floor(Math.random() * 4) : 0,
                  };
                });
              });
            }} className="neo-btn flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium hover:text-secondary">
              <span className="material-symbols-outlined text-base">shuffle</span>Randomize
            </button>
          </div>
        </div>

        {/* Scheduling controls */}
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-surface-container-low px-3 py-2.5">
          <span className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">Algorithm</span>
          <div className="flex flex-wrap gap-1.5">
            {ALGS.map((a) => {
              const on = algorithm === a.id;
              return (
                <button key={a.id} onClick={() => {
                  if (a.id === algorithm) return;
                  setAlgorithm(a.id);
                  clearRun();
                }} aria-pressed={on}
                  className={`px-3 py-1.5 rounded-lg font-mono text-xs transition-all ${on ? "bg-surface-container-lowest text-primary shadow-[inset_2px_2px_5px_rgba(0,0,0,0.8)]" : "bg-surface-container-low text-on-surface-variant neo-btn"}`}>
                  {a.label}
                </button>
              );
            })}
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">I/O Complexity</span>
              <button
                type="button"
                role="switch"
                aria-checked={ioEnabled}
                aria-label="Toggle I/O complexity"
                onClick={() => {
                  setIoEnabled((value) => !value);
                  clearRun();
                }}
                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${ioEnabled ? "bg-primary-container" : "bg-surface-container-high shadow-[inset_2px_2px_5px_rgba(0,0,0,0.8)]"}`}
              >
                <span className={`absolute top-1 h-4 w-4 rounded-full transition-all ${ioEnabled ? "left-6 bg-[#0c0e12]" : "left-1 bg-outline"}`} />
              </button>
            </div>

            {usesQuantum && (
              <label className="flex items-center gap-2">
                <span className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">Quantum</span>
                <input type="range" min={1} max={10} value={quantum} onChange={(e) => {
                  setQuantum(Number(e.target.value));
                  clearRun();
                }} className="w-28 accent-primary-container" />
                <span className="font-mono text-sm text-primary font-bold">{quantum} ms</span>
              </label>
            )}
          </div>
        </div>

        {/* Direct-input / results table */}
        <div className="neo-inset min-h-0 flex-1 overflow-auto p-2">
          <table className="w-full border-collapse text-left font-mono text-sm">
            <thead className="sticky top-0 z-10 bg-[#0c0e12]">
              <tr className="text-[11px] uppercase tracking-wider text-on-surface-variant">
                <th className="px-3 py-3 font-medium">PID</th>
                <th className="px-3 py-3 font-medium text-center" title="Arrival Time">AT</th>
                <th className="px-3 py-3 font-medium text-center" title="Burst Time">BT</th>
                {ioEnabled && (
                  <>
                    <th className="px-3 py-3 font-medium text-center" title="CPU units consumed before I/O begins">IO Arrival</th>
                    <th className="px-3 py-3 font-medium text-center" title="I/O wait in ms (0 = no I/O)">IO Duration</th>
                  </>
                )}
                <th className="px-3 py-3 font-medium text-center" title="Start Time">ST</th>
                <th className="px-3 py-3 font-medium text-center" title="Completion Time">CT</th>
                <th className="px-3 py-3 font-medium text-center" title="Turnaround Time">TAT</th>
                <th className="px-3 py-3 font-medium text-center" title="Waiting Time">WT</th>
                <th className="px-3 py-3 font-medium text-center" title="Response Time">RT</th>
                <th className="px-3 py-3" />
              </tr>
            </thead>
            <tbody className="text-on-surface">
              {rows.map((r, i) => {
                const metric = processMetrics.get(r.id);
                return (
                  <tr key={i} className="border-t border-surface-container-highest/70 transition-colors hover:bg-surface-container-high/40">
                    <td className="px-3 py-2.5">
                      <input className="neo-input w-24 font-bold text-primary-fixed" value={r.id} onChange={(e) => updateRow(i, "id", e.target.value)} />
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <input type="number" min={i === 0 ? 0 : rows[i - 1].arrival + 1} className="neo-input w-20 text-center" title={i === 0 ? "Arrival must be 0 or later" : `Must arrive after ${rows[i - 1].id}`} value={r.arrival} onChange={(e) => updateRow(i, "arrival", e.target.value)} />
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <input type="number" min={1} className="neo-input w-20 text-center" value={r.burst} onChange={(e) => updateRow(i, "burst", e.target.value)} />
                    </td>
                    {ioEnabled && (
                      <>
                        <td className="px-3 py-2.5 text-center">
                          <input type="number" min={0} className="neo-input w-24 text-center" title="CPU units consumed before I/O begins" value={r.io_arrival ?? 0} onChange={(e) => updateRow(i, "io_arrival", e.target.value)} />
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <input type="number" min={0} className="neo-input w-24 text-center" title="I/O wait in ms (0 = no I/O)" value={r.io_duration ?? 0} onChange={(e) => updateRow(i, "io_duration", e.target.value)} />
                        </td>
                      </>
                    )}
                    <td className={`px-3 py-2.5 text-center ${metric ? "text-primary-fixed" : "text-on-surface-variant/40"}`}>{formatMetric(metric?.started_at)}</td>
                    <td className={`px-3 py-2.5 text-center ${metric ? "text-primary-fixed" : "text-on-surface-variant/40"}`}>{formatMetric(metric?.finished_at)}</td>
                    <td className={`px-3 py-2.5 text-center ${metric ? "text-secondary-fixed" : "text-on-surface-variant/40"}`}>{formatMetric(metric?.turnaround)}</td>
                    <td className={`px-3 py-2.5 text-center ${metric ? "text-secondary-fixed" : "text-on-surface-variant/40"}`}>{formatMetric(metric?.waiting)}</td>
                    <td className={`px-3 py-2.5 text-center ${metric ? "text-secondary-fixed" : "text-on-surface-variant/40"}`}>{formatMetric(metric?.response)}</td>
                    <td className="px-3 py-2.5 text-right">
                      <button onClick={() => {
                        clearRun();
                        setRows(rows.filter((_, j) => j !== i));
                      }} className="text-error text-sm" aria-label={`Remove ${r.id}`}>✕</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Calculated averages stay directly below the table. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[
            { label: "Average TAT", value: run?.result.metrics.avg_turnaround },
            { label: "Average WT", value: run?.result.metrics.avg_waiting },
            { label: "Average RT", value: run?.result.metrics.avg_response },
          ].map((item) => (
            <div key={item.label} className="neo-inset-sm flex items-center justify-between gap-3 px-4 py-3">
              <span className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">{item.label}</span>
              <span className={`font-display text-2xl font-semibold ${run ? "text-primary" : "text-on-surface-variant/40"}`}>
                {run ? formatAverage(item.value) : "—"}
              </span>
            </div>
          ))}
        </div>
      </section>

      {run && <ResultBlock algorithm={run.algorithm} result={run.result} />}
    </main>
  );
}

function ResultBlock({ algorithm, result }: { algorithm: string; result: SimulationResult }) {
  const [index, setIndex] = useState(0);
  const gantt = getGantt(result.steps);
  const total = gantt.length ? gantt[gantt.length - 1].end : 0;
  const ids = [...new Set(gantt.map((s) => s.pid))];
  const currentTick = index < result.steps.length ? result.steps[index].tick : total;
  const stepRunning = result.steps[index]?.state?.running as string | null;

  return (
    <section className="neo-panel flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-primary animate-ping" />
          <h2 className="font-display font-semibold tracking-tight uppercase">{algorithm} — Gantt Chart</h2>
        </div>
        <div className="neo-inset-sm px-4 py-2 text-sm font-mono">
          Hardware Core 0 — Executing <strong className="text-primary">{stepRunning ?? "idle"}</strong>
        </div>
      </div>

      {/* Gantt instrument */}
      <div className="neo-inset p-4 overflow-hidden">
        <div className="flex justify-between font-mono text-[11px] text-on-surface-variant pb-2">
          <span className="flex items-center gap-1"><span className="material-symbols-outlined text-xs text-primary">timeline</span> GANTT SCHEDULING TRACE (0–{total}ms)</span>
          <span className="text-primary font-bold">t = {currentTick}ms</span>
        </div>
        <GanttTrack gantt={gantt} total={total} currentTick={currentTick} ids={ids} />

        {/* Ready queue pipeline */}
        <ReadyQueue steps={result.steps} index={index} />
      </div>

      <SimulationPlayer result={result} onIndex={setIndex} renderState={(step: Step) => <CpuStateView step={step} />} />

      {/* Secondary metrics; TAT/WT/RT averages are shown under the table. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {["throughput", "cpu_utilization", "context_switches", "total_time"].map((k) => (
          <div key={k} className="neo-inset-sm p-3">
            <p className="font-mono text-[10px] uppercase text-on-surface-variant">{k.replaceAll("_", " ")}</p>
            <p className="font-display font-semibold">{formatMetric(result.metrics[k])}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function GanttTrack({ gantt, total, currentTick, ids }: { gantt: ReturnType<typeof getGantt>; total: number; currentTick: number; ids: string[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; left: number } | null>(null);
  const PIXELS_PER_MS = 30;
  const trackWidth = Math.max(total * PIXELS_PER_MS, 720);
  const axisBottom = 32; // px reserved for axis + tick labels

  return (
    <div
      ref={scroller}
      className="relative w-full pt-6 pb-2 overflow-x-auto cursor-grab active:cursor-grabbing select-none"
      onPointerDown={(e) => { drag.current = { x: e.clientX, left: scroller.current!.scrollLeft }; scroller.current!.setPointerCapture(e.pointerId); }}
      onPointerMove={(e) => { if (drag.current && scroller.current) scroller.current.scrollLeft = drag.current.left - (e.clientX - drag.current.x); }}
      onPointerUp={() => { drag.current = null; }}
      onPointerLeave={() => { drag.current = null; }}
    >
      <div className="relative rounded-xl bg-[#0c0e12] border border-surface-container-highest" style={{ width: trackWidth, height: 280 }}>
        {/* grid: minor 1ms, major 2ms; horizontal every 30px */}
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(to right, rgba(255,255,255,0.10) 1px, transparent 1px), linear-gradient(to right, rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.10) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.045) 1px, transparent 1px)",
            backgroundSize: `${2 * PIXELS_PER_MS}px 100%, ${PIXELS_PER_MS}px 100%, 100% 60px, 100% 30px`,
          }}
        />
        {/* y axis */}
        <div className="absolute left-0 top-0 w-px bg-white/60" style={{ bottom: axisBottom }} />

        {/* process bars lane */}
        <div className="absolute left-0 right-0 top-0" style={{ bottom: axisBottom }}>
          {gantt.map((s, i) => (
            <div
              key={i}
              className="absolute top-1/2 -translate-y-1/2 h-12 flex items-center justify-center rounded-md text-white hover:brightness-125 transition-all shadow-lg"
              style={{ left: `${(s.start / Math.max(total, 1)) * 100}%`, width: `${((s.end - s.start) / Math.max(total, 1)) * 100}%`, backgroundColor: pidColor(s.pid, ids) }}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
            >
              <span className="font-display text-base font-bold">{s.pid}</span>
              {hovered === i && (
                <div className="absolute -top-9 left-1/2 -translate-x-1/2 z-20 whitespace-nowrap rounded-md bg-[#0c0e12] border border-outline-variant px-2 py-1 font-mono text-[11px] text-primary shadow-xl">
                  {s.pid}: {s.start}ms → {s.end}ms
                </div>
              )}
            </div>
          ))}
        </div>

        {/* playhead */}
        <div className="absolute top-0 w-0.5 bg-[#00f0ff] shadow-[0_0_12px_#00f0ff]" style={{ bottom: axisBottom, left: `${(currentTick / Math.max(total, 1)) * 100}%` }}>
          <div className="w-3 h-3 rounded-full bg-primary absolute -top-1.5 -translate-x-1/2" />
        </div>

        {/* x axis + arrowhead */}
        <div className="absolute left-0 right-0 h-px bg-white/60" style={{ bottom: axisBottom }} />
        <div className="absolute right-0 w-0 h-0" style={{ bottom: axisBottom - 5, borderTop: "5px solid transparent", borderBottom: "5px solid transparent", borderLeft: "9px solid rgba(255,255,255,0.6)" }} />

        {/* tick marks + labels every 2ms */}
        {Array.from({ length: Math.floor(total / 2) + 1 }, (_, i) => i * 2).map((t) => (
          <div key={t} className="absolute w-px h-2 bg-white/60" style={{ bottom: axisBottom, left: `${(t / Math.max(total, 1)) * 100}%` }}>
            <span className={`absolute top-2.5 -translate-x-1/2 font-mono text-[11px] ${t === currentTick ? "text-primary font-bold" : "text-on-surface-variant"}`}>{t}</span>
          </div>
        ))}
        <span className="absolute right-2 font-mono text-[11px] text-on-surface-variant" style={{ bottom: 4 }}>Time (ms)</span>
      </div>
    </div>
  );
}

function ReadyQueue({ steps, index }: { steps: Step[]; index: number }) {
  const ready = ((steps[index]?.state?.ready as string[]) ?? []);
  return (
    <div className="pt-4 flex flex-col gap-2">
      <div className="flex justify-between">
        <span className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant flex items-center gap-1">
          <span className="material-symbols-outlined text-xs text-tertiary-fixed-dim">reorder</span>Ready Queue (FIFO Buffer)
        </span>
        <span className="font-mono text-[11px] text-on-surface-variant">Depth: {ready.length}</span>
      </div>
      <div className="flex items-center gap-2 p-2 rounded-lg bg-surface-container shadow-[inset_2px_2px_5px_rgba(0,0,0,0.8)] overflow-x-auto">
        <div className="font-mono text-[10px] text-tertiary-fixed uppercase font-semibold px-2 py-1 rounded bg-surface-container-lowest">HEAD →</div>
        {ready.length === 0 && <span className="text-xs text-on-surface-variant font-mono">empty</span>}
        {ready.map((pid, i) => (
          <div key={i} className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-[#1a1e24] shadow-[4px_4px_8px_rgba(0,0,0,0.7)] font-mono">
            <span className="w-2 h-2 rounded-full bg-primary-fixed-dim shadow-[0_0_6px_#00f0ff]" />
            <span className="font-bold text-sm">{pid}</span>
          </div>
        ))}
        <div className="font-mono text-[10px] text-on-surface-variant uppercase px-2 py-1 rounded bg-surface-container-lowest">TAIL</div>
      </div>
    </div>
  );
}

function CpuStateView({ step }: { step: Step }) {
  const s = step.state as { running: string | null; completed: string[]; blocked?: { id: string; remaining: number }[]; processes: { id: string; remaining: number; burst: number }[] };
  return (
    <div className="flex flex-wrap gap-2 font-mono text-xs">
      <span className="text-on-surface-variant">running:</span> <span className="text-primary font-bold">{s.running ?? "idle"}</span>
      <span className="text-on-surface-variant ml-2">completed:</span> <span>{s.completed.join(", ") || "—"}</span>
      <span className="text-on-surface-variant ml-2">blocked (I/O):</span> <span className="text-tertiary-fixed-dim">{(s.blocked ?? []).map((b) => `${b.id}(${b.remaining}ms)`).join(", ") || "—"}</span>
      <span className="w-full" />
      {s.processes.map((p) => (
        <span key={p.id} className="px-2 py-0.5 rounded-md bg-surface-container text-on-surface" style={{ opacity: p.remaining === 0 ? 0.35 : 1 }}>
          {p.id} ({p.remaining}/{p.burst})
        </span>
      ))}
    </div>
  );
}
