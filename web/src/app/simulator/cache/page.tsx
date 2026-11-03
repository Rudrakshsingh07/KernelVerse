"use client";

import { useEffect, useMemo, useState } from "react";
import SimulationPlayer from "@/components/SimulationPlayer";
import { pidColor } from "@/lib/gantt";
import type { SimulationResult, Step } from "@/lib/types";

const ALGORITHMS = [
  { id: "fifo", label: "FIFO", desc: "Replace the block that entered the set first." },
  { id: "lru", label: "LRU", desc: "Replace the block in the set used longest ago." },
  { id: "mru", label: "MRU", desc: "Replace the block in the set used most recently." },
] as const;

type Algorithm = (typeof ALGORITHMS)[number]["id"];

const PRESETS = [
  {
    name: "Direct mapped",
    refs: "0 1 2 3 0 4 1 5 0 1 2 3",
    lines: 4,
    ways: 1,
    algorithm: "lru" as Algorithm,
    note: "One line per set — each block maps to exactly one line.",
  },
  {
    name: "2 lines/set LRU",
    refs: "0 1 2 3 0 4 1 5 0 1 2 3",
    lines: 4,
    ways: 2,
    algorithm: "lru" as Algorithm,
    note: "Two lines per set; conflicts are resolved with LRU replacement.",
  },
  {
    name: "Conflict thrash",
    refs: "0 4 0 4 0 4 0 4",
    lines: 4,
    ways: 1,
    algorithm: "fifo" as Algorithm,
    note: "Two blocks fight over the same direct-mapped line — every access misses.",
  },
] as const;

const STORAGE_KEY = "kv:cache";

interface CacheState {
  reference_index: number;
  current: number;
  references: number[];
  lines: (number | null)[];
  cache_lines: number;
  associativity: number;
  set_count: number;
  set_index: number;
  algorithm: string;
  hit: boolean;
  miss: boolean;
  evicted: number | null;
  hits_so_far: number;
  misses_so_far: number;
}

interface ResultEntry {
  algorithm: Algorithm;
  result: SimulationResult;
  lines: number;
  ways: number;
}

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

