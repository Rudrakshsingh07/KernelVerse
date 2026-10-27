"use client";

import { useEffect, useId, useMemo, useState } from "react";
import SimulationPlayer from "@/components/SimulationPlayer";
import type { SimulationResult, Step } from "@/lib/types";

const ALGS = [
  { id: "fcfs", label: "FCFS", desc: "Serve requests in arrival order" },
  { id: "sstf", label: "SSTF", desc: "Always take the closest request" },
  { id: "scan", label: "SCAN", desc: "Elevator sweep to the disk edge" },
  { id: "cscan", label: "C-SCAN", desc: "Sweep, wrap, and repeat" },
  { id: "look", label: "LOOK", desc: "Reverse at the last request" },
] as const;

const DEFAULT_REQUESTS = "98, 183, 37, 122, 14, 124, 65, 67";

const STORAGE_KEY = "kv:disk-scheduling";

interface DiskState {
  algorithm: string;
  head: number;
  direction: string;
  disk_size: number;
  requests: number[];
  remaining: number[];
  served: number[];
  sequence: number[];
  seek_distances: number[];
  total_seek: number;
  total_requests: number;
  last_served: number | null;
  seek_distance: number;
  head_from: number;
  head_to: number;
  last_move_kind: string;
  is_service: boolean;
  note: string;
}

interface ResultEntry {
  algorithm: string;
  result: SimulationResult;
}

function parseRequests(text: string): number[] {
  return text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
}

function labelFor(id: string): string {
  return ALGS.find((algorithm) => algorithm.id === id)?.label ?? id.toUpperCase();
}

