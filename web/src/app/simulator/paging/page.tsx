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

type Outcome = "fault" | "tlb" | "hit";

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

function outcomeFor(state: PagingState): Outcome {
  if (state.fault) return "fault";
  if (state.tlb_hit) return "tlb";
  return "hit";
}

function outcomeLabel(outcome: Outcome): string {
  return outcome === "fault" ? "FAULT" : outcome === "tlb" ? "TLB HIT" : "HIT";
}

function outcomeTone(outcome: Outcome): string {
  return outcome === "fault"
    ? "text-error"
    : outcome === "tlb"
      ? "text-tertiary-fixed-dim"
      : "text-tertiary-fixed";
}

export default function PagingPage() {
  const [refsText, setRefsText] = useState<string>(PRESETS[0].refs);
  const [frames, setFrames] = useState<number>(PRESETS[0].frames);
  const [tlbSize, setTlbSize] = useState<number>(PRESETS[0].tlb);
  const [algorithm, setAlgorithm] = useState<Algorithm>("fifo");
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
      const savedAlgorithm =
        typeof saved.algorithm === "string"
          ? saved.algorithm
          : Array.isArray(saved.algorithms)
            ? saved.algorithms.find((id: unknown) =>
                ALGORITHMS.some((candidate) => candidate.id === id),
              )
            : undefined;
      if (ALGORITHMS.some((candidate) => candidate.id === savedAlgorithm)) {
        setAlgorithm(savedAlgorithm as Algorithm);
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
        JSON.stringify({ refsText, frames, tlbSize, algorithm }),
      );
    } catch {
      // Storage can be unavailable (private mode / quota); persistence is optional.
    }
  }, [refsText, frames, tlbSize, algorithm]);

  const parsedReferences = useMemo(
    () => refsText.split(/[\s,]+/).filter(Boolean).map(Number),
    [refsText],
  );

  const pageIds = useMemo(
    () =>
      Array.from(
        new Set(
          parsedReferences.filter((page) => Number.isInteger(page) && page >= 0),
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
    return errors;
  }, [parsedReferences, frames, tlbSize]);

  const activeDescription =
    ALGORITHMS.find((item) => item.id === algorithm)?.desc ?? "";

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

      setResults([
        {
          algorithm,
          result: (await response.json()) as SimulationResult,
          frames,
          tlbSize,
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
            grid_view
          </span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
            Subsystem / Paging
          </span>
          <span className="text-on-surface-variant">·</span>
          <span className="font-mono text-xs font-semibold text-primary-fixed">
            {labelFor(algorithm)} · {frames} frame{frames === 1 ? "" : "s"}
            {tlbSize > 0 ? ` · TLB ${tlbSize}` : ""}
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
        {/* LEFT: compact parameters */}
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
                [MMU]
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
                Replacement algorithm
              </span>
              <div className="grid grid-cols-3 gap-1.5">
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
                htmlFor="page-references"
                className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant"
              >
                Page request sequence
              </label>
              <input
                id="page-references"
                className="neo-input w-full px-3 py-1.5 font-mono text-sm"
                value={refsText}
                onChange={(event) => setRefsText(event.target.value)}
                placeholder="1 2 3 4 1 2 5"
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
                  title="Generate a random page request sequence"
                  className="neo-btn flex items-center gap-1 px-2 py-1 font-mono text-[9px] uppercase text-on-surface-variant hover:text-secondary"
                >
                  <span className="material-symbols-outlined text-xs">shuffle</span>
                  Random
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
                Frames
                <input
                  type="number"
                  min={1}
                  className="neo-input w-full px-2 py-1.5 text-center font-mono"
                  value={frames}
                  onChange={(event) => setFrames(Number(event.target.value))}
                />
              </label>
              <label className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
                TLB size
                <input
                  type="number"
                  min={0}
                  className="neo-input w-full px-2 py-1.5 text-center font-mono"
                  value={tlbSize}
                  onChange={(event) => setTlbSize(Number(event.target.value))}
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-1.5 font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
              <span className="neo-inset-sm px-2 py-1.5">
                requests <strong className="text-primary">{parsedReferences.length}</strong>
              </span>
              <span className="neo-inset-sm px-2 py-1.5">
                pages <strong className="text-primary-fixed-dim">{pageIds.length}</strong>
              </span>
            </div>

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

        {/* RIGHT: live stage */}
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
              Resolving page requests…
            </section>
          )}

          {results.map((entry) => (
            <ResultBlock
              key={`${entry.algorithm}-${runId}`}
              entry={entry}
            />
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
        <span className="material-symbols-outlined text-primary-fixed-dim">grid_view</span>
        <h2 className="font-display font-semibold tracking-tight">Ready to page</h2>
      </div>

      <p className="max-w-2xl text-sm leading-relaxed text-on-surface-variant">
        Pick one replacement algorithm, feed it a sequence of requested pages, and
        step through the run. The frame table keeps every request in view while the
        current column shows the page being requested right now.
      </p>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
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
          page fault
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-sm border border-primary/50 bg-primary/15" />
          TLB / frame hit
        </span>
      </div>
    </section>
  );
}

function ResultBlock({ entry }: { entry: ResultEntry }) {
  const { algorithm, result, frames, tlbSize } = entry;

  return (
    <section
      id={`algorithm-${algorithm}`}
      className="neo-panel flex flex-col gap-3 scroll-mt-24"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="h-2 w-2 animate-ping rounded-full bg-primary" />
          <h2 className="font-display font-semibold uppercase tracking-tight">
            {labelFor(algorithm)} — Page Replacement Run
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-on-surface-variant">
          <span className="neo-inset-sm px-2 py-1">
            frames <strong className="text-primary">{frames}</strong>
          </span>
          <span className="neo-inset-sm px-2 py-1">
            requests <strong className="text-primary-fixed-dim">{result.steps.length}</strong>
          </span>
          <span className="neo-inset-sm px-2 py-1">
            {tlbSize > 0 ? `TLB ${tlbSize}` : "TLB off"}
          </span>
        </div>
      </div>

      <SimulationPlayer
        result={result}
        renderState={(step: Step) => (
          <PagingStateView step={step} steps={result.steps} tlbSize={tlbSize} />
        )}
      />

      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
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
        <div className="flex items-start gap-2 rounded-xl border border-tertiary-fixed/30 bg-tertiary-fixed/5 p-2.5 text-sm text-tertiary-fixed-dim">
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
  steps,
  tlbSize,
}: {
  step: Step;
  steps: Step[];
  tlbSize: number;
}) {
  const state = step.state as unknown as PagingState;
  const currentOutcome = outcomeFor(state);
  const currentIndex = state.reference_index ?? 0;
  const occupiedFrames = state.frames.filter((frame) => frame !== null).length;
  const pageIds = Array.from(
    new Set(
      steps.map((item) =>
        String((item.state as unknown as PagingState).current),
      ),
    ),
  ).sort((a, b) => Number(a) - Number(b));

  return (
    <div className="flex flex-col gap-3">
      {/* The only reference shown in the live readout is the page being
          requested right now. The full history lives in the frame table. */}
      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
        <span className="neo-inset-sm flex items-center gap-2 px-3 py-1.5">
          <span className="text-[9px] uppercase tracking-wider text-on-surface-variant">
            requested page
          </span>
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: pidColor(String(state.current), pageIds) }}
          />
          <strong
            className={`font-display text-lg font-semibold leading-none ${
              state.fault ? "text-error" : "text-tertiary-fixed"
            }`}
          >
            {state.current}
          </strong>
        </span>
        <span
          className={`neo-inset-sm px-2.5 py-1.5 uppercase tracking-wider ${outcomeTone(
            currentOutcome,
          )}`}
        >
          {outcomeLabel(currentOutcome)}
        </span>
        <span className="neo-inset-sm px-2.5 py-1.5 text-on-surface-variant">
          request{" "}
          <strong className="text-primary">
            {currentIndex + 1}/{steps.length}
          </strong>
        </span>
        <span className="neo-inset-sm px-2.5 py-1.5 text-on-surface-variant">
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

      <div className="grid grid-cols-1 gap-3 2xl:grid-cols-[minmax(0,1fr)_230px]">
        <PagingRunTable
          steps={steps}
          currentIndex={currentIndex}
          frameCount={state.frames.length}
        />

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
            <span>TLB</span>
            <span>{tlbSize > 0 ? `${state.tlb.length}/${tlbSize}` : "disabled"}</span>
          </div>
          <div className="neo-inset-sm flex min-h-24 flex-1 flex-col justify-center gap-2 p-2.5">
            {tlbSize === 0 ? (
              <p className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
                TLB off — every request walks the page table.
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
                    </span>
                  );
                })}
              </div>
            )}
            <p className="font-mono text-[9px] leading-relaxed text-on-surface-variant">
              A TLB hit returns the translation before the frame table is checked.
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm border border-error/50 bg-error/15" />
          fault / miss
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm border border-tertiary-fixed/70 bg-tertiary-fixed/20" />
          hit
        </span>
        <span className="ml-auto text-primary-fixed-dim">
          outlined column = current request
        </span>
      </div>
    </div>
  );
}

