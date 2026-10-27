"use client";

import { useEffect, useMemo, useState } from "react";
import SimulationPlayer from "@/components/SimulationPlayer";
import { pidColor } from "@/lib/gantt";
import type { SimulationResult, Step } from "@/lib/types";

const ALGORITHMS = [
  {
    id: "fifo",
    label: "FIFO",
    desc: "Evict the page that has been resident the longest.",
  },
  {
    id: "lru",
    label: "LRU",
    desc: "Evict the page whose most recent use is oldest.",
  },
  {
    id: "optimal",
    label: "Optimal",
    desc: "Evict the page whose next use is farthest away.",
  },
] as const;

type Algorithm = (typeof ALGORITHMS)[number]["id"];

const PRESETS = [
  {
    name: "Belady's anomaly",
    refs: "1 2 3 4 1 2 5 1 2 3 4 5",
    frames: 3,
    tlb: 0,
    note: "FIFO with 3 frames faults 9 times; try 4 frames and it faults 10 times — Belady's anomaly.",
  },
  {
    name: "LRU friendly",
    refs: "1 2 3 1 2 4 5 1 2 3 4 5",
    frames: 3,
    tlb: 0,
    note: "Locality of reference — LRU keeps the recently touched pages close.",
  },
  {
    name: "TLB demo",
    refs: "1 1 2 1 2 3 1 2 3",
    frames: 3,
    tlb: 2,
    note: "Watch TLB hits skip the frame lookup entirely.",
  },
] as const;

const STORAGE_KEY = "kv:paging";

interface PagingState {
  reference_index: number;
  current: number;
  references: number[];
  frames: (number | null)[];
  tlb: number[];
  hit: boolean;
  fault: boolean;
  tlb_hit: boolean;
  faults_so_far: number;
}

interface ResultEntry {
  algorithm: Algorithm;
  result: SimulationResult;
  frames: number;
  tlbSize: number;
}

type Outcome = "fault" | "tlb" | "hit" | "pending";

function labelFor(algorithm: Algorithm): string {
  return ALGORITHMS.find((item) => item.id === algorithm)?.label ?? algorithm.toUpperCase();
}

function formatRatio(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `${(number * 100).toFixed(1)}%`;
}

function formatCount(value: unknown): string {
  return value === null || value === undefined ? "—" : String(value);
}

function statusFor(state: PagingState | undefined) {
  if (!state) {
    return {
      label: "—",
      tone: "text-on-surface-variant",
      surface: "border-surface-container-highest bg-surface-container-lowest",
    };
  }
  if (state.fault) {
    return {
      label: "PAGE FAULT",
      tone: "text-error",
      surface: "border-error/40 bg-error/10",
    };
  }
  if (state.tlb_hit) {
    return {
      label: "TLB HIT",
      tone: "text-tertiary-fixed-dim",
      surface: "border-tertiary-fixed/40 bg-tertiary-fixed/10",
    };
  }
  return {
    label: "FRAME HIT",
    tone: "text-primary",
    surface: "border-primary/40 bg-primary/10",
  };
}

function outcomeFor(state: PagingState): Outcome {
  if (state.fault) return "fault";
  if (state.tlb_hit) return "tlb";
  return "hit";
}

function outcomeClasses(outcome: Outcome, current: boolean): string {
  const base =
    "relative flex h-12 min-w-11 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg border px-2 font-mono transition-all";
  if (outcome === "fault") {
    return `${base} border-error/50 bg-error/15 text-error ${
      current ? "shadow-[0_0_0_2px_rgba(255,180,171,0.9),0_0_18px_rgba(255,180,171,0.18)]" : ""
    }`;
  }
  if (outcome === "tlb") {
    return `${base} border-tertiary-fixed/50 bg-tertiary-fixed/15 text-tertiary-fixed-dim ${
      current ? "shadow-[0_0_0_2px_rgba(104,252,191,0.85),0_0_18px_rgba(104,252,191,0.16)]" : ""
    }`;
  }
  if (outcome === "hit") {
    return `${base} border-primary/50 bg-primary/15 text-primary ${
      current ? "shadow-[0_0_0_2px_rgba(125,244,255,0.85),0_0_18px_rgba(0,240,255,0.18)]" : ""
    }`;
  }
  return `${base} border-surface-container-highest/60 bg-surface-container-lowest/40 text-on-surface-variant/50`;
}