function countValues(values: number[]): Record<number, number> {
  return values.reduce<Record<number, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

export default function DiskSchedulingPage() {
  const [algorithm, setAlgorithm] = useState<string>(ALGS[0].id);
  const [head, setHead] = useState(53);
  const [diskSize, setDiskSize] = useState(200);
  const [requestsText, setRequestsText] = useState(DEFAULT_REQUESTS);
  const [requestCount, setRequestCount] = useState("8");
  const [results, setResults] = useState<ResultEntry[]>([]);
  const [runId, setRunId] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (
          typeof saved.algorithm === "string" &&
          ALGS.some((candidate) => candidate.id === saved.algorithm)
        ) {
          setAlgorithm(saved.algorithm);
        } else if (Array.isArray(saved.algorithms)) {
          const known = saved.algorithms.find((id: unknown): id is string =>
            ALGS.some((candidate) => candidate.id === id),
          );
          if (known) setAlgorithm(known);
        }
        if (Number.isInteger(saved.head)) setHead(saved.head);
        if (Number.isInteger(saved.diskSize)) setDiskSize(saved.diskSize);
        if (typeof saved.requestsText === "string") setRequestsText(saved.requestsText);
        if (typeof saved.requestCount === "string" && /^\d+$/.test(saved.requestCount)) {
          setRequestCount(saved.requestCount);
        }
      }
    } catch {
      // Ignore malformed local storage and keep the defaults.
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ algorithm, head, diskSize, requestsText, requestCount }),
      );
    } catch {
      // Storage can be unavailable (private mode / quota); persistence is optional.
    }
  }, [algorithm, head, diskSize, requestsText, requestCount]);

  const parsedRequests = useMemo(() => parseRequests(requestsText), [requestsText]);

  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    if (!Number.isInteger(head) || head < 0) {
      errors.push("Head position must be a non-negative integer.");
    }
    if (!Number.isInteger(diskSize) || diskSize < 1) {
      errors.push("Disk size must be a positive integer.");
    }
    if (Number.isInteger(head) && Number.isInteger(diskSize) && head >= diskSize) {
      errors.push("Head position must be inside the disk (0 to disk size − 1).");
    }
    if (parsedRequests.length === 0) {
      errors.push("Enter at least one I/O request.");
    } else {
      const invalid = parsedRequests.filter(
        (request) =>
          !Number.isInteger(request) ||
          request < 0 ||
          (Number.isInteger(diskSize) && request >= diskSize),
      );
      if (invalid.length > 0) {
        errors.push(`Requests must be integers between 0 and ${Math.max(diskSize - 1, 0)}.`);
      }
    }
    return errors;
  }, [head, diskSize, parsedRequests]);

  const activeLabel = labelFor(algorithm);

  const uniqueRequestCount = new Set(parsedRequests.filter(Number.isFinite)).size;

  function generateRandomRequests() {
    const count = Number.parseInt(requestCount, 10);
    if (!Number.isInteger(count) || count < 1) {
      setError("Enter a positive whole number of requests to generate.");
      return;
    }
    const size = Number.isInteger(diskSize) && diskSize >= 1 ? diskSize : 200;
    if (size !== diskSize) setDiskSize(size);
    const nextRequests = Array.from({ length: count }, () => Math.floor(Math.random() * size));
    setRequestsText(nextRequests.join(", "));
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
      const res = await fetch(`${api}/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: "disk-scheduling",
          payload: {
            algorithm,
            head,
            disk_size: diskSize,
            requests: parsedRequests,
          },
        }),
      });

      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        const message = Array.isArray(detail.detail)
          ? detail.detail.join(", ")
          : detail.detail ?? res.statusText;
        throw new Error(`${labelFor(algorithm)}: ${message}`);
      }

      const result = (await res.json()) as SimulationResult;
      setResults([{ algorithm, result }]);
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
            <span className="material-symbols-outlined text-primary-fixed-dim text-base">storage</span>
            <span className="font-mono text-[11px] text-on-surface-variant uppercase tracking-wider">Subsystem</span>
            <span className="text-on-surface-variant">/</span>
            <span className="font-display text-sm text-primary font-medium">Disk Scheduling</span>
            <span className="material-symbols-outlined text-outline text-sm">chevron_right</span>
            <span className="font-mono text-xs text-primary-fixed font-semibold">
              {activeLabel} — Seek Trace
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
        {/* LEFT: Parameters + workload */}
        <aside className="xl:col-span-4 flex flex-col gap-6">
          <section className="neo-panel flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary-fixed-dim text-lg">tune</span>
                <h2 className="font-display font-semibold tracking-tight">Parameters</h2>
              </div>
              <span className="px-2 py-0.5 rounded font-mono text-[11px] bg-surface-container-lowest text-on-surface-variant shadow-[inset_1px_1px_3px_rgba(0,0,0,0.7)]">
                [DISK CONTROLLER]
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
                Scheduling Algorithm
              </label>
              <div className="flex flex-wrap gap-1.5">
                {ALGS.map((candidate) => {
                  const selected = algorithm === candidate.id;
                  return (
                    <button
                      key={candidate.id}
                      onClick={() => setAlgorithm(candidate.id)}
                      aria-pressed={selected}
                      title={candidate.desc}
                      className={`px-3 py-1.5 rounded-lg font-mono text-xs transition-all ${
                        selected
                          ? "bg-surface-container-lowest text-primary shadow-[inset_2px_2px_5px_rgba(0,0,0,0.8)]"
                          : "bg-surface-container-low text-on-surface-variant neo-btn"
                      }`}
                    >
                      {candidate.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="disk-head" className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
                  Head Position
                </label>
                <input
                  id="disk-head"
                  type="number"
                  min={0}
                  className="neo-input w-full px-3 py-2"
                  value={head}
                  onChange={(event) => setHead(Number(event.target.value))}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="disk-size" className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
                  Disk Size
                </label>
                <input
                  id="disk-size"
                  type="number"
                  min={1}
                  className="neo-input w-full px-3 py-2"
                  value={diskSize}
                  onChange={(event) => setDiskSize(Number(event.target.value))}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="disk-requests" className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
                I/O Requests (comma/space separated)
              </label>
              <input
                id="disk-requests"
                className="neo-input w-full px-3 py-2 font-mono text-sm"
                value={requestsText}
                onChange={(event) => setRequestsText(event.target.value)}
                placeholder="98, 183, 37, 122"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="request-count" className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
                Number of Random Requests
              </label>
              <div className="flex gap-2">
                <input
                  id="request-count"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  className="neo-input min-w-0 flex-1 px-3 py-2 font-mono text-sm"
                  value={requestCount}
                  onChange={(event) => setRequestCount(event.target.value.replace(/\D/g, ""))}
                  placeholder="8"
                />
                <button
                  onClick={generateRandomRequests}
                  disabled={!requestCount || Number(requestCount) < 1}
                  className="neo-btn flex items-center gap-2 px-4 py-2 font-display text-sm font-semibold text-primary disabled:opacity-40"
                >
                  <span className="material-symbols-outlined text-base">casino</span>
                  Generate
                </button>
              </div>
            </div>

            {validationErrors.length > 0 && (
              <ul className="flex flex-col gap-1 rounded-lg border border-error/30 bg-error/5 p-3 text-xs text-error">
                {validationErrors.map((validationError) => (
                  <li key={validationError} className="flex gap-1.5">
                    <span className="material-symbols-outlined text-sm">error</span>
                    <span>{validationError}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="neo-panel flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary-fixed-dim text-lg">inventory_2</span>
                <h2 className="font-display font-semibold tracking-tight">Workload</h2>
              </div>
              <span className="font-mono text-[11px] text-on-surface-variant">
                {parsedRequests.length} request{parsedRequests.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="neo-inset-sm p-2.5">
                <p className="font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">Queue</p>
                <p className="font-display text-lg font-semibold">{parsedRequests.length}</p>
              </div>
              <div className="neo-inset-sm p-2.5">
                <p className="font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">Positions</p>
                <p className="font-display text-lg font-semibold">{uniqueRequestCount}</p>
              </div>
              <div className="neo-inset-sm p-2.5">
                <p className="font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">Disk</p>
                <p className="font-display text-lg font-semibold">0–{Math.max(diskSize - 1, 0)}</p>
              </div>
            </div>
            <p className="font-mono text-[10px] leading-relaxed text-on-surface-variant">
              Seek distance = |next cylinder − current cylinder|. SCAN and C-SCAN include travel
              to the disk edge; LOOK turns around at the last request.
            </p>
          </section>
        </aside>

        {/* RIGHT: Stage */}
        <main className="xl:col-span-8 flex flex-col gap-6">
          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-error/40 bg-error/10 p-4 text-sm text-error">
              <span className="material-symbols-outlined text-lg">error</span>
              <p>{error}</p>
            </div>
          )}

          {results.length === 0 && !loading && (
            <section className="neo-panel flex flex-col gap-5">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary-fixed-dim">route</span>
                <h2 className="font-display font-semibold tracking-tight">Ready to schedule</h2>
              </div>
              <p className="max-w-2xl text-sm text-on-surface-variant">
                Configure a request queue, choose an algorithm, and run the simulation. The result
                animates the head sweeping across the cylinders and plots the full seek trace so you
                can see total head travel.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
                {ALGS.map((algorithm) => (
                  <div key={algorithm.id} className="neo-inset-sm flex flex-col gap-1 p-3">
                    <span className="font-mono text-xs font-bold text-primary-fixed">{algorithm.label}</span>
                    <span className="text-[11px] leading-snug text-on-surface-variant">{algorithm.desc}</span>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
                <span className="w-2.5 h-2.5 rounded-full border border-tertiary-fixed bg-surface-container-lowest" />
                <span className="px-2 py-1 rounded bg-surface-container-lowest shadow-[inset_1px_1px_3px_rgba(0,0,0,0.7)]">
                  pending request
                </span>
                <span className="w-2.5 h-2.5 rounded-full bg-primary-fixed-dim" />
                <span className="px-2 py-1 rounded bg-surface-container-lowest shadow-[inset_1px_1px_3px_rgba(0,0,0,0.7)]">
                  served request
                </span>
                <span className="ml-2">head position</span>
                <span className="w-px h-4 bg-primary shadow-[0_0_8px_rgba(0,240,255,0.6)]" />
              </div>
            </section>
          )}

          {loading && (
            <section className="neo-panel flex items-center gap-3 py-16 justify-center text-on-surface-variant font-mono text-sm">
              <span className="w-2 h-2 rounded-full bg-primary animate-ping" />
              Computing seek traces…
            </section>
          )}

          {results.map(({ algorithm: resultAlgorithm, result }) => (
            <ResultBlock
              key={`${resultAlgorithm}-${runId}`}
              id={`alg-${resultAlgorithm}`}
              algorithm={resultAlgorithm}
              result={result}
            />
          ))}
        </main>
      </div>
    </main>
  );
}

function ResultBlock({
  id,
  algorithm,
  result,
}: {
  id: string;
  algorithm: string;
  result: SimulationResult;
}) {
  const [index, setIndex] = useState(0);
  const step = result.steps[index] ?? result.steps[0];
  const state = step?.state as unknown as DiskState;
  const initialDirection = String(result.metrics.initial_direction ?? "right");
  const fullSequence = (result.metrics.sequence as number[]) ?? [];
  const moves = result.steps.slice(1).map((moveStep) => {
    const moveState = moveStep.state as unknown as DiskState;
    return {
      tick: moveStep.tick,
      kind: moveState.last_move_kind,
      from: moveState.head_from,
      to: moveState.head_to,
      seek: moveState.seek_distance,
      served: moveState.is_service ? moveState.last_served : null,
    };
  });

  return (
    <section id={id} className="neo-panel flex flex-col gap-4 scroll-mt-24">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-primary animate-ping" />
          <h2 className="font-display font-semibold tracking-tight uppercase">
            {labelFor(algorithm)} — Seek Trace
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
          <span className="neo-inset-sm px-3 py-1.5 text-on-surface-variant">
            start <strong className="text-on-surface">{String(result.metrics.initial_head)}</strong>
          </span>
          <span className="neo-inset-sm px-3 py-1.5 text-on-surface-variant">
            direction <strong className="text-primary-fixed-dim uppercase">{initialDirection}</strong>
          </span>
          <span className="neo-inset-sm px-3 py-1.5 text-on-surface-variant">
            head <strong className="text-primary">{state?.head ?? "—"}</strong>
          </span>
        </div>
      </div>

      <SimulationPlayer
        result={result}
        onIndex={setIndex}
        renderState={(currentStep: Step) => (
          <DiskStateView step={currentStep} fullSequence={fullSequence} />
        )}
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Metric label="Total seek" value={String(result.metrics.total_seek)} accent />
        <Metric label="Average seek" value={String(result.metrics.average_seek)} />
        <Metric label="Head movements" value={String(result.metrics.head_movements)} />
        <Metric
          label="Requests served"
          value={`${(result.metrics.service_order as number[] | undefined)?.length ?? "—"} / ${
            result.metrics.request_count ?? "—"
          }`}
        />
      </div>

      <details className="rounded-xl bg-surface-container-low/60 p-3">
        <summary className="cursor-pointer select-none font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
          Movement breakdown · {moves.length} moves
        </summary>
        <div className="mt-3 max-h-64 overflow-auto">
          <table className="w-full text-left font-mono text-xs">
            <thead className="sticky top-0 bg-surface-container-low">
              <tr className="text-on-surface-variant uppercase tracking-wider">
                <th className="p-1.5 font-medium">#</th>
                <th className="p-1.5 font-medium">Type</th>
                <th className="p-1.5 font-medium">Head movement</th>
                <th className="p-1.5 font-medium text-right">Seek</th>
                <th className="p-1.5 font-medium text-right">Served</th>
              </tr>
            </thead>
            <tbody>
              {moves.map((move, moveIndex) => (
                <tr
                  key={`${move.tick}-${moveIndex}`}
                  className={`border-t border-surface-container-highest/60 ${
                    move.tick === step?.tick ? "bg-primary-fixed-dim/10 text-primary" : ""
                  }`}
                >
                  <td className="p-1.5 text-on-surface-variant">{moveIndex + 1}</td>
                  <td className="p-1.5 uppercase">{move.kind}</td>
                  <td className="p-1.5">
                    {move.from} → {move.to}
                  </td>
                  <td className="p-1.5 text-right">{move.seek}</td>
                  <td className="p-1.5 text-right">{move.served ?? "—"}</td>
                </tr>
              ))}
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

function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="neo-inset-sm p-3">
      <p className="font-mono text-[10px] uppercase text-on-surface-variant">{label}</p>
      <p className={`font-display font-semibold ${accent ? "text-primary" : ""}`}>{value}</p>
    </div>
  );
}

function DiskStateView({ step, fullSequence }: { step: Step; fullSequence: number[] }) {
  const state = step.state as unknown as DiskState;
  const servedCount = state.served?.length ?? 0;
  const totalRequests = state.total_requests ?? state.requests?.length ?? 0;
  const progress = totalRequests > 0 ? (servedCount / totalRequests) * 100 : 0;
  const moveLabel = state.last_move_kind === "init" ? "ready" : state.last_move_kind;

  return (
    <div className="flex flex-col gap-4">
      {/* Live readout */}
      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
        <span className="neo-inset-sm px-2.5 py-1 text-on-surface-variant">
          HEAD <strong className="text-primary text-sm">{state.head}</strong>
        </span>
        <span className="neo-inset-sm px-2.5 py-1 text-on-surface-variant">
          DIR <strong className="text-primary-fixed-dim uppercase">{state.direction}</strong>
        </span>
        <span className="neo-inset-sm px-2.5 py-1 text-on-surface-variant uppercase">
          {moveLabel}
        </span>
        <span className="text-on-surface-variant">
          moved {state.head_from} → {state.head_to} · seek{" "}
          <strong className="text-primary-fixed">{state.seek_distance}</strong>
        </span>
        <span className="ml-auto text-on-surface-variant">
          served <strong className="text-on-surface">{servedCount}</strong>/{totalRequests} · total
          seek <strong className="text-primary">{state.total_seek}</strong>
        </span>
      </div>

      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-container-lowest shadow-[inset_1px_1px_3px_rgba(0,0,0,0.8)]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-primary-fixed-dim to-tertiary-fixed transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
          {Math.round(progress)}% complete
        </span>
      </div>

      <DiskTrack state={state} />
      <SeekTrace state={state} fullSequence={fullSequence} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
              Pending queue
            </span>
            <span className="font-mono text-[10px] text-on-surface-variant">
              {state.remaining?.length ?? 0} waiting
            </span>
          </div>
          <div className="flex min-h-9 flex-wrap items-center gap-1.5">
            {(state.remaining?.length ?? 0) === 0 && (
              <span className="font-mono text-[10px] uppercase tracking-wider text-tertiary-fixed-dim">
                all requests served
              </span>
            )}
            {state.remaining?.map((request, requestIndex) => (
              <span
                key={`${request}-${requestIndex}`}
                className="rounded-md border border-tertiary-fixed/30 bg-surface-container-high px-2 py-1 font-mono text-xs text-tertiary-fixed"
              >
                {request}
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
            Service order
          </span>
          <p className="font-mono text-xs leading-relaxed text-primary-fixed-dim break-words">
            {state.served?.length ? state.served.join(" → ") : "—"}
          </p>
        </div>
      </div>
    </div>
  );
}

function DiskTrack({ state }: { state: DiskState }) {
  const maxPosition = Math.max(state.disk_size - 1, 0);
  const axisMax = Math.max(maxPosition, 1);
  const toPercent = (position: number) =>
    Math.max(0, Math.min(100, (position / axisMax) * 100));

  const pendingCounts = countValues(state.remaining ?? []);
  const servedCounts = countValues(state.served ?? []);
  const requestPositions = Array.from(new Set(state.requests ?? [])).sort((a, b) => a - b);
  const showRequestLabels = requestPositions.length <= 12;
  const tickPositions = Array.from(
    new Set([0, Math.round(maxPosition * 0.25), Math.round(maxPosition * 0.5), Math.round(maxPosition * 0.75), maxPosition]),
  );
  const fromPercent = toPercent(state.head_from);
  const toPercentValue = toPercent(state.head_to);
  const moveLeft = Math.min(fromPercent, toPercentValue);
  const moveWidth = Math.abs(toPercentValue - fromPercent);

  return (
    <div role="img" aria-label={`Disk track from cylinder 0 to ${maxPosition}, head at ${state.head}`}>
      <div className="mb-1 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
        <span>Cylinder map · 0 to {maxPosition}</span>
        <span>
          <span className="text-tertiary-fixed">{state.remaining?.length ?? 0} pending</span>
          <span className="mx-1 text-outline">/</span>
          <span className="text-primary-fixed-dim">{state.served?.length ?? 0} served</span>
        </span>
      </div>

      <div className="relative h-24 overflow-hidden rounded-xl border border-surface-container-highest bg-[#0c0e12]">
        {/* Track rail */}
        <div className="absolute left-3 right-3 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-gradient-to-r from-surface-container-highest via-outline-variant to-surface-container-highest shadow-[inset_1px_1px_3px_rgba(0,0,0,0.8)]" />

        {/* All percentage-positioned elements live in the same inset wrapper. */}
        <div className="absolute inset-x-3 inset-y-0">
          {/* Cylinder ticks + labels */}
          {tickPositions.map((tick) => (
            <div
              key={tick}
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${toPercent(tick)}%` }}
            >
              <span className="block h-3 w-px bg-outline-variant" />
            </div>
          ))}
          {tickPositions.map((tick) => (
            <span
              key={`label-${tick}`}
              className="absolute bottom-1 -translate-x-1/2 font-mono text-[9px] text-on-surface-variant/70"
              style={{ left: `${toPercent(tick)}%` }}
            >
              {tick}
            </span>
          ))}

          {/* Request markers */}
          {requestPositions.map((position) => {
            const pending = pendingCounts[position] ?? 0;
            const served = servedCounts[position] ?? 0;
            const total = pending + served;
            return (
              <div
                key={position}
                className="absolute top-1/2 z-10 -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${toPercent(position)}%` }}
                title={`Cylinder ${position}: ${pending} pending, ${served} served`}
              >
                <div
                  className={`relative h-3 w-3 rounded-full border transition-colors ${
                    pending > 0
                      ? "border-tertiary-fixed bg-surface-container-lowest shadow-[0_0_6px_rgba(104,252,191,0.35)]"
                      : "border-primary-fixed-dim bg-primary-fixed-dim/50"
                  }`}
                >
                  <span
                    className={`absolute -top-4 left-1/2 -translate-x-1/2 font-mono text-[9px] ${
                      pending > 0 ? "text-tertiary-fixed" : "text-on-surface-variant"
                    } ${showRequestLabels ? "" : "hidden"}`}
                  >
                    {position}
                  </span>
                  {total > 1 && (
                    <span className="absolute -bottom-3.5 left-1/2 -translate-x-1/2 font-mono text-[8px] text-on-surface-variant">
                      ×{total}
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          {/* Motion arrow for the current step */}
          {state.head_from !== state.head_to && (
            <div
              className="absolute top-4 z-20 h-px border-t border-dashed border-primary-fixed-dim/80"
              style={{ left: `${moveLeft}%`, width: `${moveWidth}%` }}
            >
              <span
                className={`absolute -top-1.5 font-mono text-[9px] text-primary-fixed-dim ${
                  state.head_to >= state.head_from ? "-right-1" : "-left-1"
                }`}
              >
                {state.head_to >= state.head_from ? "▶" : "◀"}
              </span>
              <span className="absolute left-1/2 -top-4 -translate-x-1/2 whitespace-nowrap font-mono text-[9px] text-primary-fixed-dim">
                seek {state.seek_distance}
              </span>
            </div>
          )}

          {/* Head */}
          <div
            className="absolute top-3 bottom-3 z-30 w-0.5 -translate-x-1/2 bg-primary shadow-[0_0_12px_rgba(0,240,255,0.75)]"
            style={{ left: `${toPercent(state.head)}%` }}
          >
            <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-primary px-1.5 py-0.5 font-mono text-[9px] font-bold text-on-primary">
              {state.head}
            </span>
            <span className="absolute -bottom-1.5 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-primary" />
          </div>
        </div>
      </div>

      <div className="mt-1 flex items-center justify-between font-mono text-[9px] uppercase tracking-wider text-on-surface-variant/70">
        <span>low cylinders</span>
        <span>seek axis</span>
        <span>high cylinders</span>
      </div>
    </div>
  );
}

function SeekTrace({ state, fullSequence }: { state: DiskState; fullSequence: number[] }) {
  const traceId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const fillId = `seek-fill-${traceId}`;
  const glowId = `seek-glow-${traceId}`;
  const sequence = fullSequence.length > 0 ? fullSequence : state.sequence ?? [];
  if (sequence.length < 2) {
    return (
      <div className="neo-inset-sm flex h-24 items-center justify-center font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
        The seek trace appears after the first head movement.
      </div>
    );
  }

  const width = 800;
  const height = 190;
  const padding = { left: 42, right: 18, top: 18, bottom: 30 };
  const maxPosition = Math.max(state.disk_size - 1, 0);
  const axisMax = Math.max(maxPosition, 1);
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const xAt = (index: number) => padding.left + (index / Math.max(sequence.length - 1, 1)) * plotWidth;
  const yAt = (position: number) =>
    padding.top + (1 - Math.max(0, Math.min(position, maxPosition)) / axisMax) * plotHeight;
  const completedCount = Math.min(state.sequence?.length ?? 1, sequence.length);
  const completed = sequence.slice(0, completedCount);
  const fullPoints = sequence.map((position, index) => `${xAt(index)},${yAt(position)}`).join(" ");
  const completedPoints = completed
    .map((position, index) => `${xAt(index)},${yAt(position)}`)
    .join(" ");
  const currentIndex = Math.max(0, completedCount - 1);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
        <span>Seek trace · cylinder vs movement</span>
        <span>
          move <strong className="text-primary">{currentIndex}</strong> / {sequence.length - 1}
        </span>
      </div>
      <div className="overflow-x-auto rounded-xl border border-surface-container-highest bg-[#0c0e12]">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-auto w-full min-w-[560px]"
          role="img"
          aria-label={`Seek trace across ${sequence.length - 1} head movements`}
        >
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#00dbe9" stopOpacity="0.18" />
              <stop offset="100%" stopColor="#00dbe9" stopOpacity="0" />
            </linearGradient>
            <filter id={glowId} x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="2.2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Horizontal guides */}
          {[0, 0.5, 1].map((fraction) => {
            const y = padding.top + fraction * plotHeight;
            const value = Math.round(maxPosition * (1 - fraction));
            return (
              <g key={fraction}>
                <line
                  x1={padding.left}
                  x2={width - padding.right}
                  y1={y}
                  y2={y}
                  stroke="rgba(255,255,255,0.08)"
                  strokeDasharray="3 5"
                />
                <text
                  x={padding.left - 8}
                  y={y + 3}
                  textAnchor="end"
                  fill="#849495"
                  fontSize="10"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {value}
                </text>
              </g>
            );
          })}

          {/* Full path (future movements are faint) */}
          <polyline
            points={fullPoints}
            fill="none"
            stroke="rgba(185,202,203,0.22)"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* Completed path */}
          <polygon
            points={`${padding.left},${padding.top + plotHeight} ${completedPoints} ${
              xAt(currentIndex)
            },${padding.top + plotHeight}`}
            fill={`url(#${fillId})`}
          />
          <polyline
            points={completedPoints}
            fill="none"
            stroke="#00dbe9"
            strokeWidth="2.2"
            strokeLinejoin="round"
            strokeLinecap="round"
            filter={`url(#${glowId})`}
          />

          {/* Vertices */}
          {sequence.map((position, index) => {
            const done = index <= currentIndex;
            const isCurrent = index === currentIndex;
            return (
              <circle
                key={`${position}-${index}`}
                cx={xAt(index)}
                cy={yAt(position)}
                r={isCurrent ? 4.5 : done ? 2.8 : 2}
                fill={isCurrent ? "#dbfcff" : done ? "#00dbe9" : "#333539"}
                stroke={isCurrent ? "#dbfcff" : done ? "#00dbe9" : "#3b494b"}
                strokeWidth={isCurrent ? 2 : 1}
              />
            );
          })}

          {/* Current movement line */}
          <line
            x1={xAt(currentIndex)}
            x2={xAt(currentIndex)}
            y1={padding.top}
            y2={padding.top + plotHeight}
            stroke="rgba(0,240,255,0.25)"
            strokeDasharray="4 4"
          />

          {/* Axes */}
          <line
            x1={padding.left}
            x2={width - padding.right}
            y1={padding.top + plotHeight}
            y2={padding.top + plotHeight}
            stroke="rgba(255,255,255,0.25)"
          />
          <line
            x1={padding.left}
            x2={padding.left}
            y1={padding.top}
            y2={padding.top + plotHeight}
            stroke="rgba(255,255,255,0.25)"
          />

          <text
            x={padding.left}
            y={height - 7}
            fill="#849495"
            fontSize="10"
            fontFamily="JetBrains Mono, monospace"
          >
            start
          </text>
          <text
            x={width - padding.right}
            y={height - 7}
            textAnchor="end"
            fill="#849495"
            fontSize="10"
            fontFamily="JetBrains Mono, monospace"
          >
            {sequence.length - 1} moves
          </text>
        </svg>
      </div>
    </div>
  );
}
