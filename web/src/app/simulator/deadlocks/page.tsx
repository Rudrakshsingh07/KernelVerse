"use client";

import { useEffect, useMemo, useState } from "react";
import SimulationPlayer from "@/components/SimulationPlayer";
import type { SimulationResult, Step } from "@/lib/types";

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
  phase?: string;
  note?: string;
  safe_sequence?: string[];
  finished?: string[];
  unfinished?: string[];
  last_executed?: string;
  work_before?: Record<string, number>;
  released?: Record<string, number>;
  deadlock?: boolean;
}

const DEFAULT_RESOURCES: ResourceRow[] = [
  { id: "A", total: 10, available: 3 },
  { id: "B", total: 5, available: 3 },
  { id: "C", total: 7, available: 2 },
];

const DEFAULT_PROCESSES: ProcessRow[] = [
  { id: "P0", alloc: [0, 1, 0], max: [7, 5, 3] },
  { id: "P1", alloc: [2, 0, 0], max: [3, 2, 2] },
  { id: "P2", alloc: [3, 0, 2], max: [9, 0, 2] },
  { id: "P3", alloc: [2, 1, 1], max: [2, 2, 2] },
  { id: "P4", alloc: [0, 0, 2], max: [4, 3, 3] },
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
): { resources: ResourceRow[]; processes: ProcessRow[] } | null {
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
      id: typeof row.id === "string" && row.id.trim() ? row.id : `P${index}`,
      alloc: normalizeArray(row.alloc, resources.length),
      max: normalizeArray(row.max, resources.length),
    }));

  if (resources.length === 0 || processes.length === 0) return null;
  return { resources, processes };
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
    case "complete":
      return "complete";
    case "stuck":
      return "stuck";
    default:
      return "initial";
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function sequenceList(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string[] =>
      Array.isArray(item) && item.every((process) => typeof process === "string"),
  );
}

