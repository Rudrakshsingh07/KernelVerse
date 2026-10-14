"use client";

import { useEffect, useState } from "react";
import SimulationPlayer from "@/components/SimulationPlayer";
import type { SimulationResult, Step } from "@/lib/types";

const ALGS = [
  { id: "fifo", label: "FIFO" },
  { id: "lru", label: "LRU" },
  { id: "optimal", label: "Optimal" },
];

const PRESETS = [
  { name: "Belady's anomaly", refs: "1 2 3 4 1 2 5 1 2 3 4 5", frames: 3, tlb: 0, note: "FIFO with 3 frames → 9 faults; try 4 frames → 10. Anomaly!" },
  { name: "LRU friendly", refs: "1 2 3 1 2 4 5 1 2 3 4 5", frames: 3, tlb: 0, note: "Locality of reference — LRU shines." },
  { name: "TLB demo", refs: "1 1 2 1 2 3 1 2 3", frames: 3, tlb: 2, note: "Watch TLB hits skip the frames entirely." },
];

const STORAGE_KEY = "kv:paging";

export default function PagingPage() {
  const [refsText, setRefsText] = useState(PRESETS[0].refs);
  const [frames, setFrames] = useState(PRESETS[0].frames);
  const [tlbSize, setTlbSize] = useState(PRESETS[0].tlb);
  const [algorithms, setAlgorithms] = useState<string[]>(["fifo", "lru", "optimal"]);
  const [results, setResults] = useState<{ algorithm: string; result: SimulationResult }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s.refsText) setRefsText(s.refsText);
        if (s.frames) setFrames(s.frames);
        if (s.tlbSize !== undefined) setTlbSize(s.tlbSize);
        if (s.algorithms) setAlgorithms(s.algorithms);
      }
    } catch {}
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ refsText, frames, tlbSize, algorithms }));
  }, [refsText, frames, tlbSize, algorithms]);

  async function runAll() {
    setLoading(true);
    setError(null);
    setResults([]);
    const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
    const reference_string = refsText.split(/[\s,]+/).filter(Boolean).map(Number);
    try {
      const out: { algorithm: string; result: SimulationResult }[] = [];
      for (const alg of algorithms) {
        const res = await fetch(`${api}/simulate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic: "paging", payload: { algorithm: alg, reference_string, frames, tlb_size: tlbSize } }),
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

  return (
    <main className="max-w-5xl mx-auto flex flex-col gap-6">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Paging</h1>
      <p className="font-mono text-[11px] text-on-surface-variant">Page replacement algorithms with an optional TLB. Step through each reference.</p>

      <section className="mt-6 space-y-4">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button key={p.name} title={p.note} className="neo-btn px-4 py-1.5 font-mono text-[11px] uppercase text-on-surface-variant" onClick={() => { setRefsText(p.refs); setFrames(p.frames); setTlbSize(p.tlb); }}>{p.name}</button>
          ))}
        </div>

        <label className="block text-sm">
          Reference string (space/comma separated page numbers)
          <input className="mt-1 w-full neo-input px-3 py-2" value={refsText} onChange={(e) => setRefsText(e.target.value)} />
        </label>

        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label>Frames <input type="number" min={1} className="w-20 neo-input" value={frames} onChange={(e) => setFrames(Number(e.target.value))} /></label>
          <label>TLB size <input type="number" min={0} className="w-20 neo-input" value={tlbSize} onChange={(e) => setTlbSize(Number(e.target.value))} /></label>
          {ALGS.map((a) => (
            <label key={a.id} className="flex items-center gap-1">
              <input type="checkbox" checked={algorithms.includes(a.id)} onChange={(e) => setAlgorithms(e.target.checked ? [...algorithms, a.id] : algorithms.filter((x) => x !== a.id))} />
              {a.label}
            </label>
          ))}
        </div>

        <button onClick={runAll} disabled={loading || algorithms.length === 0} className="neo-btn px-6 py-2.5 font-display font-semibold text-primary disabled:opacity-40">{loading ? "Running…" : "Run"}</button>
        {error && <p className="text-sm text-error">{error}</p>}
      </section>

      {results.length > 1 && (
        <section className="mt-10">
          <h2 className="font-display font-semibold tracking-tight">Comparison</h2>
          <table className="mt-3 w-full text-sm">
            <thead><tr className="text-left text-on-surface-variant"><th>Algorithm</th><th>Page faults</th><th>Hit ratio</th><th>Fault rate</th><th>TLB hit ratio</th></tr></thead>
            <tbody>
              {results.map(({ algorithm, result }) => (
                <tr key={algorithm} className="border-t border-surface-container-highest">
                  <td className="py-1 font-medium uppercase">{algorithm}</td>
                  <td>{String(result.metrics.page_faults)}</td>
                  <td>{String(result.metrics.hit_ratio)}</td>
                  <td>{String(result.metrics.fault_rate)}</td>
                  <td>{String(result.metrics.tlb_hit_ratio ?? "—")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {results.map(({ algorithm, result }) => (
        <section key={algorithm} className="mt-10 space-y-4">
          <h2 className="font-display font-semibold tracking-tight uppercase">{algorithm}</h2>
          <SimulationPlayer result={result} renderState={(step: Step) => <PagingState step={step} />} />
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            {["page_faults", "hit_ratio", "fault_rate", "tlb_hit_ratio"].map((k) => (
              <div key={k} className="neo-inset-sm p-3">
                <p className="font-mono text-[10px] uppercase text-on-surface-variant">{k.replaceAll("_", " ")}</p>
                <p className="font-medium">{String(result.metrics[k] ?? "—")}</p>
              </div>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}

function PagingState({ step }: { step: Step }) {
  const s = step.state as {
    reference_index: number;
    current: number;
    references: number[];
    frames: (number | null)[];
    tlb: number[];
    hit: boolean;
    fault: boolean;
    tlb_hit: boolean;
  };
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-1">
        {s.references.map((r, i) => (
          <span key={i} className={`rounded px-2 py-1 ${i === s.reference_index ? "bg-primary text-on-primary" : "bg-surface-container text-on-surface-variant"}`}>{r}</span>
        ))}
      </div>
      <p className="text-on-surface-variant">
        Page {s.current}: {s.fault ? <span className="text-error font-medium">FAULT</span> : s.tlb_hit ? <span className="text-green-600 font-medium">TLB HIT</span> : <span className="text-blue-600 font-medium">HIT</span>}
      </p>
      <div>
        <p className="font-mono text-[10px] uppercase text-on-surface-variant">Frames</p>
        <div className="mt-1 flex gap-2">
          {s.frames.map((f, i) => (
            <div key={i} className={`flex h-10 w-14 items-center justify-center rounded-lg border border-surface-container-highest text-sm ${f === s.current && (s.fault || s.hit) ? "border-foreground" : ""}`}>{f ?? "·"}</div>
          ))}
        </div>
      </div>
      <div>
        <p className="font-mono text-[10px] uppercase text-on-surface-variant">TLB</p>
        <div className="mt-1 flex gap-2">
          {s.tlb.length ? s.tlb.map((t, i) => (
            <div key={i} className="flex h-8 w-10 items-center justify-center rounded-lg border border-dashed border-surface-container-highest text-xs">{t}</div>
          )) : <span className="font-mono text-[10px] uppercase text-on-surface-variant">empty</span>}
        </div>
      </div>
    </div>
  );
}
