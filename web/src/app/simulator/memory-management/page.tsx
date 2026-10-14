"use client";

import { useEffect, useState } from "react";
import SimulationPlayer from "@/components/SimulationPlayer";
import type { SimulationResult, Step } from "@/lib/types";
import { pidColor } from "@/lib/gantt";

interface Hole { start: number; size: number }
interface Proc { id: string; size: number; segmentsText: string }

const STRATEGIES = [
  { id: "first-fit", label: "First Fit" },
  { id: "best-fit", label: "Best Fit" },
  { id: "worst-fit", label: "Worst Fit" },
];

const PRESETS: { name: string; memory_size: number; holes: Hole[]; procs: Proc[]; mode: "contiguous" | "segmentation"; note: string }[] = [
  {
    name: "Fragmentation classic",
    mode: "contiguous",
    memory_size: 640,
    holes: [{ start: 0, size: 200 }, { start: 250, size: 150 }, { start: 450, size: 190 }],
    procs: [{ id: "P1", size: 120, segmentsText: "" }, { id: "P2", size: 180, segmentsText: "" }, { id: "P3", size: 90, segmentsText: "" }],
    note: "Holes already exist; watch the map as processes are placed and external fragmentation forms.",
  },
  {
    name: "Failed allocation",
    mode: "contiguous",
    memory_size: 300,
    holes: [{ start: 0, size: 100 }, { start: 150, size: 100 }],
    procs: [{ id: "P1", size: 60, segmentsText: "" }, { id: "P2", size: 150, segmentsText: "" }],
    note: "P2 (150) fits nowhere — 200 free but never contiguous.",
  },
  {
    name: "Segmentation basic",
    mode: "segmentation",
    memory_size: 512,
    holes: [],
    procs: [{ id: "P1", size: 0, segmentsText: "code:100,data:60,stack:40" }, { id: "P2", size: 0, segmentsText: "code:80,stack:30" }],
    note: "Each segment is placed independently into free holes.",
  },
];

const STORAGE_KEY = "kv:memory-management";

