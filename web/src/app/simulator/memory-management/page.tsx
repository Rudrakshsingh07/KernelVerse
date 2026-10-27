"use client";

import { useEffect, useMemo, useState } from "react";
import SimulationPlayer from "@/components/SimulationPlayer";
import type { SimulationResult, Step } from "@/lib/types";
import { pidColor } from "@/lib/gantt";

const MODES = [
  {
    id: "contiguous",
    label: "Contiguous",
    desc: "One contiguous partition per process.",
  },
  {
    id: "segmentation",
    label: "Segmentation",
    desc: "Each named segment is placed independently.",
  },
] as const;

const STRATEGIES = [
  {
    id: "first-fit",
    label: "First Fit",
    desc: "Take the first hole large enough, scanning by address.",
  },
  {
    id: "best-fit",
    label: "Best Fit",
    desc: "Take the smallest hole that fits, minimizing leftover space.",
  },
  {
    id: "worst-fit",
    label: "Worst Fit",
    desc: "Take the largest hole, leaving the biggest remainder.",
  },
] as const;

type Mode = (typeof MODES)[number]["id"];

interface Hole {
  start: number;
  size: number;
}

interface Proc {
  id: string;
  size: number;
  segmentsText: string;
}

interface MemoryBlock {
  start: number;
  size: number;
  type: string;
  owner: string | null;
  label: string;
}

interface SegmentRecord {
  process: string;
  segment: string;
  size: number;
  base: number | null;
  limit?: number;
  status: string;
}

interface MemoryState {
  mode: string;
  blocks: MemoryBlock[];
  segment_table: SegmentRecord[];
  memory_size: number;
}

interface ResultEntry {
  strategy: string;
  result: SimulationResult;
}

interface Preset {
  name: string;
  mode: Mode;
  memory_size: number;
  holes: Hole[];
  procs: Proc[];
  note: string;
}

const PRESETS: Preset[] = [
  {
    name: "Fragmentation classic",
    mode: "contiguous",
    memory_size: 640,
    holes: [
      { start: 0, size: 200 },
      { start: 250, size: 150 },
      { start: 450, size: 190 },
    ],
    procs: [
      { id: "P1", size: 120, segmentsText: "" },
      { id: "P2", size: 180, segmentsText: "" },
      { id: "P3", size: 90, segmentsText: "" },
    ],
    note: "Holes already exist; watch the map as processes are placed and external fragmentation forms across all three strategies.",
  },
  {
    name: "Failed allocation",
    mode: "contiguous",
    memory_size: 300,
    holes: [
      { start: 0, size: 100 },
      { start: 150, size: 100 },
    ],
    procs: [
      { id: "P1", size: 60, segmentsText: "" },
      { id: "P2", size: 150, segmentsText: "" },
    ],
    note: "P2 needs 150 units. There are 200 free units, but no single hole fits — a classic external-fragmentation failure.",
  },
  {
    name: "Segmentation basic",
    mode: "segmentation",
    memory_size: 512,
    holes: [],
    procs: [
      { id: "P1", size: 200, segmentsText: "code:100,data:60,stack:40" },
      { id: "P2", size: 110, segmentsText: "code:80,stack:30" },
    ],
    note: "Each segment is placed independently. The segment table records the base and limit of every placement.",
  },
];

const STORAGE_KEY = "kv:memory-management";

function parseSegments(text: string): { name: string; size: number }[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf(":");
      if (separator === -1) return { name: part.trim(), size: Number.NaN };
      return {
        name: part.slice(0, separator).trim(),
        size: Number(part.slice(separator + 1).trim()),
      };
    });
}

function labelForMode(mode: string): string {
  return MODES.find((item) => item.id === mode)?.label ?? mode;
}

function labelForStrategy(strategy: string): string {
  return STRATEGIES.find((item) => item.id === strategy)?.label ?? strategy.toUpperCase();
}

function formatPercent(value: unknown): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `${Math.round(number * 1000) / 10}%`;
}

function formatUnits(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) ? `${number} u` : "—";
}

function buildLayout(state: MemoryState): MemoryBlock[] {
  const total = Number(state.memory_size);
  if (!Number.isFinite(total) || total <= 0) return [];

  const sorted = [...(state.blocks ?? [])].sort((a, b) => a.start - b.start);
  const layout: MemoryBlock[] = [];
  let cursor = 0;

  for (const block of sorted) {
    const start = Math.max(0, block.start);
    const end = Math.min(total, block.start + block.size);
    if (end <= start || start >= total) continue;

    if (start > cursor) {
      layout.push({
        start: cursor,
        size: start - cursor,
        type: "reserved",
        owner: null,
        label: "reserved",
      });
    }

    if (start < cursor) {
      if (end > cursor) {
        layout.push({ ...block, start: cursor, size: end - cursor });
      }
    } else {
      layout.push({ ...block, size: end - start });
    }

    cursor = Math.max(cursor, end);
  }

  if (cursor < total) {
    layout.push({
      start: cursor,
      size: total - cursor,
      type: "reserved",
      owner: null,
      label: "reserved",
    });
  }

  return layout;
}

function resultStatus(result: SimulationResult) {
  const failed = Array.isArray(result.metrics.failed_allocations)
    ? result.metrics.failed_allocations
    : [];
  const fragmentation = Number(result.metrics.external_fragmentation);
  return {
    failedCount: failed.length,
    fragmentation: Number.isFinite(fragmentation) ? fragmentation : 1,
  };
}

function findBestStrategies(results: ResultEntry[]): Set<string> {
  const best = new Set<string>();
  if (results.length === 0) return best;

  const stats = results.map((entry) => ({
    strategy: entry.strategy,
    ...resultStatus(entry.result),
  }));
  const fewestFailures = Math.min(...stats.map((entry) => entry.failedCount));
  const candidates = stats.filter((entry) => entry.failedCount === fewestFailures);
  const lowestFragmentation = Math.min(
    ...candidates.map((entry) => entry.fragmentation),
  );

  for (const entry of candidates) {
    if (entry.fragmentation === lowestFragmentation) best.add(entry.strategy);
  }

  // If every strategy produced the same outcome, a "best" badge is meaningless.
  if (results.length > 1 && best.size === results.length) return new Set();
  return best;
}