export default function CachePage() {
  const [refsText, setRefsText] = useState<string>(PRESETS[1].refs);
  const [lines, setLines] = useState<number>(PRESETS[1].lines);
  const [ways, setWays] = useState<number>(PRESETS[1].ways);
  const [algorithm, setAlgorithm] = useState<Algorithm>(PRESETS[1].algorithm);
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
      if (Number.isInteger(saved.lines) && saved.lines >= 1) setLines(saved.lines);
      if (Number.isInteger(saved.ways) && saved.ways >= 1) setWays(saved.ways);
      if (ALGORITHMS.some((candidate) => candidate.id === saved.algorithm)) {
        setAlgorithm(saved.algorithm as Algorithm);
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
        JSON.stringify({ refsText, lines, ways, algorithm }),
      );
    } catch {
      // Storage can be unavailable (private mode / quota); persistence is optional.
    }
  }, [refsText, lines, ways, algorithm]);

  const parsedReferences = useMemo(
    () => refsText.split(/[\s,]+/).filter(Boolean).map(Number),
    [refsText],
  );

  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    if (parsedReferences.length === 0) {
      errors.push("Enter at least one block reference.");
    }
    if (parsedReferences.some((block) => !Number.isInteger(block) || block < 0)) {
      errors.push("Block references must be non-negative whole numbers.");
    }
    if (!Number.isInteger(lines) || lines < 1) {
      errors.push("Cache lines must be a whole number of at least 1.");
    }
    if (!Number.isInteger(ways) || ways < 1) {
      errors.push("Lines per set must be a whole number of at least 1.");
    }
    if (Number.isInteger(lines) && Number.isInteger(ways) && ways >= 1) {
      if (ways > lines) {
        errors.push("Lines per set cannot exceed the number of cache lines.");
      } else if (lines % ways !== 0) {
        errors.push("Cache lines must be divisible by lines per set.");
      }
    }
    return errors;
  }, [parsedReferences, lines, ways]);

  const activeDescription =
    ALGORITHMS.find((item) => item.id === algorithm)?.desc ?? "";

  function applyPreset(preset: (typeof PRESETS)[number]) {
    setRefsText(preset.refs);
    setLines(preset.lines);
    setWays(preset.ways);
    setAlgorithm(preset.algorithm);
    setError(null);
  }

  function randomizeWorkload() {
    const count = 12;
    const blocks = Array.from({ length: count }, () => Math.floor(Math.random() * 8));
    setRefsText(blocks.join(" "));
    setError(null);
  }

  async function runSimulation() {
    if (validationErrors.length > 0) {
      setError(validationErrors.join(" "));
      return;
    }

    setLoading(true);
    setError(null);
    setResults([]);
    const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

    try {
      const response = await fetch(`${api}/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: "cache",
          payload: {
            algorithm,
            references: parsedReferences,
            cache_lines: lines,
            associativity: ways,
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

      setResults([
        {
          algorithm,
          result: (await response.json()) as SimulationResult,
          lines,
          ways,
        },
      ]);
      setRunId((id) => id + 1);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex flex-col gap-4">
      <header className="flex flex-col gap-3 rounded-xl bg-surface-container p-3 shadow-[6px_6px_14px_rgba(0,0,0,0.65),-5px_-5px_12px_rgba(255,255,255,0.04)] xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-container-lowest px-3 py-1.5 shadow-[inset_3px_3px_7px_rgba(0,0,0,0.7)]">
          <span className="material-symbols-outlined text-base text-primary-fixed-dim">
            memory
          </span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
            Subsystem / Cache
          </span>
          <span className="text-on-surface-variant">·</span>
          <span className="font-mono text-xs font-semibold text-primary-fixed">
            {labelFor(algorithm)} · {lines} lines · {ways} lines/set
          </span>
        </div>
        <button
          type="button"
          onClick={runSimulation}
          disabled={loading || validationErrors.length > 0}
          className="neo-btn px-5 py-2 font-display font-semibold text-primary disabled:opacity-40"
        >
          {loading ? "Running…" : "▶ Run Simulation"}
        </button>
      </header>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-12">
        <aside className="xl:col-span-3">
          <section className="neo-panel flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-lg text-primary-fixed-dim">
                  tune
                </span>
                <h2 className="font-display font-semibold tracking-tight">Parameters</h2>
              </div>
              <span className="rounded bg-surface-container-lowest px-2 py-0.5 font-mono text-[10px] text-on-surface-variant shadow-[inset_1px_1px_3px_rgba(0,0,0,0.7)]">
                [CACHE]
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
                Replacement algorithm
              </span>
              <div className="grid grid-cols-2 gap-1.5">
                {ALGORITHMS.map((item) => {
                  const selected = item.id === algorithm;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setAlgorithm(item.id)}
                      aria-pressed={selected}
                      title={item.desc}
                      className={`rounded-lg px-2 py-1.5 font-mono text-xs transition-all ${
                        selected
                          ? "bg-surface-container-lowest text-primary shadow-[inset_2px_2px_5px_rgba(0,0,0,0.8)]"
                          : "neo-btn bg-surface-container-low text-on-surface-variant"
                      }`}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
              <p className="font-mono text-[9px] leading-relaxed text-on-surface-variant">
                {activeDescription}
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="cache-references"
                className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant"
              >
                Block request sequence
              </label>
              <input
                id="cache-references"
                className="neo-input w-full px-3 py-1.5 font-mono text-sm"
                value={refsText}
                onChange={(event) => setRefsText(event.target.value)}
                placeholder="0 1 2 3 0 1"
                spellCheck={false}
              />
              <div className="flex flex-wrap gap-1">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.name}
                    type="button"
                    title={preset.note}
                    onClick={() => applyPreset(preset)}
                    className="neo-btn px-2 py-1 font-mono text-[9px] uppercase text-on-surface-variant hover:text-primary"
                  >
                    {preset.name}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={randomizeWorkload}
                  title="Generate a random block request sequence"
                  className="neo-btn flex items-center gap-1 px-2 py-1 font-mono text-[9px] uppercase text-on-surface-variant hover:text-secondary"
                >
                  <span className="material-symbols-outlined text-xs">shuffle</span>
                  Random
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
                Cache lines
                <input
                  type="number"
                  min={1}
                  className="neo-input w-full px-2 py-1.5 text-center font-mono"
                  value={lines}
                  onChange={(event) => setLines(Number(event.target.value))}
                />
              </label>
              <label className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
                Lines per set
                <input
                  type="number"
                  min={1}
                  className="neo-input w-full px-2 py-1.5 text-center font-mono"
                  value={ways}
                  onChange={(event) => setWays(Number(event.target.value))}
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-1.5 font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
              <span className="neo-inset-sm px-2 py-1.5">
                requests <strong className="text-primary">{parsedReferences.length}</strong>
              </span>
              <span className="neo-inset-sm px-2 py-1.5">
                sets{" "}
                <strong className="text-primary-fixed-dim">
                  {Number.isInteger(lines) && Number.isInteger(ways) && ways > 0
                    ? Math.floor(lines / ways)
                    : "—"}
                </strong>
              </span>
            </div>

            <p className="font-mono text-[9px] leading-relaxed text-on-surface-variant">
              Block → set mapping is <span className="text-primary-fixed-dim">block % sets</span>.
              1 line per set is direct mapped; all lines in one set is fully associative.
            </p>

            {validationErrors.length > 0 && (
              <ul
                role="alert"
                className="flex max-h-28 flex-col gap-1 overflow-auto rounded-lg border border-error/30 bg-error/5 p-2 text-[10px] text-error"
              >
                {validationErrors.map((validationError) => (
                  <li key={validationError} className="flex gap-1">
                    <span className="material-symbols-outlined text-xs">error</span>
                    <span>{validationError}</span>
                  </li>
                ))}
              </ul>
            )}

            <button
              type="button"
              onClick={runSimulation}
              disabled={loading || validationErrors.length > 0}
              className="neo-btn flex items-center justify-center gap-1.5 px-3 py-2 font-display text-sm font-semibold text-primary disabled:opacity-40"
            >
              <span className="material-symbols-outlined text-base">play_arrow</span>
              {loading ? "Running…" : "Run Simulation"}
            </button>
          </section>
        </aside>

        <main className="flex flex-col gap-4 xl:col-span-9">
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-error/40 bg-error/10 p-3 text-sm text-error"
            >
              <span className="material-symbols-outlined text-lg">error</span>
              <p>{error}</p>
            </div>
          )}

          {results.length === 0 && !loading && <EmptyState />}

          {loading && (
            <section className="neo-panel flex items-center justify-center gap-3 py-16 font-mono text-sm text-on-surface-variant">
              <span className="h-2 w-2 animate-ping rounded-full bg-primary" />
              Mapping blocks into cache lines…
            </section>
          )}

          {results.map((entry) => (
            <ResultBlock key={`${entry.algorithm}-${runId}`} entry={entry} />
          ))}
        </main>
      </div>
    </main>
  );
}

function EmptyState() {
  return (
    <section className="neo-panel flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-primary-fixed-dim">memory</span>
        <h2 className="font-display font-semibold tracking-tight">Ready to cache</h2>
      </div>

      <p className="max-w-2xl text-sm leading-relaxed text-on-surface-variant">
        Feed a sequence of memory block requests into a set-associative cache.
        The run table is vertical: each row is one request, followed by every
        cache line and the final hit/miss result.
      </p>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {ALGORITHMS.map((item) => (
          <div key={item.id} className="neo-inset-sm flex flex-col gap-1 p-3">
            <span className="font-mono text-xs font-bold uppercase text-primary-fixed">
              {item.label}
            </span>
            <span className="text-[11px] leading-snug text-on-surface-variant">
              {item.desc}
            </span>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-sm border border-error/50 bg-error/15" />
          miss
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-sm border border-primary/50 bg-primary/15" />
          hit
        </span>
        <span className="ml-2 h-2.5 w-2.5 rounded-sm border border-surface-container-highest bg-surface-container-lowest" />
        <span>empty line</span>
      </div>
    </section>
  );
}

function ResultBlock({ entry }: { entry: ResultEntry }) {
  const { algorithm, result, lines, ways } = entry;

  return (
    <section className="neo-panel flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="h-2 w-2 animate-ping rounded-full bg-primary" />
          <h2 className="font-display font-semibold uppercase tracking-tight">
            {labelFor(algorithm)} — Cache Run
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-on-surface-variant">
          <span className="neo-inset-sm px-2 py-1">
            lines <strong className="text-primary">{lines}</strong>
          </span>
          <span className="neo-inset-sm px-2 py-1">
            lines/set <strong className="text-primary-fixed-dim">{ways}</strong>
          </span>
          <span className="neo-inset-sm px-2 py-1">
            requests <strong className="text-primary-fixed-dim">{result.steps.length}</strong>
          </span>
        </div>
      </div>

      <SimulationPlayer
        result={result}
        renderState={(step: Step) => (
          <CacheStateView step={step} steps={result.steps} />
        )}
      />

      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
        <Metric label="Hits" value={formatCount(result.metrics.hits)} accent />
        <Metric label="Misses" value={formatCount(result.metrics.misses)} />
        <Metric label="Hit ratio" value={formatRatio(result.metrics.hit_ratio)} />
        <Metric label="Miss ratio" value={formatRatio(result.metrics.miss_ratio)} />
        <Metric label="Evictions" value={formatCount(result.metrics.evictions)} />
        <Metric label="Sets" value={formatCount(result.metrics.sets)} />
      </div>
    </section>
  );
}

function CacheStateView({ step, steps }: { step: Step; steps: Step[] }) {
  const state = step.state as unknown as CacheState;
  const currentIndex = state.reference_index ?? 0;
  const blockIds = Array.from(new Set((state.references ?? []).map(String))).sort(
    (a, b) => Number(a) - Number(b),
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
        <span className="neo-inset-sm flex items-center gap-2 px-3 py-1.5">
          <span className="text-[9px] uppercase tracking-wider text-on-surface-variant">
            requested block
          </span>
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: pidColor(String(state.current), blockIds) }}
          />
          <strong className="font-display text-lg font-semibold leading-none text-primary">
            {state.current}
          </strong>
        </span>
        <span className="neo-inset-sm px-2.5 py-1.5 text-on-surface-variant">
          set <strong className="text-primary-fixed-dim">{state.set_index}</strong>
        </span>
        <span
          className={`neo-inset-sm px-2.5 py-1.5 uppercase tracking-wider ${
            state.hit ? "text-primary" : "text-error"
          }`}
        >
          {state.hit ? "HIT" : state.evicted !== null ? `MISS · EVICT ${state.evicted}` : "MISS"}
        </span>
        <span className="neo-inset-sm px-2.5 py-1.5 text-on-surface-variant">
          request{" "}
          <strong className="text-primary">
            {currentIndex + 1}/{steps.length}
          </strong>
        </span>
        <span className="ml-auto text-on-surface-variant">
          hits <strong className="text-primary">{state.hits_so_far}</strong> · misses{" "}
          <strong className="text-error">{state.misses_so_far}</strong>
        </span>
      </div>

      <CacheRunTable steps={steps} currentIndex={currentIndex} />

      <div className="flex flex-wrap items-center gap-3 font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm border border-error/50 bg-error/15" />
          miss
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm border border-primary/50 bg-primary/15" />
          hit
        </span>
        <span className="ml-auto text-primary-fixed-dim">
          highlighted row = current request
        </span>
      </div>
    </div>
  );
}

function CacheRunTable({
  steps,
  currentIndex,
}: {
  steps: Step[];
  currentIndex: number;
}) {
  const states = steps.map((item) => item.state as unknown as CacheState);
  const lineCount = states[0]?.cache_lines ?? 0;
  const ways = states[0]?.associativity ?? 1;
  const blockIds = Array.from(
    new Set((states[0]?.references ?? []).map(String)),
  ).sort((a, b) => Number(a) - Number(b));

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
        <span>Cache lines · one row per request</span>
        <span>vertical request history</span>
      </div>
      <div className="overflow-x-auto rounded-xl border border-surface-container-highest bg-surface-container-lowest">
        <table className="w-full border-collapse text-center font-mono text-[11px]">
          <thead>
            <tr className="text-[9px] uppercase tracking-wider text-on-surface-variant">
              <th className="sticky left-0 z-10 min-w-10 border-r border-surface-container-highest bg-surface-container-lowest px-2 py-1 text-left font-medium">
                #
              </th>
              <th className="min-w-14 px-2 py-1 text-left font-medium">block</th>
              <th className="min-w-10 px-2 py-1 font-medium">set</th>
              {Array.from({ length: lineCount }).map((_, lineIndex) => (
                <th
                  key={lineIndex}
                  className="min-w-11 border-l border-surface-container-highest/40 px-1 py-1 font-medium"
                >
                  S{Math.floor(lineIndex / ways)}L{lineIndex % ways}
                </th>
              ))}
              <th className="min-w-14 border-l border-surface-container-highest px-2 py-1 font-medium">
                result
              </th>
            </tr>
          </thead>
          <tbody>
            {states.map((stateItem, rowIndex) => {
              const isCurrent = rowIndex === currentIndex;
              const isFuture = rowIndex > currentIndex;
              return (
                <tr
                  key={rowIndex}
                  className={`border-t border-surface-container-highest/50 ${
                    isCurrent ? "bg-primary/10" : isFuture ? "opacity-40" : ""
                  }`}
                >
                  <th
                    className={`sticky left-0 z-10 border-r border-surface-container-highest bg-surface-container-lowest px-2 py-1 text-left text-[9px] font-medium text-on-surface-variant`}
                  >
                    {rowIndex + 1}
                  </th>
                  <td className="px-2 py-1 text-left font-semibold">
                    <span className="inline-flex items-center gap-1">
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{
                          backgroundColor: pidColor(String(stateItem.current), blockIds),
                        }}
                      />
                      {stateItem.current}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-on-surface-variant">{stateItem.set_index}</td>
                  {stateItem.lines.map((block, lineIndex) => {
                    const inSet =
                      Math.floor(lineIndex / ways) === stateItem.set_index;
                    return (
                      <td
                        key={lineIndex}
                        title={
                          block === null
                            ? `Line ${lineIndex} empty`
                            : `Line ${lineIndex}: block ${block}`
                        }
                        className={`border-l border-surface-container-highest/30 px-1 py-1 font-semibold ${
                          inSet ? "" : "bg-surface-container/40"
                        } ${
                          block === null
                            ? "text-on-surface-variant/30"
                            : block === stateItem.current
                              ? stateItem.hit
                                ? "text-primary"
                                : "text-error"
                              : "text-on-surface"
                        }`}
                      >
                        {block ?? "—"}
                      </td>
                    );
                  })}
                  <td
                    className={`border-l border-surface-container-highest px-2 py-1 text-[8px] font-bold uppercase tracking-wider ${
                      stateItem.hit ? "text-primary" : "text-error"
                    }`}
                  >
                    {stateItem.hit ? "HIT" : "MISS"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
    <div className="neo-inset-sm p-2">
      <p className="font-mono text-[9px] uppercase text-on-surface-variant">{label}</p>
      <p className={`font-display text-sm font-semibold ${accent ? "text-primary" : ""}`}>
        {value}
      </p>
    </div>
  );
}