function findBest(results: ResultEntry[]): Set<string> {
  if (results.length < 2) return new Set();
  const faultCounts = results.map((entry) => Number(entry.result.metrics.page_faults));
  if (faultCounts.some((count) => !Number.isFinite(count))) return new Set();
  const fewest = Math.min(...faultCounts);
  const best = new Set(
    results
      .filter((entry) => Number(entry.result.metrics.page_faults) === fewest)
      .map((entry) => entry.algorithm),
  );
  return best.size === results.length ? new Set() : best;
}

export default function PagingPage() {
  const [refsText, setRefsText] = useState<string>(PRESETS[0].refs);
  const [frames, setFrames] = useState<number>(PRESETS[0].frames);
  const [tlbSize, setTlbSize] = useState<number>(PRESETS[0].tlb);
  const [algorithms, setAlgorithms] = useState<Algorithm[]>(["fifo", "lru", "optimal"]);
  const [results, setResults] = useState<ResultEntry[]>([]);
  const [runId, setRunId] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect -- restore the saved editor state after mount */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (typeof saved.refsText === "string") setRefsText(saved.refsText);
      if (Number.isInteger(saved.frames) && saved.frames >= 1) setFrames(saved.frames);
      if (Number.isInteger(saved.tlbSize) && saved.tlbSize >= 0) setTlbSize(saved.tlbSize);
      if (Array.isArray(saved.algorithms)) {
        const valid = saved.algorithms.filter(
          (id: unknown): id is Algorithm =>
            typeof id === "string" && ALGORITHMS.some((algorithm) => algorithm.id === id),
        );
        setAlgorithms(Array.from(new Set(valid)));
      }
    } catch {
      // Ignore malformed local storage and keep the defaults.
    }
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ refsText, frames, tlbSize, algorithms }),
      );
    } catch {
      // Storage can be unavailable (private mode / quota); persistence is optional.
    }
  }, [refsText, frames, tlbSize, algorithms]);

  const parsedReferences = useMemo(
    () => refsText.split(/[\s,]+/).filter(Boolean).map(Number),
    [refsText],
  );

  const pageIds = useMemo(
    () =>
      Array.from(
        new Set(
          parsedReferences.filter(
            (page) => Number.isInteger(page) && page >= 0,
          ),
        ),
      )
        .sort((a, b) => a - b)
        .map(String),
    [parsedReferences],
  );

  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    if (parsedReferences.length === 0) {
      errors.push("Enter at least one page reference.");
    }
    if (parsedReferences.some((page) => !Number.isInteger(page) || page < 0)) {
      errors.push("Page references must be non-negative whole numbers.");
    }
    if (!Number.isInteger(frames) || frames < 1) {
      errors.push("Frame count must be a whole number of at least 1.");
    }
    if (!Number.isInteger(tlbSize) || tlbSize < 0) {
      errors.push("TLB size must be zero or a positive whole number.");
    }
    if (algorithms.length === 0) {
      errors.push("Select at least one replacement algorithm.");
    }
    return errors;
  }, [parsedReferences, frames, tlbSize, algorithms.length]);

  const activeLabel =
    algorithms.length === 0
      ? "No algorithms"
      : algorithms.map((algorithm) => labelFor(algorithm)).join(" · ");

  const bestAlgorithms = useMemo(() => findBest(results), [results]);

  function toggleAlgorithm(algorithm: Algorithm) {
    setAlgorithms((current) =>
      current.includes(algorithm)
        ? current.filter((candidate) => candidate !== algorithm)
        : [...current, algorithm],
    );
  }

  function applyPreset(preset: (typeof PRESETS)[number]) {
    setRefsText(preset.refs);
    setFrames(preset.frames);
    setTlbSize(preset.tlb);
    setError(null);
  }

  function randomizeWorkload() {
    const count = 12;
    const pages = Array.from({ length: count }, () => Math.floor(Math.random() * 6));
    setRefsText(pages.join(" "));
    setError(null);
  }

  async function runAll() {
    if (validationErrors.length > 0) {
      setError(validationErrors.join(" "));
      return;
    }

    setLoading(true);
    setError(null);
    setResults([]);

    const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
    const output: ResultEntry[] = [];

    try {
      for (const algorithm of algorithms) {
        const response = await fetch(`${api}/simulate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            topic: "paging",
            payload: {
              algorithm,
              reference_string: parsedReferences,
              frames,
              tlb_size: tlbSize,
            },
          }),
        });

        if (!response.ok) {
          const detail = await response.json().catch(() => ({}));
          const message = Array.isArray(detail.detail)
            ? detail.detail.join(", ")
            : detail.detail ?? response.statusText;
          throw new Error(`${labelFor(algorithm)}: ${message}`);
        }

        output.push({
          algorithm,
          result: (await response.json()) as SimulationResult,
          frames,
          tlbSize,
        });
      }

      setResults(output);
      setRunId((id) => id + 1);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex flex-col gap-6">
      {/* Context subheader */}
      <header className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 p-4 rounded-xl bg-surface-container shadow-[6px_6px_14px_rgba(0,0,0,0.65),-5px_-5px_12px_rgba(255,255,255,0.04)]">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex flex-wrap items-center gap-2 px-4 py-1.5 rounded-lg bg-surface-container-lowest shadow-[inset_3px_3px_7px_rgba(0,0,0,0.7)]">
            <span className="material-symbols-outlined text-primary-fixed-dim text-base">
              grid_view
            </span>
            <span className="font-mono text-[11px] text-on-surface-variant uppercase tracking-wider">
              Subsystem
            </span>
            <span className="text-on-surface-variant">/</span>
            <span className="font-display text-sm text-primary font-medium">Paging</span>
            <span className="material-symbols-outlined text-outline text-sm">
              chevron_right
            </span>
            <span className="font-mono text-xs text-primary-fixed font-semibold">
              {activeLabel} · {frames} frame{frames === 1 ? "" : "s"}
              {tlbSize > 0 ? ` · TLB ${tlbSize}` : ""}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={runAll}
          disabled={loading || validationErrors.length > 0}
          className="neo-btn px-6 py-2.5 font-display font-semibold text-primary disabled:opacity-40"
        >
          {loading ? "Running…" : "▶ Run Simulation"}
        </button>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* LEFT: Parameters + workload */}
        <aside className="xl:col-span-4 flex flex-col gap-6">
          <section className="neo-panel flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary-fixed-dim text-lg">
                  tune
                </span>
                <h2 className="font-display font-semibold tracking-tight">Parameters</h2>
              </div>
              <span className="px-2 py-0.5 rounded font-mono text-[11px] bg-surface-container-lowest text-on-surface-variant shadow-[inset_1px_1px_3px_rgba(0,0,0,0.7)]">
                [MMU]
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
                Replacement Algorithms (multi = compare)
              </span>
              <div className="flex flex-wrap gap-1.5">
                {ALGORITHMS.map((algorithm) => {
                  const selected = algorithms.includes(algorithm.id);
                  return (
                    <button
                      key={algorithm.id}
                      type="button"
                      onClick={() => toggleAlgorithm(algorithm.id)}
                      aria-pressed={selected}
                      title={algorithm.desc}
                      className={`px-3 py-1.5 rounded-lg font-mono text-xs transition-all ${
                        selected
                          ? "bg-surface-container-lowest text-primary shadow-[inset_2px_2px_5px_rgba(0,0,0,0.8)]"
                          : "bg-surface-container-low text-on-surface-variant neo-btn"
                      }`}
                    >
                      {algorithm.label}
                    </button>
                  );
                })}
              </div>
              <p className="font-mono text-[10px] leading-relaxed text-on-surface-variant">
                {algorithms.length === 0
                  ? "Select at least one algorithm to run."
                  : algorithms.length === 1
                    ? "Single algorithm selected."
                    : `Running ${algorithms.length} algorithms side by side for comparison.`}
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="page-references"
                className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant"
              >
                Reference String
              </label>
              <input
                id="page-references"
                className="neo-input w-full px-3 py-2 font-mono text-sm"
                value={refsText}
                onChange={(event) => setRefsText(event.target.value)}
                placeholder="1 2 3 4 1 2 5"
                spellCheck={false}
              />
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.name}
                    type="button"
                    title={preset.note}
                    onClick={() => applyPreset(preset)}
                    className="neo-btn px-3 py-1.5 font-mono text-[10px] uppercase text-on-surface-variant hover:text-primary"
                  >
                    {preset.name}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={randomizeWorkload}
                  title="Generate a random reference string"
                  className="neo-btn flex items-center gap-1.5 px-3 py-1.5 font-mono text-[10px] uppercase text-on-surface-variant hover:text-secondary"
                >
                  <span className="material-symbols-outlined text-sm">shuffle</span>
                  Randomize
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="frame-count"
                  className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant"
                >
                  Frames
                </label>
                <input
                  id="frame-count"
                  type="number"
                  min={1}
                  className="neo-input w-full px-3 py-2 font-mono"
                  value={frames}
                  onChange={(event) => setFrames(Number(event.target.value))}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="tlb-size"
                  className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant"
                >
                  TLB Size
                </label>
                <input
                  id="tlb-size"
                  type="number"
                  min={0}
                  className="neo-input w-full px-3 py-2 font-mono"
                  value={tlbSize}
                  onChange={(event) => setTlbSize(Number(event.target.value))}
                />
              </div>
            </div>

            <p className="font-mono text-[10px] leading-relaxed text-on-surface-variant">
              Frames hold resident pages. A TLB is optional: set it to 0 to disable
              translation caching, or give it capacity to watch TLB hits bypass the
              frame lookup.
            </p>

            {validationErrors.length > 0 && (
              <ul
                role="alert"
                className="flex max-h-44 flex-col gap-1 overflow-auto rounded-lg border border-error/30 bg-error/5 p-3 text-xs text-error"
              >
                {validationErrors.map((validationError) => (
                  <li key={validationError} className="flex gap-1.5">
                    <span className="material-symbols-outlined text-sm">error</span>
                    <span>{validationError}</span>
                  </li>
                ))}
              </ul>
            )}

            <button
              type="button"
              onClick={runAll}
              disabled={loading || validationErrors.length > 0}
              className="neo-btn flex items-center justify-center gap-2 px-4 py-2.5 font-display text-sm font-semibold text-primary disabled:opacity-40"
            >
              <span className="material-symbols-outlined text-base">play_arrow</span>
              {loading
                ? "Running…"
                : algorithms.length > 1
                  ? `Run ${algorithms.length} Algorithms`
                  : "Run Simulation"}
            </button>
          </section>

          <section className="neo-panel flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary-fixed-dim text-lg">
                  inventory_2
                </span>
                <h2 className="font-display font-semibold tracking-tight">Workload</h2>
              </div>
              <span className="font-mono text-[11px] text-on-surface-variant">
                {parsedReferences.length} reference{parsedReferences.length === 1 ? "" : "s"}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="neo-inset-sm p-2.5">
                <p className="font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
                  References
                </p>
                <p className="font-display text-lg font-semibold">{parsedReferences.length}</p>
              </div>
              <div className="neo-inset-sm p-2.5">
                <p className="font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
                  Unique pages
                </p>
                <p className="font-display text-lg font-semibold">{pageIds.length}</p>
              </div>
              <div className="neo-inset-sm p-2.5">
                <p className="font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
                  Frame slots
                </p>
                <p className="font-display text-lg font-semibold">{frames || "—"}</p>
              </div>
              <div className="neo-inset-sm p-2.5">
                <p className="font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
                  TLB entries
                </p>
                <p className="font-display text-lg font-semibold">
                  {tlbSize > 0 ? tlbSize : "off"}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
                  Reference preview
                </span>
                <span className="font-mono text-[10px] text-on-surface-variant">
                  {pageIds.length} distinct page{pageIds.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="neo-inset-sm flex max-h-36 flex-wrap gap-1 overflow-auto p-2.5">
                {parsedReferences.length === 0 && (
                  <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
                    No references yet
                  </span>
                )}
                {parsedReferences.map((page, pageIndex) => (
                  <span
                    key={`${page}-${pageIndex}`}
                    className="inline-flex items-center gap-1.5 rounded-md border border-surface-container-highest bg-surface-container-low px-1.5 py-0.5 font-mono text-[11px]"
                  >
                    {Number.isInteger(page) && page >= 0 && (
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: pidColor(String(page), pageIds) }}
                      />
                    )}
                    <span>{Number.isFinite(page) ? page : "?"}</span>
                  </span>
                ))}
              </div>
            </div>

            <p className="font-mono text-[10px] leading-relaxed text-on-surface-variant">
              Each reference is a virtual page number. On a fault the page loads into
              an empty frame, or the selected algorithm chooses a victim when all
              frames are full.
            </p>
          </section>
        </aside>

        {/* RIGHT: Stage */}
        <main className="xl:col-span-8 flex flex-col gap-6">
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-error/40 bg-error/10 p-4 text-sm text-error"
            >
              <span className="material-symbols-outlined text-lg">error</span>
              <p>{error}</p>
            </div>
          )}

          {results.length === 0 && !loading && <EmptyState />}

          {loading && (
            <section className="neo-panel flex items-center gap-3 py-16 justify-center text-on-surface-variant font-mono text-sm">
              <span className="w-2 h-2 rounded-full bg-primary animate-ping" />
              Resolving page references…
            </section>
          )}

          {results.length > 1 && (
            <ComparisonTable results={results} best={bestAlgorithms} />
          )}

          {results.map((entry) => (
            <ResultBlock
              key={`${entry.algorithm}-${runId}`}
              entry={entry}
              isBest={bestAlgorithms.has(entry.algorithm)}
            />
          ))}
        </main>
      </div>
    </main>
  );
}

function EmptyState() {
  return (
    <section className="neo-panel flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-primary-fixed-dim">grid_view</span>
        <h2 className="font-display font-semibold tracking-tight">Ready to page</h2>
      </div>

      <p className="max-w-2xl text-sm leading-relaxed text-on-surface-variant">
        Feed a reference string through a fixed set of physical frames. Run one
        algorithm or compare all three to watch faults, hits, evictions, and the
        optional TLB update with every reference.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {ALGORITHMS.map((algorithm) => (
          <div key={algorithm.id} className="neo-inset-sm flex flex-col gap-1 p-3">
            <span className="font-mono text-xs font-bold uppercase text-primary-fixed">
              {algorithm.label}
            </span>
            <span className="text-[11px] leading-snug text-on-surface-variant">
              {algorithm.desc}
            </span>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
        <span className="h-2.5 w-2.5 rounded-sm border border-error/50 bg-error/15" />
        <span>page fault</span>
        <span className="h-2.5 w-2.5 rounded-sm border border-tertiary-fixed/50 bg-tertiary-fixed/15" />
        <span>TLB hit</span>
        <span className="h-2.5 w-2.5 rounded-sm border border-primary/50 bg-primary/15" />
        <span>frame hit</span>
        <span className="ml-2 h-2.5 w-2.5 rounded-sm border border-surface-container-highest bg-surface-container-lowest" />
        <span>pending reference</span>
      </div>
    </section>
  );
}

function ComparisonTable({
  results,
  best,
}: {
  results: ResultEntry[];
  best: Set<string>;
}) {
  const ordered = [...results].sort(
    (a, b) =>
      Number(a.result.metrics.page_faults) - Number(b.result.metrics.page_faults),
  );

  return (
    <section className="neo-panel flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary-fixed-dim text-lg">
            leaderboard
          </span>
          <h2 className="font-display font-semibold tracking-tight">
            Replacement Comparison
          </h2>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
          fewer page faults is better
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left font-mono text-sm">
          <thead>
            <tr className="text-on-surface-variant text-[11px] uppercase">
              <th className="p-1.5 font-medium">#</th>
              <th className="p-1.5 font-medium">Algorithm</th>
              <th className="p-1.5 font-medium text-right">Faults</th>
              <th className="p-1.5 font-medium text-right">Frame hits</th>
              <th className="p-1.5 font-medium text-right">Hit ratio</th>
              <th className="p-1.5 font-medium text-right">Fault rate</th>
              <th className="p-1.5 font-medium text-right">TLB hits</th>
              <th className="p-1.5 font-medium text-right">TLB hit ratio</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((entry, index) => {
              const result = entry.result;
              const isBestEntry = best.has(entry.algorithm);

              return (
                <tr
                  key={entry.algorithm}
                  className={`border-t border-surface-container-highest ${
                    isBestEntry ? "text-primary" : "text-on-surface"
                  }`}
                >
                  <td className="p-1.5 text-on-surface-variant">{index + 1}</td>
                  <td className="p-1.5">
                    <a
                      href={`#algorithm-${entry.algorithm}`}
                      className="uppercase hover:underline"
                    >
                      {labelFor(entry.algorithm)}
                    </a>
                    {isBestEntry && (
                      <span className="ml-2 rounded bg-primary-fixed-dim/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-primary-fixed-dim">
                        best
                      </span>
                    )}
                  </td>
                  <td className="p-1.5 text-right text-error">
                    {formatCount(result.metrics.page_faults)}
                  </td>
                  <td className="p-1.5 text-right">
                    {formatCount(result.metrics.frame_hits)}
                  </td>
                  <td className="p-1.5 text-right">
                    {formatRatio(result.metrics.hit_ratio)}
                  </td>
                  <td className="p-1.5 text-right">
                    {formatRatio(result.metrics.fault_rate)}
                  </td>
                  <td className="p-1.5 text-right">
                    {formatCount(result.metrics.tlb_hits)}
                  </td>
                  <td className="p-1.5 text-right">
                    {formatRatio(result.metrics.tlb_hit_ratio)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ResultBlock({
  entry,
  isBest,
}: {
  entry: ResultEntry;
  isBest: boolean;
}) {
  const { algorithm, result, frames, tlbSize } = entry;
  const [index, setIndex] = useState(0);
  const currentStep = result.steps[index] ?? result.steps[0];
  const currentState = currentStep?.state as unknown as PagingState | undefined;
  const status = statusFor(currentState);

  const outcomes = useMemo(
    () =>
      result.steps.map((step) => {
        const state = step.state as unknown as PagingState;
        return outcomeFor(state);
      }),
    [result.steps],
  );

  return (
    <section
      id={`algorithm-${algorithm}`}
      className="neo-panel flex flex-col gap-4 scroll-mt-24"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-primary animate-ping" />
            <h2 className="font-display font-semibold tracking-tight uppercase">
              {labelFor(algorithm)} — Page Replacement Trace
            </h2>
            {isBest && (
              <span className="rounded bg-primary-fixed-dim/15 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-primary-fixed-dim">
                fewest faults
              </span>
            )}
          </div>
          <p className="font-mono text-[11px] text-on-surface-variant">
            {result.steps.length} reference{result.steps.length === 1 ? "" : "s"} ·{" "}
            {frames} frame{frames === 1 ? "" : "s"} ·{" "}
            {tlbSize > 0 ? `TLB ${tlbSize}` : "TLB disabled"}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
          <span className="neo-inset-sm px-3 py-1.5 text-on-surface-variant">
            frames <strong className="text-primary">{frames}</strong>
          </span>
          <span className="neo-inset-sm px-3 py-1.5 text-on-surface-variant">
            refs <strong className="text-primary-fixed-dim">{result.steps.length}</strong>
          </span>
          <span
            className={`neo-inset-sm px-3 py-1.5 ${status.surface} ${status.tone}`}
          >
            {status.label}
          </span>
        </div>
      </div>

      <SimulationPlayer
        result={result}
        onIndex={setIndex}
        renderState={(step: Step) => (
          <PagingStateView step={step} outcomes={outcomes} tlbSize={tlbSize} />
        )}
      />

      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
          Final run totals
        </span>
        <span className="font-mono text-[10px] text-on-surface-variant">
          after all references
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <Metric
          label="Page faults"
          value={formatCount(result.metrics.page_faults)}
          accent
        />
        <Metric label="Frame hits" value={formatCount(result.metrics.frame_hits)} />
        <Metric label="Hit ratio" value={formatRatio(result.metrics.hit_ratio)} />
        <Metric label="Fault rate" value={formatRatio(result.metrics.fault_rate)} />
        <Metric label="TLB hits" value={formatCount(result.metrics.tlb_hits)} />
        <Metric
          label="TLB hit ratio"
          value={formatRatio(result.metrics.tlb_hit_ratio)}
        />
      </div>

      {result.warnings.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-tertiary-fixed/30 bg-tertiary-fixed/5 p-3 text-sm text-tertiary-fixed-dim">
          <span className="material-symbols-outlined text-lg">warning</span>
          <div className="flex flex-col gap-1">
            {result.warnings.map((warning, warningIndex) => (
              <p key={`${warning}-${warningIndex}`}>{warning}</p>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function PagingStateView({
  step,
  outcomes,
  tlbSize,
}: {
  step: Step;
  outcomes: Outcome[];
  tlbSize: number;
}) {
  const state = step.state as unknown as PagingState;
  const references = state.references ?? [];
  const index = state.reference_index ?? 0;
  const currentOutcome = state.fault
    ? "fault"
    : state.tlb_hit
      ? "tlb"
      : "hit";
  const occupiedFrames = state.frames.filter((frame) => frame !== null).length;
  const pageIds = Array.from(new Set(references.map(String))).sort(
    (a, b) => Number(a) - Number(b),
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Live readout */}
      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
        <span className="neo-inset-sm px-2.5 py-1 text-on-surface-variant">
          REFERENCE{" "}
          <strong className="text-primary">
            {index + 1}/{references.length}
          </strong>
        </span>
        <span className="neo-inset-sm px-2.5 py-1 text-on-surface-variant">
          PAGE <strong className="text-primary-fixed">{state.current}</strong>
        </span>
        <span
          className={`neo-inset-sm px-2.5 py-1 uppercase ${
            currentOutcome === "fault"
              ? "text-error"
              : currentOutcome === "tlb"
                ? "text-tertiary-fixed-dim"
                : "text-primary"
          }`}
        >
          {currentOutcome === "fault"
            ? "page fault"
            : currentOutcome === "tlb"
              ? "TLB hit"
              : "frame hit"}
        </span>
        <span className="text-on-surface-variant">
          faults so far <strong className="text-error">{state.faults_so_far}</strong>
        </span>
        <span className="ml-auto text-on-surface-variant">
          frames{" "}
          <strong className="text-on-surface">
            {occupiedFrames}/{state.frames.length}
          </strong>{" "}
          occupied
        </span>
      </div>

      {/* Reference timeline */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
          <span>Reference string</span>
          <span>
            ref <strong className="text-primary">{index + 1}</strong> /{" "}
            {references.length}
          </span>
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {references.map((page, referenceIndex) => {
            const isCurrent = referenceIndex === index;
            const isPast = referenceIndex < index;
            const outcome: Outcome = isPast
              ? outcomes[referenceIndex] ?? "hit"
              : isCurrent
                ? currentOutcome
                : "pending";
            return (
              <div
                key={`${page}-${referenceIndex}`}
                title={`Reference ${referenceIndex + 1}: page ${page}${
                  outcome === "pending" ? "" : ` — ${outcome === "tlb" ? "TLB hit" : outcome === "fault" ? "page fault" : "frame hit"}`
                }`}
                className={outcomeClasses(outcome, isCurrent)}
              >
                <span className="flex items-center gap-1 text-sm font-semibold">
                  {Number.isInteger(page) && page >= 0 && (
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: pidColor(String(page), pageIds) }}
                    />
                  )}
                  {page}
                </span>
                <span className="text-[8px] uppercase tracking-wider opacity-80">
                  {isCurrent
                    ? "now"
                    : outcome === "fault"
                      ? "fault"
                      : outcome === "tlb"
                        ? "TLB"
                        : outcome === "hit"
                          ? "hit"
                          : "—"}
                </span>
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-3 font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm border border-error/50 bg-error/15" />
            fault
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm border border-tertiary-fixed/50 bg-tertiary-fixed/15" />
            TLB hit
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm border border-primary/50 bg-primary/15" />
            frame hit
          </span>
          <span className="ml-auto text-primary-fixed-dim">
            outline = current reference
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Frame table */}
        <div className="lg:col-span-2 flex flex-col gap-2">
          <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
            <span>Frame table</span>
            <span>
              {occupiedFrames} / {state.frames.length} occupied
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {state.frames.map((page, frameIndex) => {
              const isCurrent = page !== null && page === state.current;
              const isOccupied = page !== null;
              return (
                <div
                  key={frameIndex}
                  title={`Frame ${frameIndex}: ${
                    isOccupied ? `page ${page}` : "empty"
                  }`}
                  className={`relative flex min-h-20 flex-col items-center justify-center gap-1 rounded-xl border p-2.5 transition-all ${
                    isCurrent
                      ? currentOutcome === "fault"
                        ? "border-error/60 bg-error/10 shadow-[0_0_18px_rgba(255,180,171,0.16)]"
                        : "border-primary-fixed-dim/60 bg-primary-fixed-dim/10 shadow-[0_0_18px_rgba(0,240,255,0.16)]"
                      : isOccupied
                        ? "border-surface-container-highest bg-surface-container-lowest"
                        : "border-dashed border-surface-container-highest bg-transparent"
                  }`}
                >
                  <span className="font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
                    Frame {frameIndex}
                  </span>
                  <span
                    className="font-display text-2xl font-semibold leading-none"
                    style={
                      isOccupied
                        ? { color: pidColor(String(page), pageIds) }
                        : { color: "rgba(185,202,203,0.3)" }
                    }
                  >
                    {isOccupied ? page : "—"}
                  </span>
                  <span
                    className={`font-mono text-[8px] uppercase tracking-wider ${
                      isCurrent
                        ? currentOutcome === "fault"
                          ? "text-error"
                          : "text-primary-fixed-dim"
                        : "text-on-surface-variant/70"
                    }`}
                  >
                    {isOccupied ? (isCurrent ? "current" : "resident") : "empty"}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-container-lowest shadow-[inset_1px_1px_3px_rgba(0,0,0,0.8)]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-primary-fixed-dim to-tertiary-fixed transition-all duration-300"
                style={{
                  width: `${
                    state.frames.length > 0
                      ? (occupiedFrames / state.frames.length) * 100
                      : 0
                  }%`,
                }}
              />
            </div>
            <span className="font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
              {state.frames.length - occupiedFrames} free
            </span>
          </div>
        </div>

        {/* TLB */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
            <span>TLB</span>
            <span>
              {tlbSize > 0 ? `${state.tlb.length} / ${tlbSize}` : "disabled"}
            </span>
          </div>
          <div className="neo-inset-sm flex min-h-24 flex-col justify-center gap-2 p-3">
            {tlbSize === 0 ? (
              <p className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
                TLB off — every reference walks the page table.
              </p>
            ) : state.tlb.length === 0 ? (
              <p className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
                empty
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {state.tlb.map((page, tlbIndex) => {
                  const isCurrent = page === state.current;
                  return (
                    <span
                      key={`${page}-${tlbIndex}`}
                      title={`Page ${page}${
                        isCurrent ? " (current reference)" : ""
                      }`}
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 font-mono text-xs ${
                        isCurrent
                          ? "border-primary-fixed-dim/60 bg-primary-fixed-dim/10 text-primary-fixed-dim"
                          : "border-surface-container-highest bg-surface-container-high text-on-surface"
                      }`}
                    >
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: pidColor(String(page), pageIds) }}
                      />
                      {page}
                      {isCurrent && (
                        <span className="text-[8px] uppercase tracking-wider">
                          live
                        </span>
                      )}
                    </span>
                  );
                })}
              </div>
            )}
            <p className="font-mono text-[9px] leading-relaxed text-on-surface-variant">
              The TLB is checked before the page table. A TLB hit returns the
              translation without touching the frames.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="neo-inset-sm p-3">
      <p className="font-mono text-[10px] uppercase text-on-surface-variant">
        {label}
      </p>
      <p className={`font-display font-semibold ${accent ? "text-primary" : ""}`}>
        {value}
      </p>
    </div>
  );
}