function nextProcessId(rows: Proc[]): string {
  const used = new Set(rows.map((row) => row.id.trim()));
  let index = rows.length + 1;
  while (used.has(`P${index}`)) index += 1;
  return `P${index}`;
}

export default function MemoryManagementPage() {
  const [mode, setMode] = useState<Mode>("contiguous");
  const [strategies, setStrategies] = useState<string[]>(
    STRATEGIES.map((strategy) => strategy.id),
  );
  const [memorySize, setMemorySize] = useState(PRESETS[0].memory_size);
  const [holes, setHoles] = useState<Hole[]>(PRESETS[0].holes);
  const [procs, setProcs] = useState<Proc[]>(PRESETS[0].procs);
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
      if (saved.mode === "contiguous" || saved.mode === "segmentation") {
        setMode(saved.mode);
      }
      if (Array.isArray(saved.strategies)) {
        const known = saved.strategies.filter((id: unknown): id is string =>
          STRATEGIES.some((strategy) => strategy.id === id),
        );
        if (known.length > 0) setStrategies(known);
      }
      if (Number.isInteger(saved.memorySize) && saved.memorySize > 0) {
        setMemorySize(saved.memorySize);
      }
      if (Array.isArray(saved.holes)) {
        setHoles(
          saved.holes
            .filter(
              (hole: unknown): hole is Hole =>
                typeof hole === "object" &&
                hole !== null &&
                Number.isFinite((hole as Hole).start) &&
                Number.isFinite((hole as Hole).size),
            )
            .map((hole: Hole) => ({ start: hole.start, size: hole.size })),
        );
      }
      if (Array.isArray(saved.procs)) {
        setProcs(
          saved.procs
            .filter(
              (proc: unknown): proc is Proc =>
                typeof proc === "object" &&
                proc !== null &&
                typeof (proc as Proc).id === "string",
            )
            .map((proc: Proc) => ({
              id: proc.id,
              size: Number.isFinite(Number(proc.size)) ? Number(proc.size) : 0,
              segmentsText:
                typeof proc.segmentsText === "string" ? proc.segmentsText : "",
            })),
        );
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
        JSON.stringify({ mode, strategies, memorySize, holes, procs }),
      );
    } catch {
      // Storage can be unavailable (private mode / quota); persistence is optional.
    }
  }, [mode, strategies, memorySize, holes, procs]);

  const validationErrors = useMemo(() => {
    const errors: string[] = [];

    if (strategies.length === 0) {
      errors.push("Select at least one placement strategy.");
    }
    if (!Number.isInteger(memorySize) || memorySize < 1) {
      errors.push("Memory size must be a positive integer.");
    }
    if (procs.length === 0) {
      errors.push("Add at least one process.");
    }

    const processIds = new Set<string>();
    procs.forEach((proc, processIndex) => {
      const id = proc.id.trim();
      const processLabel = id || `Process ${processIndex + 1}`;

      if (!id) {
        errors.push(`Process ${processIndex + 1}: enter an ID.`);
      } else if (processIds.has(id)) {
        errors.push(`Duplicate process ID "${id}".`);
      } else {
        processIds.add(id);
      }

      if (mode === "contiguous") {
        if (!Number.isInteger(proc.size) || proc.size <= 0) {
          errors.push(`${processLabel}: size must be a positive integer.`);
        }
        return;
      }

      const segments = parseSegments(proc.segmentsText);
      if (segments.length === 0) {
        errors.push(`${processLabel}: add at least one segment.`);
      }

      const segmentNames = new Set<string>();
      segments.forEach((segment, segmentIndex) => {
        if (!segment.name) {
          errors.push(
            `${processLabel}: segment ${segmentIndex + 1} needs a name (format name:size).`,
          );
        } else if (segmentNames.has(segment.name)) {
          errors.push(`${processLabel}: duplicate segment name "${segment.name}".`);
        } else {
          segmentNames.add(segment.name);
        }
        if (!Number.isInteger(segment.size) || segment.size <= 0) {
          errors.push(
            `${processLabel}: segment "${segment.name || segmentIndex + 1}" size must be a positive integer.`,
          );
        }
      });
    });

    const checkedHoles = holes.map((hole, index) => {
      const startValid = Number.isInteger(hole.start) && hole.start >= 0;
      const sizeValid = Number.isInteger(hole.size) && hole.size > 0;
      const withinMemory =
        startValid &&
        sizeValid &&
        (!Number.isInteger(memorySize) ||
          memorySize < 1 ||
          hole.start + hole.size <= memorySize);

      if (!startValid) {
        errors.push(`Hole ${index + 1}: start must be a non-negative integer.`);
      }
      if (!sizeValid) {
        errors.push(`Hole ${index + 1}: size must be a positive integer.`);
      } else if (!withinMemory) {
        errors.push(`Hole ${index + 1}: extends past the end of memory.`);
      }

      return { ...hole, index, valid: startValid && sizeValid && withinMemory };
    });

    const orderedHoles = checkedHoles
      .filter((hole) => hole.valid)
      .sort((a, b) => a.start - b.start);
    for (let index = 1; index < orderedHoles.length; index += 1) {
      const previous = orderedHoles[index - 1];
      const current = orderedHoles[index];
      if (current.start < previous.start + previous.size) {
        errors.push(
          `Holes ${previous.index + 1} and ${current.index + 1} overlap.`,
        );
      }
    }

    return errors;
  }, [holes, memorySize, mode, procs, strategies]);

  const requestedUnits = useMemo(() => {
    return procs.reduce((total, proc) => {
      if (mode === "contiguous") {
        return total + (Number.isFinite(proc.size) && proc.size > 0 ? proc.size : 0);
      }
      return (
        total +
        parseSegments(proc.segmentsText).reduce(
          (segmentTotal, segment) =>
            segmentTotal +
            (Number.isFinite(segment.size) && segment.size > 0 ? segment.size : 0),
          0,
        )
      );
    }, 0);
  }, [mode, procs]);

  const holeUnits = useMemo(
    () =>
      holes.reduce(
        (total, hole) =>
          total + (Number.isFinite(hole.size) && hole.size > 0 ? hole.size : 0),
        0,
      ),
    [holes],
  );

  const bestStrategies = useMemo(
    () => findBestStrategies(results),
    [results],
  );

  const activeLabel = `${labelForMode(mode)} · ${
    strategies.length === 0
      ? "No strategies"
      : strategies.length === STRATEGIES.length
        ? "All strategies"
        : strategies.map(labelForStrategy).join(", ")
  }`;

  const strategySummary =
    strategies.length === 0
      ? "Select at least one strategy to compare placement behavior."
      : strategies.length === STRATEGIES.length
        ? "All strategies selected — results are compared side by side."
        : `${strategies.length} strateg${strategies.length === 1 ? "y" : "ies"} selected — results are compared side by side.`;

  function toggleStrategy(strategy: string) {
    setStrategies((selected) =>
      selected.includes(strategy)
        ? selected.filter((item) => item !== strategy)
        : [...selected, strategy],
    );
  }

  function changeMode(nextMode: Mode) {
    if (nextMode === mode) return;
    setMode(nextMode);
    setProcs((current) =>
      current.map((proc) => {
        if (nextMode === "segmentation" && !proc.segmentsText.trim()) {
          const size = Number.isInteger(proc.size) && proc.size > 0 ? proc.size : 64;
          const codeSize = Math.max(1, Math.round(size * 0.6));
          const dataSize = Math.max(1, size - codeSize);
          return {
            ...proc,
            segmentsText: `code:${codeSize},data:${dataSize}`,
          };
        }
        if (nextMode === "contiguous") {
          const segmentTotal = parseSegments(proc.segmentsText).reduce(
            (total, segment) =>
              total +
              (Number.isFinite(segment.size) && segment.size > 0 ? segment.size : 0),
            0,
          );
          if ((!Number.isInteger(proc.size) || proc.size <= 0) && segmentTotal > 0) {
            return { ...proc, size: segmentTotal };
          }
        }
        return proc;
      }),
    );
    setError(null);
  }

  function applyPreset(preset: Preset) {
    setMode(preset.mode);
    setMemorySize(preset.memory_size);
    setHoles(preset.holes.map((hole) => ({ ...hole })));
    setProcs(preset.procs.map((proc) => ({ ...proc })));
    setError(null);
  }

  function updateHole(index: number, patch: Partial<Hole>) {
    setHoles((current) =>
      current.map((hole, holeIndex) =>
        holeIndex === index ? { ...hole, ...patch } : hole,
      ),
    );
  }

  function updateProc(index: number, patch: Partial<Proc>) {
    setProcs((current) =>
      current.map((proc, procIndex) =>
        procIndex === index ? { ...proc, ...patch } : proc,
      ),
    );
  }

  function addHole() {
    const memory =
      Number.isInteger(memorySize) && memorySize > 0 ? memorySize : 640;
    setHoles((current) => {
      const lastEnd = current.reduce(
        (end, hole) =>
          Number.isFinite(hole.start) && Number.isFinite(hole.size)
            ? Math.max(end, hole.start + hole.size)
            : end,
        0,
      );
      const start = Math.min(Math.max(lastEnd, 0), Math.max(memory - 1, 0));
      const size = Math.max(
        1,
        Math.min(Math.max(1, Math.floor(memory / 8)), memory - start),
      );
      return [...current, { start, size }];
    });
  }

  function addProcess() {
    setProcs((current) => [
      ...current,
      {
        id: nextProcessId(current),
        size: 64,
        segmentsText: "code:32,data:16,stack:16",
      },
    ]);
    setError(null);
  }

  function randomizeWorkload() {
    const memory =
      Number.isInteger(memorySize) && memorySize > 0 ? memorySize : 640;
    const count = 3 + Math.floor(Math.random() * 3);

    if (mode === "contiguous") {
      const largest = Math.max(20, Math.floor(memory / (count + 1)));
      setProcs(
        Array.from({ length: count }, (_, index) => ({
          id: `P${index + 1}`,
          size: 20 + Math.floor(Math.random() * Math.max(1, largest)),
          segmentsText: "",
        })),
      );
    } else {
      const names = ["code", "data", "stack", "heap"];
      setProcs(
        Array.from({ length: count }, (_, index) => {
          const segmentCount = 1 + Math.floor(Math.random() * 3);
          const largest = Math.max(10, Math.floor(memory / (count * 3)));
          const segments = Array.from({ length: segmentCount }, (_, segmentIndex) => ({
            name: names[segmentIndex % names.length],
            size: 10 + Math.floor(Math.random() * Math.max(1, largest)),
          }));
          return {
            id: `P${index + 1}`,
            size: segments.reduce((total, segment) => total + segment.size, 0),
            segmentsText: segments
              .map((segment) => `${segment.name}:${segment.size}`)
              .join(","),
          };
        }),
      );
    }
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
    const processes =
      mode === "contiguous"
        ? procs.map((proc) => ({ id: proc.id.trim(), size: proc.size }))
        : procs.map((proc) => ({
            id: proc.id.trim(),
            segments: parseSegments(proc.segmentsText).map((segment) => ({
              name: segment.name,
              size: segment.size,
            })),
          }));

    try {
      const output: ResultEntry[] = [];
      for (const strategy of strategies) {
        const response = await fetch(`${api}/simulate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            topic: "memory-management",
            payload: {
              mode,
              strategy,
              memory_size: memorySize,
              holes:
                holes.length > 0
                  ? holes.map((hole) => ({
                      start: hole.start,
                      size: hole.size,
                    }))
                  : undefined,
              processes,
            },
          }),
        });

        if (!response.ok) {
          const detail = await response.json().catch(() => ({}));
          const message = Array.isArray(detail.detail)
            ? detail.detail.join(", ")
            : detail.detail ?? response.statusText;
          throw new Error(`${labelForStrategy(strategy)}: ${message}`);
        }

        output.push({
          strategy,
          result: (await response.json()) as SimulationResult,
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
      <header className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 p-4 rounded-xl bg-surface-container shadow-[6px_6px_14px_rgba(0,0,0,0.65),-5px_-5px_12px_rgba(255,255,255,0.04)]">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex flex-wrap items-center gap-2 px-4 py-1.5 rounded-lg bg-surface-container-lowest shadow-[inset_3px_3px_7px_rgba(0,0,0,0.7)]">
            <span className="material-symbols-outlined text-primary-fixed-dim text-base">
              memory
            </span>
            <span className="font-mono text-[11px] text-on-surface-variant uppercase tracking-wider">
              Subsystem
            </span>
            <span className="text-on-surface-variant">/</span>
            <span className="font-display text-sm text-primary font-medium">
              Memory Management
            </span>
            <span className="material-symbols-outlined text-outline text-sm">
              chevron_right
            </span>
            <span className="font-mono text-xs text-primary-fixed font-semibold">
              {activeLabel}
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
        <aside className="xl:col-span-4 flex flex-col gap-6">
          <section className="neo-panel flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary-fixed-dim text-lg">
                  tune
                </span>
                <h2 className="font-display font-semibold tracking-tight">
                  Parameters
                </h2>
              </div>
              <span className="px-2 py-0.5 rounded font-mono text-[11px] bg-surface-container-lowest text-on-surface-variant shadow-[inset_1px_1px_3px_rgba(0,0,0,0.7)]">
                [MMU]
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
                Allocation Mode
              </span>
              <div className="grid grid-cols-2 gap-2">
                {MODES.map((item) => {
                  const selected = item.id === mode;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => changeMode(item.id)}
                      aria-pressed={selected}
                      className={`neo-btn px-3 py-2 text-left transition-all ${
                        selected
                          ? "bg-surface-container-lowest text-primary shadow-[inset_2px_2px_5px_rgba(0,0,0,0.8)]"
                          : "text-on-surface-variant hover:text-on-surface"
                      }`}
                    >
                      <span className="block font-display text-sm font-semibold">
                        {item.label}
                      </span>
                      <span
                        className={`mt-0.5 block text-[10px] leading-snug ${
                          selected ? "text-primary/80" : "text-on-surface-variant"
                        }`}
                      >
                        {item.desc}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
                Placement Strategies (multi = compare)
              </span>
              <div className="flex flex-wrap gap-1.5">
                {STRATEGIES.map((strategy) => {
                  const selected = strategies.includes(strategy.id);
                  return (
                    <button
                      key={strategy.id}
                      type="button"
                      onClick={() => toggleStrategy(strategy.id)}
                      aria-pressed={selected}
                      title={strategy.desc}
                      className={`px-3 py-1.5 rounded-lg font-mono text-xs transition-all ${
                        selected
                          ? "bg-surface-container-lowest text-primary shadow-[inset_2px_2px_5px_rgba(0,0,0,0.8)]"
                          : "bg-surface-container-low text-on-surface-variant neo-btn"
                      }`}
                    >
                      {strategy.label}
                    </button>
                  );
                })}
              </div>
              <p className="font-mono text-[10px] leading-relaxed text-on-surface-variant">
                {strategySummary}
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="memory-size"
                className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant"
              >
                Memory Size (units)
              </label>
              <input
                id="memory-size"
                type="number"
                min={1}
                className="neo-input w-full px-3 py-2 font-mono"
                value={memorySize}
                onChange={(event) => setMemorySize(Number(event.target.value))}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
                Presets
              </span>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.name}
                    type="button"
                    title={preset.note}
                    onClick={() => applyPreset(preset)}
                    className="neo-btn px-4 py-1.5 font-mono text-[11px] uppercase text-on-surface-variant hover:text-primary"
                  >
                    {preset.name}
                  </button>
                ))}
              </div>
            </div>

            {validationErrors.length > 0 && (
              <ul className="flex max-h-44 flex-col gap-1 overflow-auto rounded-lg border border-error/30 bg-error/5 p-3 text-xs text-error">
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
                : strategies.length > 1
                  ? `Run ${strategies.length} Strategies`
                  : "Run Simulation"}
            </button>
          </section>
          <section className="neo-panel flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary-fixed-dim text-lg">
                  inventory_2
                </span>
                <h2 className="font-display font-semibold tracking-tight">
                  Workload
                </h2>
              </div>
              <span className="font-mono text-[11px] text-on-surface-variant">
                {procs.length} process{procs.length === 1 ? "" : "es"}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className="neo-inset-sm p-2.5">
                <p className="font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
                  Processes
                </p>
                <p className="font-display text-lg font-semibold">{procs.length}</p>
              </div>
              <div className="neo-inset-sm p-2.5">
                <p className="font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
                  Holes
                </p>
                <p className="font-display text-lg font-semibold">{holes.length}</p>
              </div>
              <div className="neo-inset-sm p-2.5">
                <p className="font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
                  Requested
                </p>
                <p className="font-display text-lg font-semibold">{requestedUnits} u</p>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
                  Free Holes (optional)
                </span>
                {holes.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setHoles([])}
                    className="font-mono text-[10px] uppercase tracking-wider text-primary-fixed-dim hover:text-primary transition-colors"
                  >
                    Clear
                  </button>
                )}
              </div>

              {holes.length === 0 ? (
                <p className="neo-inset-sm p-2.5 font-mono text-[10px] leading-relaxed text-on-surface-variant">
                  No holes — memory starts as one free block from 0 to {memorySize}.
                </p>
              ) : (
                <div className="neo-inset-sm flex flex-col gap-2 p-2.5">
                  {holes.map((hole, holeIndex) => (
                    <div
                      key={holeIndex}
                      className="grid grid-cols-[1.25rem_1fr_1fr_1.5rem] items-end gap-1.5"
                    >
                      <span className="pb-1.5 font-mono text-[10px] text-on-surface-variant">
                        #{holeIndex + 1}
                      </span>
                      <label className="flex min-w-0 flex-col gap-0.5 font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
                        Start
                        <input
                          type="number"
                          min={0}
                          aria-label={`Hole ${holeIndex + 1} start address`}
                          className="neo-input w-full px-2 py-1 text-center font-mono text-xs"
                          value={hole.start}
                          onChange={(event) =>
                            updateHole(holeIndex, {
                              start: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label className="flex min-w-0 flex-col gap-0.5 font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
                        Size
                        <input
                          type="number"
                          min={1}
                          aria-label={`Hole ${holeIndex + 1} size`}
                          className="neo-input w-full px-2 py-1 text-center font-mono text-xs"
                          value={hole.size}
                          onChange={(event) =>
                            updateHole(holeIndex, {
                              size: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <button
                        type="button"
                        title={`Remove hole ${holeIndex + 1}`}
                        onClick={() =>
                          setHoles((current) =>
                            current.filter((_, index) => index !== holeIndex),
                          )
                        }
                        className="pb-1 text-error transition-opacity hover:opacity-75"
                      >
                        <span className="material-symbols-outlined text-base">
                          close
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <button
                type="button"
                onClick={addHole}
                className="neo-btn flex items-center justify-center gap-1.5 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-on-surface-variant hover:text-primary"
              >
                <span className="material-symbols-outlined text-sm">add_circle</span>
                Add hole
              </button>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
                  Processes
                </span>
                <span className="font-mono text-[10px] text-on-surface-variant">
                  {holeUnits} u in holes
                </span>
              </div>

              <div className="neo-inset-sm overflow-x-auto p-1.5">
                <table className="w-full text-left font-mono text-xs">
                  <thead>
                    <tr className="text-[10px] uppercase text-on-surface-variant">
                      <th className="p-1.5 font-medium">PID</th>
                      <th className="p-1.5 font-medium">
                        {mode === "contiguous" ? "Size" : "Segments (name:size)"}
                      </th>
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody className="text-on-surface">
                    {procs.map((proc, procIndex) => (
                      <tr
                        key={procIndex}
                        className="border-t border-surface-container-highest/60 hover:bg-surface-container-high/40 transition-colors"
                      >
                        <td className="p-1">
                          <input
                            aria-label={`Process ${procIndex + 1} ID`}
                            className="neo-input w-16 font-bold text-primary-fixed"
                            value={proc.id}
                            onChange={(event) =>
                              updateProc(procIndex, { id: event.target.value })
                            }
                          />
                        </td>
                        <td className="p-1">
                          {mode === "contiguous" ? (
                            <input
                              type="number"
                              min={1}
                              aria-label={`Process ${procIndex + 1} size`}
                              className="neo-input w-20 text-center"
                              value={proc.size}
                              onChange={(event) =>
                                updateProc(procIndex, {
                                  size: Number(event.target.value),
                                })
                              }
                            />
                          ) : (
                            <input
                              aria-label={`Process ${procIndex + 1} segments`}
                              className="neo-input w-full min-w-[170px]"
                              value={proc.segmentsText}
                              placeholder="code:100,data:60"
                              onChange={(event) =>
                                updateProc(procIndex, {
                                  segmentsText: event.target.value,
                                })
                              }
                            />
                          )}
                        </td>
                        <td className="p-1 text-right">
                          <button
                            type="button"
                            title={`Remove process ${proc.id || procIndex + 1}`}
                            onClick={() =>
                              setProcs((current) =>
                                current.filter((_, index) => index !== procIndex),
                              )
                            }
                            className="text-error text-xs transition-opacity hover:opacity-75"
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {procs.length === 0 && (
                  <p className="p-3 font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
                    No processes. Add at least one.
                  </p>
                )}
              </div>

              {mode === "segmentation" && (
                <p className="font-mono text-[10px] leading-relaxed text-on-surface-variant">
                  Segment format:{" "}
                  <span className="text-primary-fixed-dim">name:size, name:size</span>
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={addProcess}
                className="neo-btn flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium hover:text-primary"
              >
                <span className="material-symbols-outlined text-base">add_circle</span>
                Add Process
              </button>
              <button
                type="button"
                onClick={randomizeWorkload}
                className="neo-btn flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium hover:text-secondary"
              >
                <span className="material-symbols-outlined text-base">shuffle</span>
                Randomize
              </button>
            </div>
          </section>
        </aside>
        <main className="xl:col-span-8 flex flex-col gap-6">
          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-error/40 bg-error/10 p-4 text-sm text-error">
              <span className="material-symbols-outlined text-lg">error</span>
              <p>{error}</p>
            </div>
          )}

          {results.length === 0 && !loading && <EmptyState />}

          {loading && (
            <section className="neo-panel flex items-center gap-3 py-16 justify-center text-on-surface-variant font-mono text-sm">
              <span className="w-2 h-2 rounded-full bg-primary animate-ping" />
              Allocating memory blocks…
            </section>
          )}

          {results.length > 1 && (
            <ComparisonTable results={results} best={bestStrategies} />
          )}

          {results.map(({ strategy, result }) => (
            <ResultBlock
              key={`${strategy}-${runId}`}
              id={`strategy-${strategy}`}
              strategy={strategy}
              result={result}
              isBest={results.length > 1 && bestStrategies.has(strategy)}
            />
          ))}
        </main>
      </div>
    </main>
  );
}

function ComparisonTable({
  results,
  best,
}: {
  results: ResultEntry[];
  best: Set<string>;
}) {
  const rows = results
    .map((entry) => ({ entry, ...resultStatus(entry.result) }))
    .sort(
      (a, b) =>
        a.failedCount - b.failedCount || a.fragmentation - b.fragmentation,
    );

  return (
    <section className="neo-panel flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary-fixed-dim text-lg">
            leaderboard
          </span>
          <h2 className="font-display font-semibold tracking-tight">
            Placement Comparison
          </h2>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
          fewer failures · lower fragmentation
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left font-mono text-sm">
          <thead>
            <tr className="text-on-surface-variant text-[11px] uppercase">
              <th className="p-1.5 font-medium">#</th>
              <th className="p-1.5 font-medium">Strategy</th>
              <th className="p-1.5 font-medium text-right">Placed</th>
              <th className="p-1.5 font-medium text-right">Failed</th>
              <th className="p-1.5 font-medium text-right">Utilization</th>
              <th className="p-1.5 font-medium text-right">Free</th>
              <th className="p-1.5 font-medium text-right">Largest hole</th>
              <th className="p-1.5 font-medium text-right">Ext. frag</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ entry, failedCount, fragmentation }, index) => {
              const result = entry.result;
              const attempts = result.steps.length - 1;
              const isBestEntry = best.has(entry.strategy);

              return (
                <tr
                  key={entry.strategy}
                  className={`border-t border-surface-container-highest ${
                    isBestEntry ? "text-primary" : "text-on-surface"
                  }`}
                >
                  <td className="p-1.5 text-on-surface-variant">{index + 1}</td>
                  <td className="p-1.5">
                    <a
                      href={`#strategy-${entry.strategy}`}
                      className="uppercase hover:underline"
                    >
                      {labelForStrategy(entry.strategy)}
                    </a>
                    {isBestEntry && (
                      <span className="ml-2 rounded bg-primary-fixed-dim/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-primary-fixed-dim">
                        best
                      </span>
                    )}
                  </td>
                  <td className="p-1.5 text-right">
                    {attempts - failedCount} / {attempts}
                  </td>
                  <td
                    className={`p-1.5 text-right ${
                      failedCount > 0 ? "text-error" : "text-on-surface-variant"
                    }`}
                  >
                    {failedCount}
                  </td>
                  <td className="p-1.5 text-right">
                    {formatPercent(result.metrics.memory_utilization)}
                  </td>
                  <td className="p-1.5 text-right">
                    {formatUnits(result.metrics.total_free)}
                  </td>
                  <td className="p-1.5 text-right">
                    {formatUnits(result.metrics.largest_free_hole)}
                  </td>
                  <td className="p-1.5 text-right">
                    {formatPercent(fragmentation)}
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

function EmptyState() {
  return (
    <section className="neo-panel flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-primary-fixed-dim">
          memory_alt
        </span>
        <h2 className="font-display font-semibold tracking-tight">
          Ready to allocate
        </h2>
      </div>

      <p className="max-w-2xl text-sm leading-relaxed text-on-surface-variant">
        Set a memory size, optionally describe pre-existing free holes, and build
        a process queue. Run one strategy or compare all three to watch the map
        split into allocated blocks, leftover holes, and external fragmentation.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {MODES.map((item) => (
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

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {STRATEGIES.map((strategy) => (
          <div key={strategy.id} className="neo-inset-sm flex flex-col gap-1 p-3">
            <span className="font-mono text-xs font-bold text-primary-fixed">
              {strategy.label}
            </span>
            <span className="text-[11px] leading-snug text-on-surface-variant">
              {strategy.desc}
            </span>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
        <span className="h-2.5 w-2.5 rounded-sm border border-primary-fixed-dim bg-primary-fixed-dim/30" />
        <span className="px-2 py-1 rounded bg-surface-container-lowest shadow-[inset_1px_1px_3px_rgba(0,0,0,0.7)]">
          allocated process
        </span>
        <span className="h-2.5 w-2.5 rounded-sm border border-outline-variant bg-surface-container-high" />
        <span className="px-2 py-1 rounded bg-surface-container-lowest shadow-[inset_1px_1px_3px_rgba(0,0,0,0.7)]">
          free hole
        </span>
        <span className="h-2.5 w-2.5 rounded-sm border border-outline-variant/50 bg-surface-container-lowest" />
        <span className="px-2 py-1 rounded bg-surface-container-lowest shadow-[inset_1px_1px_3px_rgba(0,0,0,0.7)]">
          reserved / outside hole list
        </span>
      </div>
    </section>
  );
}

function ResultBlock({
  id,
  strategy,
  result,
  isBest,
}: {
  id: string;
  strategy: string;
  result: SimulationResult;
  isBest: boolean;
}) {
  const firstState = result.steps[0]?.state as unknown as MemoryState | undefined;
  const finalState = result.steps[result.steps.length - 1]?.state as unknown as
    | MemoryState
    | undefined;
  const finalLayout = finalState ? buildLayout(finalState) : [];
  const processAllocation = finalLayout
    .filter((block) => block.type === "allocated")
    .reduce((total, block) => total + block.size, 0);
  const reservedUnits = finalLayout
    .filter((block) => block.type === "reserved")
    .reduce((total, block) => total + block.size, 0);
  const resultMode: Mode =
    firstState?.mode === "segmentation" ? "segmentation" : "contiguous";
  const memorySize = Number(firstState?.memory_size ?? 0);
  const totalFree = Number(result.metrics.total_free);
  const failed = Array.isArray(result.metrics.failed_allocations)
    ? result.metrics.failed_allocations
    : [];
  const attempts = Math.max(result.steps.length - 1, 0);

  const ownerIds = useMemo(() => {
    const owners: string[] = [];
    for (const step of result.steps) {
      const state = step.state as unknown as MemoryState;
      for (const block of state.blocks ?? []) {
        if (block.type === "allocated" && block.owner && !owners.includes(block.owner)) {
          owners.push(block.owner);
        }
      }
    }
    return owners;
  }, [result.steps]);

  return (
    <section id={id} className="neo-panel flex flex-col gap-4 scroll-mt-24">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-primary animate-ping" />
            <h2 className="font-display font-semibold tracking-tight uppercase">
              {labelForStrategy(strategy)} —{" "}
              {resultMode === "segmentation" ? "Segment Layout" : "Memory Layout"}
            </h2>
            {isBest && (
              <span className="rounded bg-primary-fixed-dim/15 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-primary-fixed-dim">
                best placement
              </span>
            )}
          </div>
          <p className="font-mono text-[11px] text-on-surface-variant">
            {labelForMode(resultMode)} placement · {attempts} allocation attempt
            {attempts === 1 ? "" : "s"}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
          <span className="neo-inset-sm px-3 py-1.5 text-on-surface-variant">
            memory <strong className="text-primary">{memorySize}</strong>
          </span>
          <span className="neo-inset-sm px-3 py-1.5 text-on-surface-variant">
            attempts <strong className="text-primary-fixed-dim">{attempts}</strong>
          </span>
          <span className="neo-inset-sm px-3 py-1.5 text-on-surface-variant">
            failed{" "}
            <strong className={failed.length > 0 ? "text-error" : "text-primary"}>
              {failed.length}
            </strong>
          </span>
        </div>
      </div>

      <SimulationPlayer
        result={result}
        renderState={(step: Step) => (
          <MemoryStateView step={step} owners={ownerIds} />
        )}
      />

      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
          Final run totals
        </span>
        <span className="font-mono text-[10px] text-on-surface-variant">
          after all allocations
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <Metric
          label="Memory utilization"
          hint="includes reserved"
          value={formatPercent(result.metrics.memory_utilization)}
          accent
        />
        <Metric label="Process allocation" value={formatUnits(processAllocation)} />
        <Metric label="Reserved" value={formatUnits(reservedUnits)} />
        <Metric label="Free memory" value={formatUnits(totalFree)} />
        <Metric
          label="Largest hole"
          value={formatUnits(result.metrics.largest_free_hole)}
        />
        <Metric
          label="External frag."
          value={formatPercent(result.metrics.external_fragmentation)}
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

const FREE_HATCH =
  "repeating-linear-gradient(135deg, rgba(185,202,203,0.12) 0 5px, transparent 5px 10px)";
const RESERVED_HATCH =
  "repeating-linear-gradient(135deg, rgba(132,148,149,0.08) 0 3px, transparent 3px 7px)";

function MemoryStateView({ step, owners }: { step: Step; owners: string[] }) {
  const state = step.state as unknown as MemoryState;
  const layout = buildLayout(state);
  const allocatedBlocks = layout.filter((block) => block.type === "allocated");
  const freeBlocks = layout.filter((block) => block.type === "free");
  const allocatedUnits = allocatedBlocks.reduce(
    (total, block) => total + block.size,
    0,
  );
  const freeUnits = freeBlocks.reduce((total, block) => total + block.size, 0);
  const reservedUnits = layout
    .filter((block) => block.type === "reserved")
    .reduce((total, block) => total + block.size, 0);
  const largestHole = freeBlocks.reduce(
    (largest, block) => Math.max(largest, block.size),
    0,
  );
  const fragmentation =
    freeUnits > 0 ? 1 - largestHole / freeUnits : 0;
  const highlight = step.highlight ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
        <span className="neo-inset-sm px-2.5 py-1 text-on-surface-variant">
          MODE{" "}
          <strong className="text-primary-fixed-dim uppercase">
            {labelForMode(state.mode)}
          </strong>
        </span>
        <span className="neo-inset-sm px-2.5 py-1 text-on-surface-variant">
          ALLOCATED <strong className="text-primary">{allocatedUnits} u</strong>
        </span>
        <span className="neo-inset-sm px-2.5 py-1 text-on-surface-variant">
          FREE <strong className="text-tertiary-fixed">{freeUnits} u</strong>
        </span>
        {reservedUnits > 0 && (
          <span className="neo-inset-sm px-2.5 py-1 text-on-surface-variant">
            RESERVED{" "}
            <strong className="text-on-surface-variant">{reservedUnits} u</strong>
          </span>
        )}
        <span className="ml-auto text-on-surface-variant">
          external frag{" "}
          <strong className="text-primary-fixed">{formatPercent(fragmentation)}</strong>
        </span>
      </div>

      <MemoryMap
        state={state}
        layout={layout}
        owners={owners}
        highlight={highlight}
      />

      <div className="flex flex-wrap items-center gap-3 font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-sm border border-primary-fixed-dim bg-primary-fixed-dim/30" />
          allocated
        </span>
        <span className="flex items-center gap-1">
          <span
            className="h-2.5 w-2.5 rounded-sm border border-outline-variant"
            style={{ backgroundImage: FREE_HATCH }}
          />
          free hole
        </span>
        <span className="flex items-center gap-1">
          <span
            className="h-2.5 w-2.5 rounded-sm border border-outline-variant/50"
            style={{ backgroundColor: "#0c0e12", backgroundImage: RESERVED_HATCH }}
          />
          reserved
        </span>
        <span className="ml-auto text-primary-fixed-dim">
          outline = current placement
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
              Free holes
            </span>
            <span className="font-mono text-[10px] text-on-surface-variant">
              {freeBlocks.length} block{freeBlocks.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="flex min-h-9 flex-wrap items-center gap-1.5">
            {freeBlocks.length === 0 && (
              <span className="font-mono text-[10px] uppercase tracking-wider text-tertiary-fixed-dim">
                No free space remains
              </span>
            )}
            {freeBlocks.map((block, blockIndex) => (
              <span
                key={`${block.start}-${blockIndex}`}
                title={`Free hole: ${block.start}–${block.start + block.size}`}
                className="rounded-md border border-tertiary-fixed/30 bg-surface-container-high px-2 py-1 font-mono text-[11px] text-tertiary-fixed"
              >
                {block.start}–{block.start + block.size} · {block.size}u
              </span>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
              Allocated blocks
            </span>
            <span className="font-mono text-[10px] text-on-surface-variant">
              {allocatedBlocks.length} block{allocatedBlocks.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="flex min-h-9 flex-wrap items-center gap-1.5">
            {allocatedBlocks.length === 0 && (
              <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
                Nothing placed yet
              </span>
            )}
            {allocatedBlocks.map((block, blockIndex) => (
              <span
                key={`${block.start}-${block.label}-${blockIndex}`}
                title={`${block.label}: ${block.start}–${block.start + block.size}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-surface-container-highest bg-surface-container-high px-2 py-1 font-mono text-[11px]"
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{
                    backgroundColor: pidColor(block.owner ?? block.label, owners),
                  }}
                />
                <span className="font-semibold text-on-surface">{block.label}</span>
                <span className="text-on-surface-variant">
                  {block.start}–{block.start + block.size} · {block.size}u
                </span>
              </span>
            ))}
          </div>
        </div>
      </div>

      {state.mode === "segmentation" && (
        <SegmentTable
          records={state.segment_table ?? []}
          highlight={highlight}
        />
      )}
    </div>
  );
}

function MemoryMap({
  state,
  layout,
  owners,
  highlight,
}: {
  state: MemoryState;
  layout: MemoryBlock[];
  owners: string[];
  highlight: string[];
}) {
  const total = Number(state.memory_size);
  const tickValues = [0, 0.25, 0.5, 0.75, 1].map((fraction) =>
    Math.round(total * fraction),
  );

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
        <span>Physical memory · 0 to {total}</span>
        <span>
          {layout.length} block{layout.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="overflow-x-auto pb-1">
        <div
          role="img"
          aria-label={`Memory map from address 0 to ${total}`}
          className="min-w-[560px]"
        >
          <div className="flex h-24 w-full overflow-hidden rounded-xl border border-surface-container-highest bg-[#0c0e12]">
            {layout.map((block, blockIndex) => {
              const width = total > 0 ? (block.size / total) * 100 : 0;
              const isFree = block.type === "free";
              const isReserved = block.type === "reserved";
              const isAllocated = block.type === "allocated";
              const isHighlighted =
                isAllocated &&
                (highlight.includes(block.label) ||
                  (block.owner !== null && highlight.includes(block.owner)));
              const blockStyle = isFree
                ? { backgroundColor: "#1a1c20", backgroundImage: FREE_HATCH }
                : isReserved
                  ? {
                      backgroundColor: "#0c0e12",
                      backgroundImage: RESERVED_HATCH,
                    }
                  : {
                      backgroundColor: pidColor(block.owner ?? block.label, owners),
                    };

              return (
                <div
                  key={`${block.start}-${block.size}-${block.type}-${block.owner ?? ""}-${blockIndex}`}
                  title={`${
                    isFree ? "Free hole" : isReserved ? "Reserved" : block.label
                  }: ${block.start}–${block.start + block.size} (${block.size} units)`}
                  style={{ width: `${width}%`, ...blockStyle }}
                  className={`relative flex min-w-0 flex-col items-center justify-center overflow-hidden border-r border-surface-container-highest/60 px-1 text-center transition-all ${
                    isHighlighted
                      ? "z-10 shadow-[inset_0_0_0_2px_rgba(219,252,255,0.95),0_0_14px_rgba(0,240,255,0.35)]"
                      : ""
                  }`}
                >
                  {width >= 4 && (
                    <>
                      <span
                        className={`w-full truncate font-mono text-[10px] font-semibold leading-tight ${
                          isAllocated
                            ? "text-white"
                            : isFree
                              ? "text-on-surface-variant"
                              : "text-on-surface-variant/50"
                        }`}
                      >
                        {isFree ? "FREE" : isReserved ? "RESERVED" : block.label}
                      </span>
                      <span
                        className={`font-mono text-[9px] ${
                          isAllocated
                            ? "text-white/75"
                            : "text-on-surface-variant/60"
                        }`}
                      >
                        {block.size}u
                      </span>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-1 flex justify-between font-mono text-[9px] text-on-surface-variant/70">
            {tickValues.map((tick, tickIndex) => (
              <span key={`${tick}-${tickIndex}`}>{tick}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function SegmentTable({
  records,
  highlight,
}: {
  records: SegmentRecord[];
  highlight: string[];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
        <span>Segment table · base / limit</span>
        <span>
          {records.length} segment{records.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="neo-inset-sm overflow-x-auto p-1.5">
        {records.length === 0 ? (
          <p className="p-2 font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
            No segments placed yet.
          </p>
        ) : (
          <table className="w-full text-left font-mono text-xs">
            <thead>
              <tr className="text-[10px] uppercase text-on-surface-variant">
                <th className="p-1.5 font-medium">Process</th>
                <th className="p-1.5 font-medium">Segment</th>
                <th className="p-1.5 font-medium text-right">Size</th>
                <th className="p-1.5 font-medium text-right">Base</th>
                <th className="p-1.5 font-medium text-right">Limit</th>
                <th className="p-1.5 font-medium text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record, recordIndex) => {
                const key = `${record.process}:${record.segment}`;
                const isCurrent = highlight.includes(key);
                const limit =
                  record.limit ??
                  (record.base !== null ? record.base + record.size : null);
                const allocated = record.status === "allocated";

                return (
                  <tr
                    key={`${key}-${recordIndex}`}
                    className={`border-t border-surface-container-highest/60 ${
                      isCurrent ? "bg-primary-fixed-dim/10 text-primary" : ""
                    }`}
                  >
                    <td className="p-1.5 font-bold">{record.process}</td>
                    <td className="p-1.5">{record.segment}</td>
                    <td className="p-1.5 text-right">{record.size}</td>
                    <td className="p-1.5 text-right">{record.base ?? "—"}</td>
                    <td className="p-1.5 text-right">{limit ?? "—"}</td>
                    <td className="p-1.5 text-right">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${
                          allocated
                            ? "bg-tertiary-fixed/10 text-tertiary-fixed"
                            : "bg-error/10 text-error"
                        }`}
                      >
                        {record.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  accent = false,
  hint,
}: {
  label: string;
  value: string;
  accent?: boolean;
  hint?: string;
}) {
  return (
    <div className="neo-inset-sm p-3">
      <p className="font-mono text-[10px] uppercase text-on-surface-variant">
        {label}
      </p>
      <p className={`font-display font-semibold ${accent ? "text-primary" : ""}`}>
        {value}
      </p>
      {hint && (
        <p className="mt-0.5 font-mono text-[9px] text-on-surface-variant/70">
          {hint}
        </p>
      )}
    </div>
  );
}



