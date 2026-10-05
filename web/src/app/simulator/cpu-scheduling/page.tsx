"use client";

import { useEffect, useRef, useState } from "react";
import SimulationPlayer from "@/components/SimulationPlayer";
import type { SimulationResult, Step } from "@/lib/types";
import { getGantt, pidColor } from "@/lib/gantt";

interface Row {
  id: string;
  arrival: number;
  burst: number;
  priority: number;
  queue: number;
  io_arrival: number;
  io_duration: number;
}

const ALGS = [
  { id: "fcfs", label: "FCFS" },
  { id: "sjf", label: "SJF" },
  { id: "srtf", label: "SRTF" },
  { id: "priority", label: "Priority" },
  { id: "rr", label: "Round Robin" },
] as const;

const DEFAULT_ROWS: Row[] = [
  { id: "P1", arrival: 0, burst: 5, priority: 1, queue: 0, io_arrival: 0, io_duration: 0 },
  { id: "P2", arrival: 1, burst: 3, priority: 2, queue: 0, io_arrival: 0, io_duration: 0 },
  { id: "P3", arrival: 2, burst: 1, priority: 3, queue: 0, io_arrival: 0, io_duration: 0 },
];

const STORAGE_KEY = "kv:cpu-scheduling";

export default function CPUSchedulingPage() {
  const [rows, setRows] = useState<Row[]>(DEFAULT_ROWS);
  const [algorithm, setAlgorithm] = useState<string>("rr");
  const [quantum, setQuantum] = useState(2);
  const [results, setResults] = useState<{ algorithm: string; result: SimulationResult }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.rows) setRows(saved.rows);
        if (saved.algorithm) setAlgorithm(saved.algorithm);
        if (saved.quantum) setQuantum(saved.quantum);
      }
    } catch {}
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ rows, algorithm, quantum }));
  }, [rows, algorithm, quantum]);

  async function runAll() {
    setLoading(true);
    setError(null);
    setResults([]);
    const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
    try {
      const out: { algorithm: string; result: SimulationResult }[] = [];
      for (const alg of [algorithm]) {
        const res = await fetch(`${api}/simulate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic: "cpu-scheduling", payload: { algorithm: alg, quantum, processes: rows } }),
        });
        if (!res.ok) {
          const detail = await res.json().catch(() => ({}));
          throw new Error(Array.isArray(detail.detail) ? detail.detail.join(", ") : detail.detail ?? res.statusText);
        }
        out.push({ algorithm: alg, result: await res.json() });
      }
      setResults(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  function updateRow(i: number, key: keyof Row, value: string) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [key]: key === "id" ? value : Number(value) } : r)));
  }

  const activeLabel = ALGS.filter((a) => algorithm === a.id).map((a) => a.label).join(", ");

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
            <span className="font-mono text-xs text-primary-fixed font-semibold">{activeLabel || "—"}{algorithm === "rr" ? ` (q=${quantum}ms)` : ""}</span>
          </div>
        </div>
        <button onClick={runAll} disabled={loading || false} className="neo-btn px-6 py-2.5 font-display font-semibold text-primary disabled:opacity-40">
          {loading ? "Running…" : "▶ Run Simulation"}
        </button>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* LEFT: Parameters + Process table */}
        <aside className="xl:col-span-4 flex flex-col gap-6">
          <section className="neo-panel flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary-fixed-dim text-lg">tune</span>
                <h2 className="font-display font-semibold tracking-tight">Parameters</h2>
              </div>
              <span className="px-2 py-0.5 rounded font-mono text-[11px] bg-surface-container-lowest text-on-surface-variant shadow-[inset_1px_1px_3px_rgba(0,0,0,0.7)]">[DISPATCHER]</span>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">Scheduling Algorithms (multi = compare)</label>
              <div className="flex flex-wrap gap-1.5">
                {ALGS.map((a) => {
                  const on = algorithm === a.id;
                  return (
                    <button key={a.id} onClick={() => setAlgorithm(a.id)}
                      className={`px-3 py-1.5 rounded-lg font-mono text-xs transition-all ${on ? "bg-surface-container-lowest text-primary shadow-[inset_2px_2px_5px_rgba(0,0,0,0.8)]" : "bg-surface-container-low text-on-surface-variant neo-btn"}`}>
                      {a.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between items-center">
                <label className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">Time Quantum (q)</label>
                <span className="font-mono text-sm text-primary font-bold px-2 rounded bg-surface-container-lowest shadow-[inset_1px_1px_3px_rgba(0,0,0,0.7)]">{quantum} ms</span>
              </div>
              <input type="range" min={1} max={10} value={quantum} onChange={(e) => setQuantum(Number(e.target.value))} className="w-full h-2 rounded-full appearance-none cursor-pointer bg-surface-container-lowest accent-primary-container" />
            </div>
          </section>

          <section className="neo-panel flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary-fixed-dim text-lg">format_list_bulleted</span>
                <h2 className="font-display font-semibold tracking-tight">Process Table</h2>
              </div>
              <span className="font-mono text-[11px] text-on-surface-variant">{rows.length} Workloads</span>
            </div>

            <div className="overflow-x-auto neo-inset p-1.5">
              <table className="w-full text-left font-mono text-sm border-collapse">
                <thead>
                  <tr className="text-on-surface-variant text-[11px] uppercase">
                    <th className="p-1.5 font-medium">PID</th>
                    <th className="p-1.5 font-medium text-center">Arrival</th>
                    <th className="p-1.5 font-medium text-center">Burst</th>
                    <th className="p-1.5 font-medium text-center">Prio</th>
                    <th className="p-1.5 font-medium text-center">Q</th>
                    <th className="p-1.5 font-medium text-center">IO in</th>
                    <th className="p-1.5 font-medium text-center">IO dur</th>
                    <th />
                  </tr>
                </thead>
                <tbody className="text-on-surface">
                  {rows.map((r, i) => (
                    <tr key={i} className="hover:bg-surface-container-high/40 transition-colors">
                      <td className="p-1.5"><input className="neo-input w-16 font-bold text-primary-fixed" value={r.id} onChange={(e) => updateRow(i, "id", e.target.value)} /></td>
                      <td className="p-1.5"><input type="number" min={0} className="neo-input w-14 text-center" value={r.arrival} onChange={(e) => updateRow(i, "arrival", e.target.value)} /></td>
                      <td className="p-1.5"><input type="number" min={1} className="neo-input w-14 text-center" value={r.burst} onChange={(e) => updateRow(i, "burst", e.target.value)} /></td>
                      <td className="p-1.5"><input type="number" className="neo-input w-12 text-center" value={r.priority} onChange={(e) => updateRow(i, "priority", e.target.value)} /></td>
                      <td className="p-1.5"><input type="number" min={0} max={1} className="neo-input w-10 text-center" value={r.queue} onChange={(e) => updateRow(i, "queue", e.target.value)} /></td>
                      <td className="p-1.5"><input type="number" min={0} className="neo-input w-12 text-center" title="CPU units consumed before I/O begins" value={r.io_arrival ?? 0} onChange={(e) => updateRow(i, "io_arrival", e.target.value)} /></td>
                      <td className="p-1.5"><input type="number" min={0} className="neo-input w-12 text-center" title="I/O wait in ms (0 = no I/O)" value={r.io_duration ?? 0} onChange={(e) => updateRow(i, "io_duration", e.target.value)} /></td>
                      <td className="p-1.5 text-right"><button onClick={() => setRows(rows.filter((_, j) => j !== i))} className="text-error text-xs">✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => setRows([...rows, { id: `P${rows.length + 1}`, arrival: 0, burst: 2, priority: 1, queue: 0, io_arrival: 0, io_duration: 0 }])} className="neo-btn flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium hover:text-primary">
                <span className="material-symbols-outlined text-base">add_circle</span>Add Process
              </button>
              <button onClick={() => setRows(rows.map((r) => { const burst = 1 + Math.floor(Math.random() * 8); return { ...r, arrival: Math.floor(Math.random() * 4), burst, io_arrival: Math.floor(Math.random() * burst), io_duration: Math.floor(Math.random() * 4) }; }))} className="neo-btn flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium hover:text-secondary">
                <span className="material-symbols-outlined text-base">shuffle</span>Randomize
              </button>
            </div>
          </section>
        </aside>

        {/* RIGHT: Stage */}
        <main className="xl:col-span-8 flex flex-col gap-6">
          {error && <p className="text-sm text-error">{error}</p>}

          {results.length === 0 && (
            <div className="neo-panel text-center text-on-surface-variant font-mono text-sm py-16">
              Configure parameters and hit <span className="text-primary">Run Simulation</span>.
            </div>
          )}

          {results.length > 1 && (
            <section className="neo-panel">
              <h2 className="font-display font-semibold mb-3">Algorithm Comparison</h2>
              <table className="w-full text-left font-mono text-sm">
                <thead><tr className="text-on-surface-variant text-[11px] uppercase">
                  <th className="p-1.5">Algorithm</th><th className="p-1.5">Avg wait</th><th className="p-1.5">Avg TAT</th><th className="p-1.5">Avg response</th><th className="p-1.5">Throughput</th><th className="p-1.5">CPU util</th><th className="p-1.5">Ctx switches</th>
                </tr></thead>
                <tbody>
                  {results.map(({ algorithm, result }) => (
                    <tr key={algorithm} className="border-t border-surface-container-highest">
                      <td className="p-1.5 uppercase text-primary-fixed">{algorithm}</td>
                      <td className="p-1.5">{String(result.metrics.avg_waiting)}</td>
                      <td className="p-1.5">{String(result.metrics.avg_turnaround)}</td>
                      <td className="p-1.5">{String(result.metrics.avg_response)}</td>
                      <td className="p-1.5">{String(result.metrics.throughput)}</td>
                      <td className="p-1.5">{String(result.metrics.cpu_utilization)}</td>
                      <td className="p-1.5">{String(result.metrics.context_switches)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {results.map(({ algorithm, result }) => (
            <ResultBlock key={algorithm} algorithm={algorithm} result={result} />
          ))}
        </main>
      </div>
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
          <h2 className="font-display font-semibold tracking-tight uppercase">{algorithm} — Virtual Execution Timeline</h2>
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

      {/* Metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {["avg_waiting", "avg_turnaround", "avg_response", "throughput", "cpu_utilization", "context_switches"].map((k) => (
          <div key={k} className="neo-inset-sm p-3">
            <p className="font-mono text-[10px] uppercase text-on-surface-variant">{k.replaceAll("_", " ")}</p>
            <p className="font-display font-semibold">{String(result.metrics[k])}</p>
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
