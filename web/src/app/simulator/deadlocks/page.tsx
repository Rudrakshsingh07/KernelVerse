"use client";

import { useEffect, useId, useMemo, useState } from "react";
import SimulationPlayer from "@/components/SimulationPlayer";
import type { SimulationResult, Step } from "@/lib/types";

type ModeId = "banker" | "detection";

const MODES = [
  {
    id: "banker",
    label: "Banker's Algorithm",
    short: "Avoidance",
    icon: "verified_user",
    desc: "Prove the state safe by finding an ordering in which every process can finish.",
  },
  {
    id: "detection",
    label: "Wait-For Graph",
    short: "Detection",
    icon: "account_tree",
    desc: "Draw who is waiting for whom, then search for a cycle with DFS.",
  },
] as const;

const STORAGE_KEY = "kv:deadlocks";

interface ResourceRow {
  id: string;
  total: number;
  available: number;
}

interface ProcessRow {
  id: string;
  alloc: number[];
  max: number[];
}

interface Preset {
  name: string;
  note: string;
  mode: ModeId;
  resources: ResourceRow[];
  processes: ProcessRow[];
}

interface WaitEdge {
  from: string;
  to: string;
  via: string[];
}

interface DeadlockState {
  mode: string;
  processes: string[];
  resources: string[];
  total: Record<string, number>;
  allocation: Record<string, Record<string, number>>;
  max: Record<string, Record<string, number>>;
  need: Record<string, Record<string, number>>;
  available: Record<string, number>;
  work: Record<string, number>;
  initial_available?: Record<string, number>;
  holders?: Record<string, string[]>;
  phase?: string;
  note?: string;
  safe_sequence?: string[];
  finished?: string[];
  unfinished?: string[];
  last_executed?: string;
  work_before?: Record<string, number>;
  released?: Record<string, number>;
  wait_for?: Record<string, string[]>;
  wait_edges?: WaitEdge[];
  inspecting?: string | null;
  cycle?: string[];
  deadlock?: boolean;
}

const CLASSIC_RESOURCES: ResourceRow[] = [
  { id: "A", total: 10, available: 3 },
  { id: "B", total: 5, available: 3 },
  { id: "C", total: 7, available: 2 },
];

const CLASSIC_PROCESSES: ProcessRow[] = [
  { id: "P0", alloc: [0, 1, 0], max: [7, 5, 3] },
  { id: "P1", alloc: [2, 0, 0], max: [3, 2, 2] },
  { id: "P2", alloc: [3, 0, 2], max: [9, 0, 2] },
  { id: "P3", alloc: [2, 1, 1], max: [2, 2, 2] },
  { id: "P4", alloc: [0, 0, 2], max: [4, 3, 3] },
];

const PRESETS: Preset[] = [
  {
    name: "Classic safe state",
    note: "The textbook Banker's example. A safe sequence exists.",
    mode: "banker",
    resources: CLASSIC_RESOURCES,
    processes: CLASSIC_PROCESSES,
  },
  {
    name: "Unsafe state",
    note: "Two processes hold all ten instances; neither can finish.",
    mode: "banker",
    resources: [{ id: "R", total: 10, available: 0 }],
    processes: [
      { id: "P0", alloc: [6], max: [10] },
      { id: "P1", alloc: [4], max: [10] },
    ],
  },
  {
    name: "Deadlock cycle",
    note: "P0 holds R0 and waits for R1; P1 holds R1 and waits for R0.",
    mode: "detection",
    resources: [
      { id: "R0", total: 1, available: 0 },
      { id: "R1", total: 1, available: 0 },
    ],
    processes: [
      { id: "P0", alloc: [1, 0], max: [1, 1] },
      { id: "P1", alloc: [0, 1], max: [1, 1] },
    ],
  },
  {
    name: "Wait, no cycle",
    note: "P0 waits for P1, but P1 is not waiting on anyone.",
    mode: "detection",
    resources: [
      { id: "R0", total: 1, available: 0 },
      { id: "R1", total: 1, available: 0 },
    ],
    processes: [
      { id: "P0", alloc: [1, 0], max: [1, 1] },
      { id: "P1", alloc: [0, 1], max: [0, 1] },
    ],
  },
];

function cloneResources(rows: ResourceRow[]): ResourceRow[] {
  return rows.map((row) => ({ ...row }));
}

function cloneProcesses(rows: ProcessRow[]): ProcessRow[] {
  return rows.map((row) => ({ ...row, alloc: [...row.alloc], max: [...row.max] }));
}

function nonNegativeInt(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

function positiveInt(value: unknown, fallback = 1): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : fallback;
}

function normalizeArray(value: unknown, length: number): number[] {
  const source = Array.isArray(value) ? value : [];
  return Array.from({ length }, (_, index) => nonNegativeInt(source[index]));
}

function nextProcessId(processes: ProcessRow[]): string {
  let index = processes.length;
  while (processes.some((process) => process.id === `P${index}`)) index += 1;
  return `P${index}`;
}

function nextResourceId(resources: ResourceRow[]): string {
  let code = 65 + resources.length;
  while (
    code <= 90 &&
    resources.some((resource) => resource.id === String.fromCharCode(code))
  ) {
    code += 1;
  }
  return code <= 90 ? String.fromCharCode(code) : `R${resources.length + 1}`;
}