export default function DeadlocksPage() {
  const [resources, setResources] = useState<ResourceRow[]>(cloneResources(DEFAULT_RESOURCES));
  const [processes, setProcesses] = useState<ProcessRow[]>(cloneProcesses(DEFAULT_PROCESSES));
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [runId, setRunId] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect -- restore the saved editor state after mount */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = restoreSavedState(JSON.parse(raw));
      if (saved) {
        setResources(saved.resources);
        setProcesses(saved.processes);
      }
    } catch {
      // Ignore malformed storage and keep the built-in default state.
    }
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ resources, processes }));
    } catch {
      // Storage can be unavailable (private mode / quota); persistence is optional.
    }
  }, [resources, processes]);

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

  const resultSafe = result
    ? result.metrics.safe === undefined
      ? !Boolean(result.metrics.deadlock)
      : Boolean(result.metrics.safe)
    : false;

  const headerStatus = !result ? "Not run" : resultSafe ? "Safe state" : "Unsafe state";

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
            mode: "banker",
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
      <header className="flex flex-col justify-between gap-4 rounded-xl bg-surface-container p-4 shadow-[6px_6px_14px_rgba(0,0,0,0.65),-5px_-5px_12px_rgba(255,255,255,0.04)] xl:flex-row xl:items-center">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2 rounded-lg bg-surface-container-lowest px-4 py-1.5 shadow-[inset_3px_3px_7px_rgba(0,0,0,0.7)]">
            <span className="material-symbols-outlined text-base text-primary-fixed-dim">lock</span>
            <span className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">Subsystem</span>
            <span className="text-on-surface-variant">/</span>
            <span className="font-display text-sm font-medium text-primary">Deadlocks</span>
            <span className="material-symbols-outlined text-sm text-outline">chevron_right</span>
            <span className="font-mono text-xs font-semibold text-primary-fixed">
              Banker&apos;s Algorithm — {headerStatus}
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

      {/* Workload input: every process is edited in one dominant table. */}
      <section className="neo-panel flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="material-symbols-outlined text-lg text-primary-fixed-dim">table_chart</span>
              <h2 className="font-display font-semibold tracking-tight">Process Workload</h2>
              <span className="rounded bg-surface-container-lowest px-2 py-0.5 font-mono text-[11px] text-on-surface-variant shadow-[inset_1px_1px_3px_rgba(0,0,0,0.7)]">
                {processes.length} process{processes.length === 1 ? "" : "es"} ·{" "}
                {resources.length} resource{resources.length === 1 ? "" : "s"}
              </span>
              <span className="rounded bg-surface-container-lowest px-2 py-0.5 font-mono text-[11px] text-on-surface-variant shadow-[inset_1px_1px_3px_rgba(0,0,0,0.7)]">
                [AVOIDANCE]
              </span>
            </div>
            <p className="font-mono text-[10px] leading-relaxed text-on-surface-variant">
              Edit any cell directly. Need is derived as{" "}
              <span className="text-primary-fixed-dim">Max − Allocation</span>; keep
              allocation ≤ max and available + all allocated instances ≤ total.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={addResource}
              className="neo-btn flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium hover:text-primary"
            >
              <span className="material-symbols-outlined text-base">add_circle</span>
              Add Resource
            </button>
            <button
              onClick={addProcess}
              className="neo-btn flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium hover:text-primary"
            >
              <span className="material-symbols-outlined text-base">add_circle</span>
              Add Process
            </button>
            <button
              onClick={randomizeState}
              className="neo-btn flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium hover:text-secondary"
            >
              <span className="material-symbols-outlined text-base">shuffle</span>
              Randomize
            </button>
          </div>
        </div>

        {/* Resource definitions live on a compact strip so the process table
            stays the single place where process data is entered. */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-container-low px-3 py-2.5">
          <span className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
            Resources
          </span>
          {resources.map((resource, index) => (
            <div
              key={index}
              className="neo-inset-sm flex items-center gap-2 px-2 py-1.5"
            >
              <input
                aria-label={`Resource ${index + 1} ID`}
                className="neo-input w-12 text-center font-bold text-primary-fixed"
                value={resource.id}
                onChange={(event) => updateResource(index, "id", event.target.value)}
              />
              <label className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
                total
                <input
                  aria-label={`${resource.id || `Resource ${index + 1}`} total instances`}
                  type="number"
                  min={1}
                  className="neo-input w-16 text-center"
                  value={resource.total}
                  onChange={(event) => updateResource(index, "total", event.target.value)}
                />
              </label>
              <label className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
                avail
                <input
                  aria-label={`${resource.id || `Resource ${index + 1}`} available instances`}
                  type="number"
                  min={0}
                  className="neo-input w-16 text-center"
                  value={resource.available}
                  onChange={(event) => updateResource(index, "available", event.target.value)}
                />
              </label>
              <button
                onClick={() => removeResource(index)}
                disabled={resources.length === 1}
                title="Remove resource"
                className="text-xs text-error disabled:opacity-30"
              >
                ✕
              </button>
            </div>
          ))}
          <span className="ml-auto font-mono text-[10px] text-on-surface-variant">
            total = available + held
          </span>
        </div>

        {/* Single direct-input table: PID + Allocation + Max + derived Need. */}
        <div className="neo-inset overflow-x-auto p-2">
          <table className="w-full border-collapse text-left font-mono text-sm">
            <thead className="sticky top-0 z-10 bg-[#0c0e12]">
              <tr className="text-[11px] uppercase tracking-wider text-on-surface-variant">
                <th rowSpan={2} className="px-3 py-3 font-medium">PID</th>
                <th
                  colSpan={Math.max(resources.length, 1)}
                  className="border-l border-surface-container-highest/70 px-3 py-3 text-center font-medium"
                >
                  Allocation
                </th>
                <th
                  colSpan={Math.max(resources.length, 1)}
                  className="border-l border-surface-container-highest/70 px-3 py-3 text-center font-medium"
                >
                  Max
                </th>
                <th
                  colSpan={Math.max(resources.length, 1)}
                  className="border-l border-surface-container-highest/70 px-3 py-3 text-center font-medium"
                >
                  Need
                </th>
                <th rowSpan={2} className="px-3 py-3 text-right font-medium">Remove</th>
              </tr>
              <tr className="text-[9px] text-on-surface-variant/70">
                {(["allocation", "max", "need"] as const).map((group) =>
                  resources.map((resource, resourceIndex) => (
                    <th
                      key={`${group}-${resource.id}-${resourceIndex}`}
                      className={`px-2 pb-2 text-center font-medium ${
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
                <tr
                  key={processIndex}
                  className="border-t border-surface-container-highest/70 transition-colors hover:bg-surface-container-high/40"
                >
                  <td className="px-3 py-2.5">
                    <input
                      aria-label={`Process ${processIndex + 1} ID`}
                      className="neo-input w-20 font-bold text-primary-fixed"
                      value={process.id}
                      onChange={(event) => updateProcessId(processIndex, event.target.value)}
                    />
                  </td>
                  {resources.map((resource, resourceIndex) => (
                    <td key={`alloc-${resourceIndex}`} className="px-2 py-2.5 text-center">
                      <input
                        aria-label={`${process.id || `Process ${processIndex + 1}`} allocation of ${resource.id || `resource ${resourceIndex + 1}`}`}
                        type="number"
                        min={0}
                        className="neo-input w-16 text-center"
                        value={process.alloc[resourceIndex] ?? 0}
                        onChange={(event) =>
                          updateProcessCell(processIndex, "alloc", resourceIndex, event.target.value)
                        }
                      />
                    </td>
                  ))}
                  {resources.map((resource, resourceIndex) => (
                    <td
                      key={`max-${resourceIndex}`}
                      className={`px-2 py-2.5 text-center ${
                        resourceIndex === 0 ? "border-l border-surface-container-highest/30" : ""
                      }`}
                    >
                      <input
                        aria-label={`${process.id || `Process ${processIndex + 1}`} maximum of ${resource.id || `resource ${resourceIndex + 1}`}`}
                        type="number"
                        min={0}
                        className="neo-input w-16 text-center"
                        value={process.max[resourceIndex] ?? 0}
                        onChange={(event) =>
                          updateProcessCell(processIndex, "max", resourceIndex, event.target.value)
                        }
                      />
                    </td>
                  ))}
                  {resources.map((_, resourceIndex) => {
                    const need = Math.max(
                      0,
                      (process.max[resourceIndex] ?? 0) - (process.alloc[resourceIndex] ?? 0),
                    );
                    return (
                      <td
                        key={`need-${resourceIndex}`}
                        className={`px-2 py-2.5 text-center font-semibold ${
                          resourceIndex === 0 ? "border-l border-surface-container-highest/30" : ""
                        } ${
                          need === 0 ? "text-on-surface-variant/40" : "text-primary-fixed"
                        }`}
                      >
                        {need}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2.5 text-right">
                    <button
                      onClick={() => removeProcess(processIndex)}
                      disabled={processes.length === 1}
                      title="Remove process"
                      className="text-xs text-error disabled:opacity-30"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

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

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-error/40 bg-error/10 p-4 text-sm text-error">
          <span className="material-symbols-outlined text-lg">error</span>
          <p>{error}</p>
        </div>
      )}

      {!result && !loading && <EmptyState />}

      {loading && (
        <section className="neo-panel flex items-center justify-center gap-3 py-16 font-mono text-sm text-on-surface-variant">
          <span className="h-2 w-2 animate-ping rounded-full bg-primary" />
          Checking every safe ordering…
        </section>
      )}

      {result && <ResultBlock key={`banker-${runId}`} result={result} />}
    </main>
  );
}

function EmptyState() {
  return (
    <section className="neo-panel flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-primary-fixed-dim">verified_user</span>
        <h2 className="font-display font-semibold tracking-tight">
          Banker&apos;s safety check — ready to analyse
        </h2>
      </div>
      <p className="max-w-2xl text-sm text-on-surface-variant">
        Banker&apos;s algorithm asks whether at least one ordering exists in which
        every process can finish. Each step selects a process whose remaining need
        fits the current Work vector, runs it, and returns its allocation to Work.
        The result panel then shows every possible safe sequence.
      </p>

      <ol className="grid grid-cols-1 gap-2 md:grid-cols-3">
        {[
          ["Compute need", "Need = Max − Allocation for every process and resource."],
          ["Run a process", "Find Need ≤ Work, then add its allocation back to Work."],
          ["Decide", "All processes finish ⇒ safe. Otherwise the state is unsafe."],
        ].map(([title, description], index) => (
          <li key={title} className="neo-inset-sm flex flex-col gap-1 p-3">
            <span className="font-mono text-[10px] uppercase tracking-wider text-primary-fixed-dim">
              0{index + 1} · {title}
            </span>
            <span className="text-[11px] leading-snug text-on-surface-variant">{description}</span>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
        <span className="h-2.5 w-2.5 rounded-full bg-tertiary-fixed" />
        <span className="rounded bg-surface-container-lowest px-2 py-1 shadow-[inset_1px_1px_3px_rgba(0,0,0,0.7)]">
          safe / finished
        </span>
        <span className="h-2.5 w-2.5 rounded-full bg-error" />
        <span className="rounded bg-surface-container-lowest px-2 py-1 shadow-[inset_1px_1px_3px_rgba(0,0,0,0.7)]">
          stuck
        </span>
        <span className="h-2.5 w-2.5 rounded-full bg-primary-fixed-dim" />
        <span className="rounded bg-surface-container-lowest px-2 py-1 shadow-[inset_1px_1px_3px_rgba(0,0,0,0.7)]">
          current Work
        </span>
      </div>
    </section>
  );
}

function ResultBlock({ result }: { result: SimulationResult }) {
  const [index, setIndex] = useState(0);
  const step = result.steps[index] ?? result.steps[0];
  const state = step?.state as unknown as DeadlockState;
  const safe = result.metrics.safe === undefined ? !Boolean(result.metrics.deadlock) : Boolean(result.metrics.safe);
  const safeSequence = stringList(result.metrics.safe_sequence);
  const allSequences = sequenceList(result.metrics.safe_sequences);
  const sequences = allSequences.length > 0 ? allSequences : safeSequence.length > 0 ? [safeSequence] : [];
  const unfinished = stringList(result.metrics.unfinished_processes);
  const processCount = state?.processes?.length ?? Number(result.metrics.process_count ?? 0);
  const resourceCount = state?.resources?.length ?? Number(result.metrics.resource_count ?? 0);
  const truncated = Boolean(result.metrics.safe_sequences_truncated);

  return (
    <section className="neo-panel flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 animate-ping rounded-full ${safe ? "bg-tertiary-fixed" : "bg-error"}`} />
          <h2 className="font-display font-semibold uppercase tracking-tight">
            Banker&apos;s Safety — Solution &amp; Trace
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="neo-inset-sm px-3 py-1.5 font-mono text-[11px] text-on-surface-variant">
            {processCount} processes · {resourceCount} resources
          </span>
          <span
            className={`rounded-lg border px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider ${
              safe
                ? "border-tertiary-fixed/40 bg-tertiary-fixed/10 text-tertiary-fixed"
                : "border-error/40 bg-error/10 text-error"
            }`}
          >
            {safe ? "Safe state" : "Unsafe state"}
          </span>
        </div>
      </div>

      {/* Solution first: the verdict and every safe ordering are immediately
          readable, instead of only appearing after the trace finishes. */}
      <div
        className={`rounded-xl border p-3 ${
          safe
            ? "border-tertiary-fixed/30 bg-tertiary-fixed/5"
            : "border-error/30 bg-error/5"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className={`font-display text-xl font-semibold ${safe ? "text-tertiary-fixed" : "text-error"}`}>
              {safe ? "Solution found — the state is safe" : "No safe sequence exists"}
            </p>
            <p className="font-mono text-xs text-on-surface-variant">
              {safe
                ? `${sequences.length} possible safe sequence${sequences.length === 1 ? "" : "s"}${
                    truncated ? " (search capped)" : ""
                  }`
                : `Stuck process${unfinished.length === 1 ? "" : "es"}: ${
                    unfinished.length > 0 ? unfinished.join(", ") : "none"
                  }`}
            </p>
          </div>
          <span className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
            all safe sequences
          </span>
        </div>

        {sequences.length > 0 ? (
          <div className="mt-3 grid max-h-96 grid-cols-1 gap-2 overflow-auto pr-1 xl:grid-cols-2">
            {sequences.map((sequence, sequenceIndex) => (
              <div
                key={`${sequence.join("-")}-${sequenceIndex}`}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-surface-container-highest bg-surface-container-lowest px-3 py-2 font-mono"
              >
                <span className="shrink-0 text-xs font-medium text-on-surface-variant">
                  {sequenceIndex + 1}
                </span>
                {sequence.map((process, processIndex) => (
                  <span key={`${process}-${processIndex}`} className="flex items-center gap-2">
                    <span className="rounded bg-tertiary-fixed/10 px-2.5 py-1 text-base font-semibold text-tertiary-fixed sm:text-lg">
                      {process}
                    </span>
                    {processIndex < sequence.length - 1 && (
                      <span className="text-base text-outline">→</span>
                    )}
                  </span>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 font-mono text-sm text-error">
            Every process needs more resources than Work can provide, so no ordering
            can finish them all. This state is unsafe for deadlock avoidance.
          </p>
        )}
      </div>

      <SimulationPlayer
        result={result}
        onIndex={setIndex}
        renderState={(currentStep: Step) => <DeadlockStateView step={currentStep} />}
      />

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Metric label="Verdict" value={safe ? "Safe" : "Unsafe"} tone={safe ? "good" : "bad"} />
        <Metric label="Safe sequences" value={String(sequences.length)} />
        <Metric label="Finished" value={`${safeSequence.length} / ${processCount}`} />
        <Metric
          label="Unfinished"
          value={unfinished.length > 0 ? unfinished.join(", ") : "none"}
          tone={unfinished.length > 0 ? "bad" : undefined}
        />
      </div>

      <details className="rounded-xl bg-surface-container-low/60 p-3">
        <summary className="cursor-pointer select-none font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
          Explanation trace · {result.steps.length} step{result.steps.length === 1 ? "" : "s"}
        </summary>
        <div className="mt-3 max-h-64 overflow-auto">
          <table className="w-full text-left font-mono text-xs">
            <thead className="sticky top-0 bg-surface-container-low">
              <tr className="uppercase tracking-wider text-on-surface-variant">
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
    <div className="neo-inset-sm min-w-0 p-3">
      <p className="font-mono text-[10px] uppercase text-on-surface-variant">{label}</p>
      <p
        className={`break-words font-display font-semibold ${
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
  const resources = state.resources ?? [];
  const processes = state.processes ?? [];
  const finished = new Set(state.finished ?? []);
  const finishedCount = processes.filter((process) => finished.has(process)).length;
  const progress = processes.length > 0 ? (finishedCount / processes.length) * 100 : 0;

  return (
    <div className="flex flex-col gap-4">
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
        <span className="neo-inset-sm px-2.5 py-1 text-on-surface-variant">
          FINISHED{" "}
          <strong className={finishedCount === processes.length ? "text-tertiary-fixed" : "text-primary"}>
            {finishedCount}/{processes.length}
          </strong>
        </span>
        {state.last_executed && (
          <span className="ml-auto text-on-surface-variant">
            last executed <strong className="text-primary-fixed">{state.last_executed}</strong>
          </span>
        )}
      </div>

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

      <WorkVector state={state} />
      <SafetyMatrix state={state} />
      <SafeSequence sequence={state.safe_sequence ?? []} unfinished={state.unfinished ?? []} />
    </div>
  );
}

function WorkVector({ state }: { state: DeadlockState }) {
  const resources = state.resources ?? [];
  if (resources.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-sm uppercase tracking-wider text-on-surface-variant">
          Work · currently free instances
        </span>
        {state.last_executed && state.released && (
          <span className="font-mono text-sm text-on-surface-variant">
            {state.last_executed} released{" "}
            <strong className="text-tertiary-fixed">
              {formatVector(state.released, resources, true)}
            </strong>
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {resources.map((resource) => {
          const value = state.work?.[resource] ?? 0;
          const total = state.total?.[resource] ?? 0;
          return (
            <span
              key={resource}
              className="neo-inset-sm flex items-center gap-2 px-3 py-1.5 font-mono text-base"
              title={`${resource}: ${value} free of ${total} total`}
            >
              <span className="text-on-surface-variant">{resource}</span>
              <span className="text-outline">=</span>
              <strong className="text-lg text-primary">{value}</strong>
              <span className="text-xs text-on-surface-variant">/ {total}</span>
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
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-sm uppercase tracking-wider text-on-surface-variant">
          State matrix
        </span>
        <span className="font-mono text-sm text-on-surface-variant">
          Need = Max − Allocation
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-surface-container-highest bg-surface-container-lowest">
        <table className="w-full min-w-[560px] border-collapse text-left font-mono text-base sm:text-lg">
          <thead>
            <tr className="text-xs uppercase tracking-wider text-on-surface-variant sm:text-sm">
              <th rowSpan={2} className="px-3 py-2.5 font-medium">PID</th>
              <th colSpan={resources.length} className="border-l border-surface-container-highest/70 px-3 py-2.5 text-center font-medium">
                Allocation
              </th>
              <th colSpan={resources.length} className="border-l border-surface-container-highest/70 px-3 py-2.5 text-center font-medium">
                Max
              </th>
              <th colSpan={resources.length} className="border-l border-surface-container-highest/70 px-3 py-2.5 text-center font-medium">
                Need
              </th>
            </tr>
            <tr className="text-xs text-on-surface-variant/70 sm:text-sm">
              {["allocation", "max", "need"].map((group) =>
                resources.map((resource, resourceIndex) => (
                  <th
                    key={`${group}-${resource}-${resourceIndex}`}
                    className={`px-3 pb-2 text-center font-medium ${
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
                  <td className="px-3 py-2.5 font-bold text-primary-fixed-dim">
                    <span className="flex items-center gap-1.5">
                      {isFinished && (
                        <span className="material-symbols-outlined text-base text-tertiary-fixed">
                          check
                        </span>
                      )}
                      {process}
                      {canFinish && (
                        <span
                          title="Need fits current Work"
                          className="h-2 w-2 rounded-full bg-tertiary-fixed shadow-[0_0_6px_rgba(104,252,191,0.7)]"
                        />
                      )}
                    </span>
                  </td>
                  {(["allocation", "max", "need"] as const).map((matrix) =>
                    resources.map((resource, resourceIndex) => {
                      const value = matrixValue(state[matrix], process, resource);
                      const unmet =
                        matrix === "need" && !isFinished && value > (work[resource] ?? 0);
                      return (
                        <td
                          key={`${matrix}-${resource}-${resourceIndex}`}
                          className={`px-3 py-2.5 text-center ${
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
      <p className="font-mono text-xs text-on-surface-variant sm:text-sm">
        Red need cells exceed the current Work vector. A green dot marks a process
        whose full Need fits Work.
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
          Selected path so far
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