export default function MemoryManagementPage() {
  const [mode, setMode] = useState<"contiguous" | "segmentation">("contiguous");
  const [strategy, setStrategy] = useState("first-fit");
  const [memorySize, setMemorySize] = useState(640);
  const [holes, setHoles] = useState<Hole[]>(PRESETS[0].holes);
  const [procs, setProcs] = useState<Proc[]>(PRESETS[0].procs);
  const [results, setResults] = useState<{ strategy: string; result: SimulationResult }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s.mode) setMode(s.mode);
        if (s.strategy) setStrategy(s.strategy);
        if (s.memorySize) setMemorySize(s.memorySize);
        if (s.holes) setHoles(s.holes);
        if (s.procs) setProcs(s.procs);
      }
    } catch {}
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode, strategy, memorySize, holes, procs }));
  }, [mode, strategy, memorySize, holes, procs]);

  function parseSegments(text: string) {
    return text.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
      const [name, size] = part.split(":");
      return { name: name?.trim() ?? "", size: Number(size) };
    });
  }

  async function run() {
    setLoading(true);
    setError(null);
    setResults([]);
    const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
    const processes = mode === "contiguous"
      ? procs.map((p) => ({ id: p.id, size: p.size }))
      : procs.map((p) => ({ id: p.id, segments: parseSegments(p.segmentsText) }));
    try {
      const res = await fetch(`${api}/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: "memory-management",
          payload: {
            mode,
            strategy,
            memory_size: memorySize,
            holes: holes.length ? holes : undefined,
            processes,
          },
        }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(Array.isArray(detail.detail) ? detail.detail.join(", ") : detail.detail ?? res.statusText);
      }
      setResults([{ strategy, result: await res.json() }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="max-w-5xl mx-auto flex flex-col gap-6">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Memory Management</h1>
      <p className="font-mono text-[11px] text-on-surface-variant">Contiguous allocation and segmentation — watch the memory map fill, split, and fragment.</p>

      <section className="mt-6 space-y-4">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button key={p.name} title={p.note} className="neo-btn px-4 py-1.5 font-mono text-[11px] uppercase text-on-surface-variant" onClick={() => { setMode(p.mode); setMemorySize(p.memory_size); setHoles(p.holes); setProcs(p.procs); }}>
              {p.name}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-1">Mode
            <select className="neo-input" value={mode} onChange={(e) => setMode(e.target.value as "contiguous" | "segmentation")}>
              <option value="contiguous">Contiguous</option>
              <option value="segmentation">Segmentation</option>
            </select>
          </label>
          <label className="flex items-center gap-1">Strategy
            <select className="neo-input" value={strategy} onChange={(e) => setStrategy(e.target.value)}>
              {STRATEGIES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1">Memory size <input type="number" min={1} className="w-24 neo-input" value={memorySize} onChange={(e) => setMemorySize(Number(e.target.value))} /></label>
        </div>

        <div>
          <h3 className="text-sm font-medium text-on-surface-variant">Holes (optional — leave empty for one free block)</h3>
          {holes.map((h, i) => (
            <div key={i} className="mt-1 flex items-center gap-2 text-sm">
              <input type="number" placeholder="start" className="w-24 neo-input" value={h.start} onChange={(e) => setHoles(holes.map((x, j) => (j === i ? { ...x, start: Number(e.target.value) } : x)))} />
              <input type="number" placeholder="size" className="w-24 neo-input" value={h.size} onChange={(e) => setHoles(holes.map((x, j) => (j === i ? { ...x, size: Number(e.target.value) } : x)))} />
              <button className="text-error" onClick={() => setHoles(holes.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button className="mt-1 text-sm underline" onClick={() => setHoles([...holes, { start: 0, size: 0 }])}>+ Add hole</button>
        </div>

        <div>
          <h3 className="text-sm font-medium text-on-surface-variant">Processes</h3>
          {procs.map((p, i) => (
            <div key={i} className="mt-1 flex items-center gap-2 text-sm">
              <input className="w-20 neo-input" value={p.id} onChange={(e) => setProcs(procs.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)))} />
              {mode === "contiguous" ? (
                <input type="number" placeholder="size" className="w-24 neo-input" value={p.size} onChange={(e) => setProcs(procs.map((x, j) => (j === i ? { ...x, size: Number(e.target.value) } : x)))} />
              ) : (
                <input placeholder="code:100,data:60" className="w-64 neo-input" value={p.segmentsText} onChange={(e) => setProcs(procs.map((x, j) => (j === i ? { ...x, segmentsText: e.target.value } : x)))} />
              )}
              <button className="text-error" onClick={() => setProcs(procs.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button className="mt-1 text-sm underline" onClick={() => setProcs([...procs, { id: `P${procs.length + 1}`, size: 50, segmentsText: "code:50" }])}>+ Add process</button>
        </div>

        <button onClick={run} disabled={loading} className="neo-btn px-6 py-2.5 font-display font-semibold text-primary disabled:opacity-40">{loading ? "Running…" : "Run"}</button>
        {error && <p className="text-sm text-error">{error}</p>}
      </section>

      {results.map(({ strategy: s, result }) => (
        <section key={s} className="mt-10 space-y-4">
          <h2 className="font-display font-semibold tracking-tight capitalize">{s} — {mode}</h2>
          {result.warnings.length > 0 && <p className="text-sm text-tertiary-fixed-dim">{result.warnings.join(" ")}</p>}
          <SimulationPlayer result={result} renderState={(step: Step) => <MemoryMap step={step} />} />
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            {["memory_utilization", "total_free", "largest_free_hole", "external_fragmentation"].map((k) => (
              <div key={k} className="neo-inset-sm p-3">
                <p className="font-mono text-[10px] uppercase text-on-surface-variant">{k.replaceAll("_", " ")}</p>
                <p className="font-medium">{String(result.metrics[k])}</p>
              </div>
            ))}
          </div>
          {Array.isArray(result.metrics.segment_table) && (result.metrics.segment_table as unknown[]).length > 0 && (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-on-surface-variant"><th>Process</th><th>Segment</th><th>Size</th><th>Base</th><th>Status</th></tr></thead>
              <tbody>
                {(result.metrics.segment_table as { process: string; segment: string; size: number; base: number | null; status: string }[]).map((r, i) => (
                  <tr key={i} className="border-t border-surface-container-highest"><td>{r.process}</td><td>{r.segment}</td><td>{r.size}</td><td>{r.base ?? "—"}</td><td>{r.status}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </main>
  );
}

function MemoryMap({ step }: { step: Step }) {
  const st = step.state as {
    blocks: { start: number; size: number; type: string; owner: string | null; label: string }[];
    memory_size: number;
  };
  const owners = [...new Set(st.blocks.filter((b) => b.owner).map((b) => b.owner as string))];
  return (
    <div className="space-y-2">
      <p className="text-sm text-on-surface-variant">Memory map (total {st.memory_size})</p>
      <div className="flex h-16 w-full overflow-hidden rounded-lg bg-surface-container-low shadow-[inset_2px_2px_5px_rgba(0,0,0,0.8)]">
        {st.blocks.map((b, i) => (
          <div
            key={i}
            title={`${b.label}: ${b.start}–${b.start + b.size} (${b.size})`}
            style={{ width: `${(b.size / st.memory_size) * 100}%`, backgroundColor: b.type === "free" ? "#e5e7eb" : pidColor(b.owner as string, owners) }}
            className="flex items-center justify-center border-r text-xs text-white"
          >
            <span className={b.type === "free" ? "text-on-surface-variant" : ""}>{b.size >= 40 ? b.label : ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