function restoreSavedState(
  raw: unknown,
): { mode: ModeId; resources: ResourceRow[]; processes: ProcessRow[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const saved = raw as Record<string, unknown>;

  const rawResources = Array.isArray(saved.resources) ? saved.resources : [];
  const resources: ResourceRow[] = rawResources
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .map((row, index) => ({
      id:
        typeof row.id === "string" && row.id.trim()
          ? row.id
          : String.fromCharCode(65 + index),
      total: positiveInt(row.total, 10),
      available: nonNegativeInt(row.available),
    }));

  const rawProcesses = Array.isArray(saved.processes) ? saved.processes : [];
  const processes: ProcessRow[] = rawProcesses
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .map((row, index) => ({
      id:
        typeof row.id === "string" && row.id.trim() ? row.id : `P${index}`,
      alloc: normalizeArray(row.alloc, resources.length),
      max: normalizeArray(row.max, resources.length),
    }));

  if (resources.length === 0 || processes.length === 0) return null;
  return {
    mode: saved.mode === "detection" ? "detection" : "banker",
    resources,
    processes,
  };
}

function formatVector(
  vector: Record<string, number> | undefined,
  resources: string[],
  onlyNonZero = false,
): string {
  if (!vector) return "—";
  const parts = resources
    .filter((resource) => !onlyNonZero || (vector[resource] ?? 0) !== 0)
    .map((resource) => `${resource}=${vector[resource] ?? 0}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

function phaseLabel(phase: string | undefined): string {
  switch (phase) {
    case "safety-check":
      return "safety check";
    case "build":
      return "graph build";
    case "detect":
      return "cycle search";
    case "complete":
      return "complete";
    case "stuck":
      return "stuck";
    default:
      return "initial";
  }
}

function metricList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export default function DeadlocksPage() {
  const [mode, setMode] = useState<ModeId>("banker");
  const [resources, setResources] = useState<ResourceRow[]>(cloneResources(CLASSIC_RESOURCES));
  const [processes, setProcesses] = useState<ProcessRow[]>(cloneProcesses(CLASSIC_PROCESSES));
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [runId, setRunId] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = restoreSavedState(JSON.parse(raw));
      if (saved) {
        setMode(saved.mode);
        setResources(saved.resources);
        setProcesses(saved.processes);
      }
    } catch {
      // Ignore malformed storage and keep the built-in classic state.
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode, resources, processes }));
    } catch {
      // Storage can be unavailable (private mode / quota); persistence is optional.
    }
  }, [mode, resources, processes]);

  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    if (processes.length === 0) errors.push("Add at least one process.");
    if (resources.length === 0) errors.push("Add at least one resource.");

    const seenProcesses = new Set<string>();
    processes.forEach((process, index) => {
      const id = process.id.trim();
      if (!id) {
        errors.push(`Process ${index + 1} needs a non-empty ID.`);
      } else if (seenProcesses.has(id)) {
        errors.push(`Duplicate process ID "${id}".`);
      } else {
        seenProcesses.add(id);
      }
    });

    const seenResources = new Set<string>();
    resources.forEach((resource, index) => {
      const id = resource.id.trim();
      if (!id) {
        errors.push(`Resource ${index + 1} needs a non-empty ID.`);
      } else if (seenResources.has(id)) {
        errors.push(`Duplicate resource ID "${id}".`);
      } else {
        seenResources.add(id);
      }
      if (!Number.isInteger(resource.total) || resource.total <= 0) {
        errors.push(`Resource ${id || index + 1}: total must be a positive whole number.`);
      }
      if (!Number.isInteger(resource.available) || resource.available < 0) {
        errors.push(`Resource ${id || index + 1}: available must be a non-negative whole number.`);
      }
    });

    processes.forEach((process) => {
      resources.forEach((resource, resourceIndex) => {
        const alloc = process.alloc[resourceIndex] ?? 0;
        const max = process.max[resourceIndex] ?? 0;
        if (!Number.isInteger(alloc) || alloc < 0) {
          errors.push(`${process.id || "Process"} / ${resource.id || "resource"}: allocation must be a non-negative whole number.`);
        }
        if (!Number.isInteger(max) || max < 0) {
          errors.push(`${process.id || "Process"} / ${resource.id || "resource"}: max must be a non-negative whole number.`);
        }
        if (Number.isInteger(alloc) && Number.isInteger(max) && alloc > max) {
          errors.push(`${process.id || "Process"} / ${resource.id || "resource"}: allocation cannot exceed max.`);
        }
      });
    });

    resources.forEach((resource, resourceIndex) => {
      if (!Number.isInteger(resource.total) || !Number.isInteger(resource.available)) return;
      const allocated = processes.reduce(
        (sum, process) => sum + (Number.isInteger(process.alloc[resourceIndex]) ? process.alloc[resourceIndex] : 0),
        0,
      );
      if (allocated + resource.available > resource.total) {
        errors.push(
          `${resource.id || "Resource"}: available + allocated (${allocated + resource.available}) exceeds total instances (${resource.total}).`,
        );
      }
    });

    return errors;
  }, [processes, resources]);

  const activeMode = MODES.find((candidate) => candidate.id === mode) ?? MODES[0];
  const resultMode = result
    ? String(result.steps[0]?.state?.mode ?? "banker")
    : mode;
  const resultDeadlocked = result ? Boolean(result.metrics.deadlock) : false;
  const resultSafe = result
    ? result.metrics.safe === undefined
      ? !resultDeadlocked
      : Boolean(result.metrics.safe)
    : false;

  const headerStatus = !result
    ? "Not run"
    : resultMode === "banker"
      ? resultSafe
        ? "Safe state"
        : "Unsafe state"
      : resultDeadlocked
        ? "Deadlock"
        : "No deadlock";

  function updateResource(index: number, key: "id" | "total" | "available", value: string) {
    setResources((current) =>
      current.map((resource, resourceIndex) =>
        resourceIndex === index
          ? { ...resource, [key]: key === "id" ? value : Number(value) }
          : resource,
      ),
    );
  }

  function addResource() {
    setResources((current) => [
      ...current,
      { id: nextResourceId(current), total: 10, available: 0 },
    ]);
    setProcesses((current) =>
      current.map((process) => ({
        ...process,
        alloc: [...process.alloc, 0],
        max: [...process.max, 0],
      })),
    );
  }

  function removeResource(index: number) {
    setResources((current) => current.filter((_, resourceIndex) => resourceIndex !== index));
    setProcesses((current) =>
      current.map((process) => ({
        ...process,
        alloc: process.alloc.filter((_, resourceIndex) => resourceIndex !== index),
        max: process.max.filter((_, resourceIndex) => resourceIndex !== index),
      })),
    );
  }

  function updateProcessId(index: number, value: string) {
    setProcesses((current) =>
      current.map((process, processIndex) =>
        processIndex === index ? { ...process, id: value } : process,
      ),
    );
  }

  function updateProcessCell(
    processIndex: number,
    matrix: "alloc" | "max",
    resourceIndex: number,
    value: string,
  ) {
    setProcesses((current) =>
      current.map((process, index) => {
        if (index !== processIndex) return process;
        const nextValues = [...process[matrix]];
        nextValues[resourceIndex] = Number(value);
        return { ...process, [matrix]: nextValues };
      }),
    );
  }

  function addProcess() {
    setProcesses((current) => [
      ...current,
      {
        id: nextProcessId(current),
        alloc: resources.map(() => 0),
        max: resources.map(() => 0),
      },
    ]);
  }

  function removeProcess(index: number) {
    setProcesses((current) => current.filter((_, processIndex) => processIndex !== index));
  }

  function applyPreset(preset: Preset) {
    setMode(preset.mode);
    setResources(cloneResources(preset.resources));
    setProcesses(cloneProcesses(preset.processes));
    setResult(null);
    setError(null);
  }

  function randomizeState() {
    const nextProcesses = cloneProcesses(processes);
    const nextResources = resources.map((resource, resourceIndex) => {
      const total = positiveInt(resource.total, 10);
      let allocatedTotal = 0;
      nextProcesses.forEach((process) => {
        const alloc = Math.floor(Math.random() * (total + 1));
        process.alloc[resourceIndex] = alloc;
        process.max[resourceIndex] = alloc + Math.floor(Math.random() * (total - alloc + 1));
        allocatedTotal += alloc;
      });
      return {
        ...resource,
        total,
        available: Math.max(0, total - allocatedTotal),
      };
    });
    setResources(nextResources);
    setProcesses(nextProcesses);
    setResult(null);
    setError(null);
  }

  async function runSimulation() {
    if (validationErrors.length > 0) {
      setError(validationErrors.join(" "));
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);
    const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

    const allocation: Record<string, Record<string, number>> = {};
    const max: Record<string, Record<string, number>> = {};
    processes.forEach((process) => {
      allocation[process.id] = {};
      max[process.id] = {};
      resources.forEach((resource, resourceIndex) => {
        allocation[process.id][resource.id] = process.alloc[resourceIndex] ?? 0;
        max[process.id][resource.id] = process.max[resourceIndex] ?? 0;
      });
    });
    const available = Object.fromEntries(
      resources.map((resource) => [resource.id, resource.available]),
    );

    try {
      const res = await fetch(`${api}/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: "deadlocks",
          payload: {
            mode,
            processes: processes.map((process) => process.id),
            resources: resources.map((resource) => ({
              id: resource.id,
              total: resource.total,
            })),
            allocation,
            max,
            available,
          },
        }),
      });

      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        const message = Array.isArray(detail.detail)
          ? detail.detail.join(" ")
          : typeof detail.detail === "string"
            ? detail.detail
            : res.statusText;
        throw new Error(message);
      }

      setResult((await res.json()) as SimulationResult);
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
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-surface-container-lowest shadow-[inset_3px_3px_7px_rgba(0,0,0,0.7)]">
            <span className="material-symbols-outlined text-primary-fixed-dim text-base">lock</span>
            <span className="font-mono text-[11px] text-on-surface-variant uppercase tracking-wider">Subsystem</span>
            <span className="text-on-surface-variant">/</span>
            <span className="font-display text-sm text-primary font-medium">Deadlocks</span>
            <span className="material-symbols-outlined text-outline text-sm">chevron_right</span>
            <span className="font-mono text-xs text-primary-fixed font-semibold">
              {activeMode.short} — {headerStatus}
            </span>
          </div>
        </div>
        <button
          onClick={runSimulation}
          disabled={loading || validationErrors.length > 0}
          className="neo-btn px-6 py-2.5 font-display font-semibold text-primary disabled:opacity-40"
        >
          {loading ? "Running…" : "▶ Run Simulation"}
        </button>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* LEFT: mode, resources, matrices */}
        <aside className="xl:col-span-5 flex flex-col gap-6">
          <section className="neo-panel flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary-fixed-dim text-lg">tune</span>
                <h2 className="font-display font-semibold tracking-tight">Parameters</h2>
              </div>
              <span className="px-2 py-0.5 rounded font-mono text-[11px] bg-surface-container-lowest text-on-surface-variant shadow-[inset_1px_1px_3px_rgba(0,0,0,0.7)]">
                [DEADLOCK CONTROLLER]
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
                Analysis Mode
              </span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {MODES.map((candidate) => {
                  const selected = mode === candidate.id;
                  return (
                    <button
                      key={candidate.id}
                      onClick={() => {
                        setMode(candidate.id);
                        setResult(null);
                        setError(null);
                      }}
                      aria-pressed={selected}
                      className={`flex flex-col items-start gap-1 rounded-xl p-3 text-left transition-all ${
                        selected
                          ? "bg-surface-container-lowest shadow-[inset_2px_2px_6px_rgba(0,0,0,0.8)]"
                          : "neo-btn text-on-surface-variant"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span className={`material-symbols-outlined text-lg ${selected ? "text-primary-fixed-dim" : ""}`}>
                          {candidate.icon}
                        </span>
                        <span className={`font-display text-sm font-semibold ${selected ? "text-primary" : ""}`}>
                          {candidate.label}
                        </span>
                      </span>
                      <span className="text-[11px] leading-snug text-on-surface-variant">
                        {candidate.desc}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
                Textbook Presets
              </span>
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.name}
                    onClick={() => applyPreset(preset)}
                    title={preset.note}
                    className="neo-btn px-3 py-1.5 font-mono text-[11px] text-on-surface-variant hover:text-primary"
                  >
                    {preset.name}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="neo-panel flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary-fixed-dim text-lg">database</span>
                <h2 className="font-display font-semibold tracking-tight">Resource Instances</h2>
              </div>
              <span className="font-mono text-[11px] text-on-surface-variant">
                {resources.length} resource{resources.length === 1 ? "" : "s"}
              </span>
            </div>

            <div className="overflow-x-auto neo-inset p-1.5">
              <table className="w-full text-left font-mono text-sm border-collapse">
                <thead>
                  <tr className="text-on-surface-variant text-[10px] uppercase">
                    <th className="p-1.5 font-medium">ID</th>
                    <th className="p-1.5 font-medium text-center">Total</th>
                    <th className="p-1.5 font-medium text-center">Available</th>
                    <th className="p-1.5 font-medium text-right">Remove</th>
                  </tr>
                </thead>
                <tbody>
                  {resources.map((resource, index) => (
                    <tr key={index} className="hover:bg-surface-container-high/40 transition-colors">
                      <td className="p-1.5">
                        <input
                          aria-label={`Resource ${index + 1} ID`}
                          className="neo-input w-16 font-bold text-primary-fixed"
                          value={resource.id}
                          onChange={(event) => updateResource(index, "id", event.target.value)}
                        />
                      </td>
                      <td className="p-1.5 text-center">
                        <input
                          aria-label={`${resource.id || `Resource ${index + 1}`} total instances`}
                          type="number"
                          min={1}
                          className="neo-input w-20 text-center"
                          value={resource.total}
                          onChange={(event) => updateResource(index, "total", event.target.value)}
                        />
                      </td>
                      <td className="p-1.5 text-center">
                        <input
                          aria-label={`${resource.id || `Resource ${index + 1}`} available instances`}
                          type="number"
                          min={0}
                          className="neo-input w-20 text-center"
                          value={resource.available}
                          onChange={(event) => updateResource(index, "available", event.target.value)}
                        />
                      </td>
                      <td className="p-1.5 text-right">
                        <button
                          onClick={() => removeResource(index)}
                          disabled={resources.length === 1}
                          title="Remove resource"
                          className="text-error text-xs disabled:opacity-30"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between gap-2">
              <button
                onClick={addResource}
                className="neo-btn flex items-center gap-1.5 px-4 py-2 text-sm font-medium hover:text-primary"
              >
                <span className="material-symbols-outlined text-base">add_circle</span>
                Add Resource
              </button>
              <span className="font-mono text-[10px] text-on-surface-variant">
                total = available + held
              </span>
            </div>
          </section>

          <section className="neo-panel flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary-fixed-dim text-lg">table_chart</span>
                <h2 className="font-display font-semibold tracking-tight">Allocation / Max</h2>
              </div>
              <span className="font-mono text-[11px] text-on-surface-variant">
                {processes.length} process{processes.length === 1 ? "" : "es"}
              </span>
            </div>

            <div className="overflow-x-auto neo-inset p-1.5">
              <table className="w-full text-left font-mono text-sm border-collapse">
                <thead>
                  <tr className="text-on-surface-variant text-[10px] uppercase">
                    <th rowSpan={2} className="p-1.5 font-medium">PID</th>
                    <th colSpan={resources.length} className="p-1.5 font-medium text-center border-l border-surface-container-highest/70">
                      Allocation
                    </th>
                    <th colSpan={resources.length} className="p-1.5 font-medium text-center border-l border-surface-container-highest/70">
                      Max
                    </th>
                    <th rowSpan={2} className="p-1.5 font-medium text-right">Remove</th>
                  </tr>
                  <tr className="text-on-surface-variant/70 text-[9px]">
                    {["Allocation", "Max"].map((group) =>
                      resources.map((resource, resourceIndex) => (
                        <th
                          key={`${group}-${indexKey(resource.id, resourceIndex)}`}
                          className={`px-1.5 pb-1 text-center font-medium ${
                            resourceIndex === 0 ? "border-l border-surface-container-highest/70" : ""
                          }`}
                        >
                          {resource.id || "?"}
                        </th>
                      )),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {processes.map((process, processIndex) => (
                    <tr key={processIndex} className="hover:bg-surface-container-high/40 transition-colors">
                      <td className="p-1.5">
                        <input
                          aria-label={`Process ${processIndex + 1} ID`}
                          className="neo-input w-16 font-bold text-primary-fixed"
                          value={process.id}
                          onChange={(event) => updateProcessId(processIndex, event.target.value)}
                        />
                      </td>
                      {resources.map((resource, resourceIndex) => (
                        <td key={`alloc-${resourceIndex}`} className="p-1.5 text-center">
                          <input
                            aria-label={`${process.id || `Process ${processIndex + 1}`} allocation of ${resource.id || `resource ${resourceIndex + 1}`}`}
                            type="number"
                            min={0}
                            className="neo-input w-14 text-center"
                            value={process.alloc[resourceIndex] ?? 0}
                            onChange={(event) =>
                              updateProcessCell(processIndex, "alloc", resourceIndex, event.target.value)
                            }
                          />
                        </td>
                      ))}
                      {resources.map((resource, resourceIndex) => (
                        <td key={`max-${resourceIndex}`} className="p-1.5 text-center">
                          <input
                            aria-label={`${process.id || `Process ${processIndex + 1}`} maximum of ${resource.id || `resource ${resourceIndex + 1}`}`}
                            type="number"
                            min={0}
                            className={`neo-input w-14 text-center ${resourceIndex === 0 ? "border-l border-surface-container-highest/30" : ""}`}
                            value={process.max[resourceIndex] ?? 0}
                            onChange={(event) =>
                              updateProcessCell(processIndex, "max", resourceIndex, event.target.value)
                            }
                          />
                        </td>
                      ))}
                      <td className="p-1.5 text-right">
                        <button
                          onClick={() => removeProcess(processIndex)}
                          disabled={processes.length === 1}
                          title="Remove process"
                          className="text-error text-xs disabled:opacity-30"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={addProcess}
                className="neo-btn flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium hover:text-primary"
              >
                <span className="material-symbols-outlined text-base">add_circle</span>
                Add Process
              </button>
              <button
                onClick={randomizeState}
                className="neo-btn flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium hover:text-secondary"
              >
                <span className="material-symbols-outlined text-base">shuffle</span>
                Randomize
              </button>
            </div>

            <p className="font-mono text-[10px] leading-relaxed text-on-surface-variant">
              Need is derived as <span className="text-primary-fixed-dim">Max − Allocation</span>.
              Keep allocation ≤ max and available + all allocated instances ≤ total.
            </p>

            {validationErrors.length > 0 && (
              <ul className="flex flex-col gap-1 rounded-lg border border-error/30 bg-error/5 p-3 text-xs text-error">
                {validationErrors.map((validationError, index) => (
                  <li key={`${validationError}-${index}`} className="flex gap-1.5">
                    <span className="material-symbols-outlined text-sm">error</span>
                    <span>{validationError}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>

        {/* RIGHT: step-through stage */}
        <main className="xl:col-span-7 flex flex-col gap-6">
          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-error/40 bg-error/10 p-4 text-sm text-error">
              <span className="material-symbols-outlined text-lg">error</span>
              <p>{error}</p>
            </div>
          )}

          {!result && !loading && (
            <section className="neo-panel flex flex-col gap-5">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary-fixed-dim">{activeMode.icon}</span>
                <h2 className="font-display font-semibold tracking-tight">
                  {activeMode.label} — ready to analyse
                </h2>
              </div>
              <p className="max-w-2xl text-sm text-on-surface-variant">
                {mode === "banker"
                  ? "Banker's algorithm asks whether at least one ordering exists in which every process can finish. Each step selects a process whose remaining need fits the current Work vector, runs it, and returns its allocation to Work."
                  : "Detection asks whether the current allocation already contains a circular wait. Each step examines one process, adds the edges it is waiting on, and finally runs a DFS cycle search."}
              </p>

              <ol className="grid grid-cols-1 md:grid-cols-3 gap-2">
                {(mode === "banker"
                  ? [
                      ["Compute need", "Need = Max − Allocation for every process and resource."],
                      ["Run a process", "Find Need ≤ Work, then add its allocation back to Work."],
                      ["Decide", "All processes finish ⇒ safe. Otherwise the state is unsafe."],
                    ]
                  : [
                      ["Read the need", "Compare each process's remaining need with free Work."],
                      ["Draw edges", "Pi → Pj when Pi needs a resource held by Pj."],
                      ["Search", "A cycle in the wait-for graph means deadlock."],
                    ]
                ).map(([title, description], index) => (
                  <li key={title} className="neo-inset-sm flex flex-col gap-1 p-3">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-primary-fixed-dim">
                      0{index + 1} · {title}
                    </span>
                    <span className="text-[11px] leading-snug text-on-surface-variant">{description}</span>
                  </li>
                ))}
              </ol>

              <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
                <span className="w-2.5 h-2.5 rounded-full bg-tertiary-fixed" />
                <span className="px-2 py-1 rounded bg-surface-container-lowest shadow-[inset_1px_1px_3px_rgba(0,0,0,0.7)]">
                  safe / finished
                </span>
                <span className="w-2.5 h-2.5 rounded-full bg-error" />
                <span className="px-2 py-1 rounded bg-surface-container-lowest shadow-[inset_1px_1px_3px_rgba(0,0,0,0.7)]">
                  stuck / cycle
                </span>
                <span className="w-2.5 h-2.5 rounded-full bg-primary-fixed-dim" />
                <span className="px-2 py-1 rounded bg-surface-container-lowest shadow-[inset_1px_1px_3px_rgba(0,0,0,0.7)]">
                  current Work / inspecting
                </span>
              </div>
            </section>
          )}

          {loading && (
            <section className="neo-panel flex items-center gap-3 py-16 justify-center text-on-surface-variant font-mono text-sm">
              <span className="w-2 h-2 rounded-full bg-primary animate-ping" />
              Analysing resource state…
            </section>
          )}

          {result && (
            <ResultBlock
              key={`${resultMode}-${runId}`}
              result={result}
            />
          )}
        </main>
      </div>
    </main>
  );
}

function indexKey(id: string, index: number): string {
  return `${id || "resource"}-${index}`;
}

function ResultBlock({ result }: { result: SimulationResult }) {
  const [index, setIndex] = useState(0);
  const step = result.steps[index] ?? result.steps[0];
  const state = step?.state as unknown as DeadlockState;
  const mode = state?.mode === "detection" ? "detection" : "banker";
  const isBanker = mode === "banker";
  const deadlocked = Boolean(result.metrics.deadlock);
  const safe = result.metrics.safe === undefined ? !deadlocked : Boolean(result.metrics.safe);
  const verdict = isBanker
    ? safe
      ? "Safe state"
      : "Unsafe state"
    : deadlocked
      ? "Deadlock detected"
      : "No deadlock";
  const safeSequence = metricList(result.metrics.safe_sequence);
  const cycle = metricList(result.metrics.deadlock_cycle);
  const unfinished = metricList(result.metrics.unfinished_processes);
  const waiting = metricList(result.metrics.waiting_processes);
  const waitEdges = Array.isArray(result.metrics.wait_edges)
    ? (result.metrics.wait_edges as WaitEdge[])
    : [];
  const processCount =
    state?.processes?.length ?? Number(result.metrics.process_count ?? 0);
  const resourceCount =
    state?.resources?.length ?? Number(result.metrics.resource_count ?? 0);
  const good = safe && !deadlocked;

  return (
    <section className="neo-panel flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full animate-ping ${good ? "bg-tertiary-fixed" : "bg-error"}`} />
          <h2 className="font-display font-semibold tracking-tight uppercase">
            {isBanker ? "Banker's Safety" : "Wait-For Graph"} — {isBanker ? "Safety Trace" : "Cycle Search"}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="neo-inset-sm px-3 py-1.5 font-mono text-[11px] text-on-surface-variant">
            {processCount} processes · {resourceCount} resources
          </span>
          <span
            className={`rounded-lg border px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider ${
              good
                ? "border-tertiary-fixed/40 bg-tertiary-fixed/10 text-tertiary-fixed"
                : "border-error/40 bg-error/10 text-error"
            }`}
          >
            {verdict}
          </span>
        </div>
      </div>

      <SimulationPlayer
        result={result}
        onIndex={setIndex}
        renderState={(currentStep: Step) => (
          <DeadlockStateView step={currentStep} />
        )}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <Metric
          label="Verdict"
          value={verdict}
          tone={good ? "good" : "bad"}
        />
        {isBanker ? (
          <>
            <Metric
              label="Safe sequence"
              value={safeSequence.length > 0 ? safeSequence.join(" → ") : "—"}
            />
            <Metric
              label="Finished"
              value={`${safeSequence.length} / ${processCount}`}
            />
            <Metric
              label="Unfinished"
              value={unfinished.length > 0 ? unfinished.join(", ") : "none"}
              tone={unfinished.length > 0 ? "bad" : undefined}
            />
          </>
        ) : (
          <>
            <Metric
              label="Cycle"
              value={cycle.length > 0 ? cycle.join(" → ") : "none"}
              tone={cycle.length > 0 ? "bad" : "good"}
            />
            <Metric
              label="Waiting processes"
              value={waiting.length > 0 ? waiting.join(", ") : "none"}
            />
            <Metric label="Wait-for edges" value={String(waitEdges.length)} />
          </>
        )}
      </div>

      <details className="rounded-xl bg-surface-container-low/60 p-3">
        <summary className="cursor-pointer select-none font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
          Explanation trace · {result.steps.length} step{result.steps.length === 1 ? "" : "s"}
        </summary>
        <div className="mt-3 max-h-64 overflow-auto">
          <table className="w-full text-left font-mono text-xs">
            <thead className="sticky top-0 bg-surface-container-low">
              <tr className="text-on-surface-variant uppercase tracking-wider">
                <th className="p-1.5 font-medium">#</th>
                <th className="p-1.5 font-medium">t</th>
                <th className="p-1.5 font-medium">Phase</th>
                <th className="p-1.5 font-medium">What happened</th>
              </tr>
            </thead>
            <tbody>
              {result.steps.map((traceStep, traceIndex) => {
                const traceState = traceStep.state as unknown as DeadlockState;
                return (
                  <tr
                    key={`${traceStep.tick}-${traceIndex}`}
                    className={`border-t border-surface-container-highest/60 ${
                      traceIndex === index ? "bg-primary-fixed-dim/10 text-primary" : ""
                    }`}
                  >
                    <td className="p-1.5 text-on-surface-variant">{traceIndex + 1}</td>
                    <td className="p-1.5">{traceStep.tick}</td>
                    <td className="p-1.5 uppercase text-on-surface-variant">
                      {phaseLabel(traceState.phase)}
                    </td>
                    <td className="p-1.5">{traceStep.explanation}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>

      {result.warnings.length > 0 && (
        <p className="text-sm text-tertiary-fixed-dim">{result.warnings.join(" ")}</p>
      )}
    </section>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad";
}) {
  return (
    <div className="neo-inset-sm p-3 min-w-0">
      <p className="font-mono text-[10px] uppercase text-on-surface-variant">{label}</p>
      <p
        className={`font-display font-semibold break-words ${
          tone === "good" ? "text-tertiary-fixed" : tone === "bad" ? "text-error" : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function DeadlockStateView({ step }: { step: Step }) {
  const state = step.state as unknown as DeadlockState;
  const isBanker = state.mode !== "detection";
  const resources = state.resources ?? [];
  const processes = state.processes ?? [];
  const finished = new Set(state.finished ?? []);
  const finishedCount = processes.filter((process) => finished.has(process)).length;
  const progress = processes.length > 0 ? (finishedCount / processes.length) * 100 : 0;
  const waitingCount = processes.filter(
    (process) => (state.wait_for?.[process] ?? []).length > 0,
  ).length;
  const activeCycle = state.cycle ?? [];

  return (
    <div className="flex flex-col gap-4">
      {/* Live readout */}
      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
        <span className="neo-inset-sm px-2.5 py-1 text-on-surface-variant">
          PHASE <strong className="text-primary">{phaseLabel(state.phase)}</strong>
        </span>
        <span className="neo-inset-sm px-2.5 py-1 text-on-surface-variant">
          PROCESSES <strong className="text-primary">{processes.length}</strong>
        </span>
        <span className="neo-inset-sm px-2.5 py-1 text-on-surface-variant">
          RESOURCES <strong className="text-primary">{resources.length}</strong>
        </span>
        {isBanker ? (
          <span className="neo-inset-sm px-2.5 py-1 text-on-surface-variant">
            FINISHED{" "}
            <strong className={finishedCount === processes.length ? "text-tertiary-fixed" : "text-primary"}>
              {finishedCount}/{processes.length}
            </strong>
          </span>
        ) : (
          <span className="neo-inset-sm px-2.5 py-1 text-on-surface-variant">
            WAITING <strong className="text-primary-fixed-dim">{waitingCount}</strong>
          </span>
        )}
        {state.last_executed && (
          <span className="ml-auto text-on-surface-variant">
            last executed <strong className="text-primary-fixed">{state.last_executed}</strong>
          </span>
        )}
      </div>

      {isBanker && (
        <div className="flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-container-lowest shadow-[inset_1px_1px_3px_rgba(0,0,0,0.8)]">
            <div
              className="h-full rounded-full bg-gradient-to-r from-primary-fixed-dim to-tertiary-fixed transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
            {Math.round(progress)}% finished
          </span>
        </div>
      )}

      {isBanker ? (
        <>
          <WorkVector state={state} />
          <SafetyMatrix state={state} />
          <SafeSequence
            sequence={state.safe_sequence ?? []}
            unfinished={state.unfinished ?? []}
          />
        </>
      ) : (
        <>
          <WaitForGraph state={state} cycle={activeCycle} />
          <WaitEdgeList state={state} cycle={activeCycle} />
          <WorkVector state={state} />
          <SafetyMatrix state={state} />
          {activeCycle.length > 0 && (
            <p className="rounded-lg border border-error/30 bg-error/5 p-2.5 font-mono text-[11px] text-error">
              Circular wait: {activeCycle.join(" → ")} · the processes in this cycle can never make progress.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function WorkVector({ state }: { state: DeadlockState }) {
  const resources = state.resources ?? [];
  if (resources.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
          Work · currently free instances
        </span>
        {state.last_executed && state.released && (
          <span className="font-mono text-[10px] text-on-surface-variant">
            {state.last_executed} released{" "}
            <strong className="text-tertiary-fixed">
              {formatVector(state.released, resources, true)}
            </strong>
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {resources.map((resource) => {
          const value = state.work?.[resource] ?? 0;
          const total = state.total?.[resource] ?? 0;
          return (
            <span
              key={resource}
              className="neo-inset-sm flex items-center gap-1.5 px-2.5 py-1 font-mono text-xs"
              title={`${resource}: ${value} free of ${total} total`}
            >
              <span className="text-on-surface-variant">{resource}</span>
              <span className="text-outline">=</span>
              <strong className="text-primary">{value}</strong>
              <span className="text-[9px] text-on-surface-variant">/ {total}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function SafetyMatrix({ state }: { state: DeadlockState }) {
  const resources = state.resources ?? [];
  const processes = state.processes ?? [];
  const finished = new Set(state.finished ?? []);
  const work = state.work ?? {};
  if (resources.length === 0 || processes.length === 0) return null;

  const matrixValue = (
    matrix: Record<string, Record<string, number>> | undefined,
    process: string,
    resource: string,
  ) => matrix?.[process]?.[resource] ?? 0;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
          State matrix
        </span>
        <span className="font-mono text-[10px] text-on-surface-variant">
          Need = Max − Allocation
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-surface-container-highest bg-surface-container-lowest">
        <table className="w-full min-w-[420px] border-collapse text-left font-mono text-xs">
          <thead>
            <tr className="text-on-surface-variant text-[9px] uppercase tracking-wider">
              <th rowSpan={2} className="px-2 py-1.5 font-medium">PID</th>
              <th colSpan={resources.length} className="border-l border-surface-container-highest/70 px-2 py-1.5 text-center font-medium">
                Allocation
              </th>
              <th colSpan={resources.length} className="border-l border-surface-container-highest/70 px-2 py-1.5 text-center font-medium">
                Max
              </th>
              <th colSpan={resources.length} className="border-l border-surface-container-highest/70 px-2 py-1.5 text-center font-medium">
                Need
              </th>
            </tr>
            <tr className="text-on-surface-variant/70 text-[9px]">
              {["allocation", "max", "need"].map((group) =>
                resources.map((resource, resourceIndex) => (
                  <th
                    key={`${group}-${resource}-${resourceIndex}`}
                    className={`px-2 pb-1 text-center font-medium ${
                      resourceIndex === 0 ? "border-l border-surface-container-highest/70" : ""
                    }`}
                  >
                    {resource}
                  </th>
                )),
              )}
            </tr>
          </thead>
          <tbody>
            {processes.map((process) => {
              const isFinished = finished.has(process);
              const isLast = state.last_executed === process;
              const canFinish =
                state.mode === "banker" &&
                !isFinished &&
                resources.every(
                  (resource) => matrixValue(state.need, process, resource) <= (work[resource] ?? 0),
                );

              return (
                <tr
                  key={process}
                  className={`border-t border-surface-container-highest/60 transition-colors ${
                    isLast ? "bg-primary-fixed-dim/10" : ""
                  } ${isFinished ? "opacity-40" : ""}`}
                >
                  <td className="px-2 py-1.5 font-bold text-primary-fixed-dim">
                    <span className="flex items-center gap-1">
                      {isFinished && (
                        <span className="material-symbols-outlined text-[12px] text-tertiary-fixed">
                          check
                        </span>
                      )}
                      {process}
                      {canFinish && (
                        <span
                          title="Need fits current Work"
                          className="h-1.5 w-1.5 rounded-full bg-tertiary-fixed shadow-[0_0_6px_rgba(104,252,191,0.7)]"
                        />
                      )}
                    </span>
                  </td>
                  {(["allocation", "max", "need"] as const).map((matrix) =>
                    resources.map((resource, resourceIndex) => {
                      const value = matrixValue(state[matrix], process, resource);
                      const unmet =
                        matrix === "need" &&
                        !isFinished &&
                        value > (work[resource] ?? 0);
                      return (
                        <td
                          key={`${matrix}-${resource}-${resourceIndex}`}
                          className={`px-2 py-1.5 text-center ${
                            resourceIndex === 0 ? "border-l border-surface-container-highest/60" : ""
                          } ${matrix === "need" ? "font-semibold" : ""} ${
                            unmet ? "text-error" : matrix === "need" ? "text-primary-fixed" : ""
                          }`}
                        >
                          {value}
                        </td>
                      );
                    }),
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="font-mono text-[9px] text-on-surface-variant">
        Red need cells exceed the current Work vector. A green dot marks a process whose full Need fits Work.
      </p>
    </div>
  );
}

function SafeSequence({
  sequence,
  unfinished,
}: {
  sequence: string[];
  unfinished: string[];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
          Safe sequence
        </span>
        <span className="font-mono text-[10px] text-on-surface-variant">
          {sequence.length > 0 ? `${sequence.length} cleared` : "not started"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {sequence.length === 0 && (
          <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
            no process finished yet
          </span>
        )}
        {sequence.map((process, index) => (
          <span key={`${process}-${index}`} className="flex items-center gap-1.5">
            <span className="rounded-md border border-tertiary-fixed/40 bg-tertiary-fixed/10 px-2 py-1 font-mono text-xs text-tertiary-fixed">
              {process}
            </span>
            {index < sequence.length - 1 && <span className="text-outline">→</span>}
          </span>
        ))}
      </div>
      {unfinished.length > 0 && (
        <p className="font-mono text-[10px] text-error">
          Stuck processes: {unfinished.join(", ")}
        </p>
      )}
    </div>
  );
}

function WaitForGraph({ state, cycle }: { state: DeadlockState; cycle: string[] }) {
  const graphId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const markerId = `wait-arrow-${graphId}`;
  const errorMarkerId = `wait-arrow-error-${graphId}`;
  const glowId = `wait-glow-${graphId}`;
  const processes = state.processes ?? [];
  const waitFor = state.wait_for ?? {};

  const edges = useMemo(() => {
    const knownProcesses = state.processes ?? [];
    const declared = (state.wait_edges ?? []).filter(
      (edge) =>
        knownProcesses.includes(edge.from) && knownProcesses.includes(edge.to),
    );
    if (declared.length > 0) return declared;

    const derived: WaitEdge[] = [];
    knownProcesses.forEach((from) => {
      (state.wait_for?.[from] ?? []).forEach((to) => {
        if (!knownProcesses.includes(to)) return;
        const via = (state.resources ?? []).filter(
          (resource) =>
            (state.need?.[from]?.[resource] ?? 0) > (state.work?.[resource] ?? 0) &&
            (state.allocation?.[to]?.[resource] ?? 0) > 0,
        );
        derived.push({ from, to, via });
      });
    });
    return derived;
  }, [state]);

  const cycleEdges = useMemo(() => {
    const keys = new Set<string>();
    for (let index = 0; index < cycle.length - 1; index += 1) {
      keys.add(`${cycle[index]}->${cycle[index + 1]}`);
    }
    return keys;
  }, [cycle]);
  const cycleNodes = useMemo(() => new Set(cycle.slice(0, -1)), [cycle]);

  if (processes.length === 0) return null;

  const width = 560;
  const height = 330;
  const centerX = width / 2;
  const centerY = height / 2;
  const radiusX = processes.length <= 2 ? 150 : Math.min(210, 120 + processes.length * 14);
  const radiusY = processes.length <= 2 ? 95 : 105;
  const nodeRadius = 27;

  const pointFor = (index: number) => {
    if (processes.length === 1) return { x: centerX, y: centerY };
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / processes.length;
    return {
      x: centerX + radiusX * Math.cos(angle),
      y: centerY + radiusY * Math.sin(angle),
    };
  };

  const points = new Map(processes.map((process, index) => [process, pointFor(index)]));

  const edgeGeometry = (edge: WaitEdge, edgeIndex: number) => {
    const fromPoint = points.get(edge.from);
    const toPoint = points.get(edge.to);
    if (!fromPoint || !toPoint) return null;
    const dx = toPoint.x - fromPoint.x;
    const dy = toPoint.y - fromPoint.y;
    const length = Math.hypot(dx, dy) || 1;
    const ux = dx / length;
    const uy = dy / length;
    const start = {
      x: fromPoint.x + ux * nodeRadius,
      y: fromPoint.y + uy * nodeRadius,
    };
    const end = {
      x: toPoint.x - ux * nodeRadius,
      y: toPoint.y - uy * nodeRadius,
    };
    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;
    const fromIndex = processes.indexOf(edge.from);
    const toIndex = processes.indexOf(edge.to);
    const direction = fromIndex < toIndex ? 1 : -1;
    const curvature = processes.length <= 2 ? 58 : 26;
    const control = {
      x: midX - uy * curvature * direction,
      y: midY + ux * curvature * direction,
    };

    const label = edge.via.length > 0 ? edge.via.join("+") : "waits";
    const labelWidth = Math.max(30, label.length * 5.6 + 10);
    return {
      path: `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`,
      control,
      label,
      labelWidth,
      onCycle: cycleEdges.has(`${edge.from}->${edge.to}`),
      key: `${edge.from}-${edge.to}-${edgeIndex}`,
    };
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
          Wait-for graph
        </span>
        <span className="font-mono text-[10px] text-on-surface-variant">
          {edges.length} edge{edges.length === 1 ? "" : "s"} ·{" "}
          {processes.filter((process) => (waitFor[process] ?? []).length > 0).length} waiting
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-surface-container-highest bg-[#0c0e12]">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-auto w-full min-w-[430px]"
          role="img"
          aria-label={`Wait-for graph with ${processes.length} processes and ${edges.length} wait edges`}
        >
          <defs>
            <marker
              id={markerId}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#00dbe9" />
            </marker>
            <marker
              id={errorMarkerId}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#ffb4ab" />
            </marker>
            <filter id={glowId} x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Faint guide ellipse */}
          <ellipse
            cx={centerX}
            cy={centerY}
            rx={radiusX + 12}
            ry={radiusY + 12}
            fill="none"
            stroke="rgba(255,255,255,0.06)"
            strokeDasharray="4 8"
          />

          {/* Edges */}
          {edges.map((edge, edgeIndex) => {
            const geometry = edgeGeometry(edge, edgeIndex);
            if (!geometry) return null;
            return (
              <g key={geometry.key}>
                <path
                  d={geometry.path}
                  fill="none"
                  stroke={geometry.onCycle ? "#ffb4ab" : "rgba(0,219,233,0.7)"}
                  strokeWidth={geometry.onCycle ? 2.4 : 1.8}
                  strokeLinecap="round"
                  markerEnd={`url(#${geometry.onCycle ? errorMarkerId : markerId})`}
                  filter={geometry.onCycle ? `url(#${glowId})` : undefined}
                />
                <rect
                  x={geometry.control.x - geometry.labelWidth / 2}
                  y={geometry.control.y - 7}
                  width={geometry.labelWidth}
                  height={14}
                  rx={3}
                  fill="#0c0e12"
                  opacity={0.9}
                />
                <text
                  x={geometry.control.x}
                  y={geometry.control.y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill={geometry.onCycle ? "#ffb4ab" : "#b9cacb"}
                  fontSize="9"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {geometry.label}
                </text>
              </g>
            );
          })}

          {/* Nodes */}
          {processes.map((process) => {
            const point = points.get(process);
            if (!point) return null;
            const inspecting = state.inspecting === process;
            const inCycle = cycleNodes.has(process);
            const waiting = (waitFor[process] ?? []).length > 0;
            const stroke = inCycle
              ? "#ffb4ab"
              : inspecting
                ? "#00f0ff"
                : waiting
                  ? "#68fcbf"
                  : "#3b494b";
            const targets = (waitFor[process] ?? []).join(", ");
            return (
              <g key={process}>
                {inspecting && (
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={nodeRadius + 6}
                    fill="none"
                    stroke="#00f0ff"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                    opacity="0.7"
                  />
                )}
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={nodeRadius}
                  fill="#1a1c20"
                  stroke={stroke}
                  strokeWidth={inCycle || inspecting ? 2.4 : 1.6}
                  filter={inspecting || inCycle ? `url(#${glowId})` : undefined}
                >
                  <title>
                    {process}
                    {targets ? ` waits for ${targets}` : " is not waiting"}
                  </title>
                </circle>
                <text
                  x={point.x}
                  y={point.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill={inCycle ? "#ffb4ab" : inspecting ? "#dbfcff" : "#e2e2e8"}
                  fontSize="12"
                  fontWeight="700"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {process}
                </text>
                <text
                  x={point.x}
                  y={point.y + nodeRadius + 12}
                  textAnchor="middle"
                  fill="#849495"
                  fontSize="8"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {waiting ? "waiting" : "not waiting"}
                </text>
              </g>
            );
          })}

          {edges.length === 0 && (
            <text
              x={centerX}
              y={height - 18}
              textAnchor="middle"
              fill="#849495"
              fontSize="10"
              fontFamily="JetBrains Mono, monospace"
            >
              no wait-for edges yet
            </text>
          )}
        </svg>
      </div>

      <div className="flex flex-wrap items-center gap-3 font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full border border-primary-fixed-dim" />
          inspecting
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full border border-tertiary-fixed" />
          waiting
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full border border-error" />
          cycle
        </span>
        <span className="flex items-center gap-1 text-primary-fixed-dim">
          <span className="text-[12px]">→</span> waits for
        </span>
      </div>
    </div>
  );
}

function WaitEdgeList({ state, cycle }: { state: DeadlockState; cycle: string[] }) {
  const processes = state.processes ?? [];
  const edges = state.wait_edges ?? [];
  const cycleEdges = new Set<string>();
  for (let index = 0; index < cycle.length - 1; index += 1) {
    cycleEdges.add(`${cycle[index]}->${cycle[index + 1]}`);
  }
  const waiting = processes.filter((process) => (state.wait_for?.[process] ?? []).length > 0);
  const idle = processes.filter((process) => (state.wait_for?.[process] ?? []).length === 0);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
          Wait-for edges ({edges.length})
        </span>
        <div className="flex flex-col gap-1">
          {edges.length === 0 && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-tertiary-fixed-dim">
              none yet
            </span>
          )}
          {edges.map((edge, index) => {
            const onCycle = cycleEdges.has(`${edge.from}->${edge.to}`);
            return (
              <div
                key={`${edge.from}-${edge.to}-${index}`}
                className={`flex items-center gap-2 rounded-md border px-2 py-1 font-mono text-xs ${
                  onCycle
                    ? "border-error/40 bg-error/10 text-error"
                    : "border-surface-container-highest bg-surface-container-high/50 text-on-surface-variant"
                }`}
              >
                <span className={onCycle ? "text-error" : "text-primary-fixed-dim"}>{edge.from}</span>
                <span>→</span>
                <span className={onCycle ? "text-error" : "text-primary-fixed-dim"}>{edge.to}</span>
                <span className="ml-auto text-[10px]">
                  {edge.via.length > 0 ? `via ${edge.via.join("+")}` : "resource"}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
          Process status
        </span>
        <div className="flex flex-col gap-1">
          <p className="font-mono text-[10px] text-tertiary-fixed-dim">
            waiting: {waiting.length > 0 ? waiting.join(", ") : "none"}
          </p>
          <p className="font-mono text-[10px] text-on-surface-variant">
            no outgoing edge: {idle.length > 0 ? idle.join(", ") : "none"}
          </p>
          {cycle.length > 0 && (
            <p className="font-mono text-[10px] text-error">cycle: {cycle.join(" → ")}</p>
          )}
        </div>
      </div>
    </div>
  );
}