function PagingRunTable({
  steps,
  currentIndex,
  frameCount,
}: {
  steps: Step[];
  currentIndex: number;
  frameCount: number;
}) {
  const states = steps.map((item) => item.state as unknown as PagingState);
  const pageIds = Array.from(
    new Set(states.map((stateItem) => String(stateItem.current))),
  ).sort((a, b) => Number(a) - Number(b));

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
        <span>Frame table · page request history</span>
        <span>top = requested · bottom = result</span>
      </div>
      <div className="overflow-x-auto rounded-xl border border-surface-container-highest bg-surface-container-lowest">
        <table className="w-full border-collapse text-center font-mono text-[11px]">
          <thead>
            <tr className="text-[9px] uppercase tracking-wider text-on-surface-variant">
              <th className="sticky left-0 z-10 min-w-24 border-r border-surface-container-highest bg-surface-container-lowest px-2 py-1 text-left font-medium">
                request
              </th>
              {states.map((_, referenceIndex) => (
                <th
                  key={referenceIndex}
                  className={`min-w-10 border-l border-surface-container-highest/40 px-1 py-1 font-medium ${
                    referenceIndex === currentIndex
                      ? "bg-primary/10 text-primary"
                      : referenceIndex > currentIndex
                        ? "opacity-40"
                        : ""
                  }`}
                >
                  {referenceIndex + 1}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-surface-container-highest/70">
              <th className="sticky left-0 z-10 border-r border-surface-container-highest bg-surface-container-lowest px-2 py-1.5 text-left text-[9px] font-medium uppercase tracking-wider text-on-surface-variant">
                page
              </th>
              {states.map((stateItem, referenceIndex) => (
                <td
                  key={referenceIndex}
                  className={`border-l border-surface-container-highest/30 px-1 py-1.5 ${
                    referenceIndex === currentIndex
                      ? "bg-primary/10 shadow-[inset_0_0_0_1px_rgba(0,240,255,0.5)]"
                      : referenceIndex > currentIndex
                        ? "opacity-40"
                        : ""
                  }`}
                >
                  <span className="inline-flex items-center gap-1 font-semibold">
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{
                        backgroundColor: pidColor(String(stateItem.current), pageIds),
                      }}
                    />
                    {stateItem.current}
                  </span>
                </td>
              ))}
            </tr>

            {Array.from({ length: frameCount }).map((_, frameIndex) => (
              <tr
                key={frameIndex}
                className="border-t border-surface-container-highest/50"
              >
                <th className="sticky left-0 z-10 border-r border-surface-container-highest bg-surface-container-lowest px-2 py-1 text-left text-[9px] font-medium uppercase tracking-wider text-on-surface-variant">
                  frame {frameIndex}
                </th>
                {states.map((stateItem, referenceIndex) => {
                  const page = stateItem.frames[frameIndex];
                  const isRequested = page !== null && page === stateItem.current;
                  return (
                    <td
                      key={referenceIndex}
                      title={
                        page === null
                          ? `Frame ${frameIndex} empty`
                          : `Frame ${frameIndex}: page ${page}`
                      }
                      className={`border-l border-surface-container-highest/30 px-1 py-1 font-semibold ${
                        referenceIndex === currentIndex
                          ? "bg-primary/10"
                          : referenceIndex > currentIndex
                            ? "opacity-40"
                            : ""
                      } ${
                        isRequested
                          ? stateItem.fault
                            ? "text-error"
                            : "text-primary"
                          : page === null
                            ? "text-on-surface-variant/30"
                            : "text-on-surface"
                      }`}
                    >
                      {page ?? "—"}
                    </td>
                  );
                })}
              </tr>
            ))}

            <tr className="border-t-2 border-surface-container-highest">
              <th className="sticky left-0 z-10 border-r border-surface-container-highest bg-surface-container-lowest px-2 py-1.5 text-left text-[9px] font-medium uppercase tracking-wider text-on-surface-variant">
                result
              </th>
              {states.map((stateItem, referenceIndex) => {
                const outcome = outcomeFor(stateItem);
                return (
                  <td
                    key={referenceIndex}
                    title={outcomeLabel(outcome)}
                    className={`border-l border-surface-container-highest/30 px-1 py-1.5 text-[8px] font-bold uppercase tracking-wider ${
                      referenceIndex === currentIndex
                        ? "bg-primary/10"
                        : referenceIndex > currentIndex
                          ? "opacity-40"
                          : ""
                    } ${outcomeTone(outcome)}`}
                  >
                    {outcome === "fault" ? "MISS" : outcome === "tlb" ? "TLB" : "HIT"}
                  </td>
                );
              })}
            </tr>
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
