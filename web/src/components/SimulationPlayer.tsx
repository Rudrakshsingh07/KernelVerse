"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SimulationResult, Step } from "@/lib/types";

interface Props {
  result: SimulationResult;
  renderState: (step: Step) => React.ReactNode;
  onIndex?: (index: number) => void;
}

const SPEEDS = [0.5, 1, 2];

export default function SimulationPlayer({ result, renderState, onIndex }: Props) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(1);
  const [loop, setLoop] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const step = result.steps[index];

  useEffect(() => {
    onIndex?.(index);
  }, [index, onIndex]);

  const stop = useCallback(() => {
    setPlaying(false);
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => {
    if (!playing) return;
    timer.current = setInterval(() => {
      setIndex((i) => {
        if (i >= result.steps.length - 1) {
          if (loop) return 0;
          stop();
          return i;
        }
        return i + 1;
      });
    }, 600 / SPEEDS[speedIdx]);
    return stop;
  }, [playing, speedIdx, loop, result.steps.length, stop]);

  const reset = () => {
    stop();
    setIndex(0);
  };
  const back = () => {
    stop();
    setIndex((i) => Math.max(0, i - 1));
  };
  const forward = () => {
    stop();
    setIndex((i) => Math.min(result.steps.length - 1, i + 1));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <div
          className={`neo-inset p-3 transition-all ${
            expanded ? "pb-32 sm:pb-24" : "pb-16 sm:pb-14"
          }`}
        >
          {step && renderState(step)}
        </div>

        {/* Retractable transport overlay. It stays pinned to the bottom of the
            viewport while the simulation content scrolls underneath it. */}
        {expanded ? (
          <div className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-4xl rounded-xl border border-outline-variant/40 bg-surface-container/95 p-2 shadow-[0_10px_30px_rgba(0,0,0,0.65)] backdrop-blur">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="flex items-center gap-1.5 rounded-lg bg-surface-container-lowest px-2.5 py-1 font-mono text-[10px] shadow-[inset_2px_2px_5px_rgba(0,0,0,0.7)]">
                <span className="material-symbols-outlined text-[13px] text-primary">
                  pin
                </span>
                <span className="font-semibold">
                  {index + 1}/{result.steps.length}
                </span>
                <span className="text-on-surface-variant">·</span>
                <span className="text-primary-fixed-dim">t={step?.tick ?? 0}</span>
              </span>

              <div className="flex items-center gap-1">
                <button
                  onClick={reset}
                  title="Reset"
                  aria-label="Reset simulation"
                  className="neo-btn-round flex h-8 w-8 items-center justify-center text-on-surface-variant hover:text-error"
                >
                  <span className="material-symbols-outlined text-base">restart_alt</span>
                </button>
                <button
                  onClick={back}
                  title="Step back"
                  aria-label="Step back"
                  className="neo-btn-round flex h-8 w-8 items-center justify-center text-on-surface-variant hover:text-on-surface"
                >
                  <span className="material-symbols-outlined text-base">skip_previous</span>
                </button>
                <button
                  onClick={() => setPlaying((p) => !p)}
                  title="Play / Pause"
                  aria-label={playing ? "Pause" : "Play"}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-primary-fixed-dim to-inverse-primary text-on-primary shadow-[0_0_14px_rgba(0,240,255,0.35),4px_4px_10px_rgba(0,0,0,0.8)] transition-all hover:scale-105"
                >
                  <span className="material-symbols-outlined text-xl font-bold">
                    {playing ? "pause" : "play_arrow"}
                  </span>
                </button>
                <button
                  onClick={forward}
                  title="Step forward"
                  aria-label="Step forward"
                  className="neo-btn-round flex h-8 w-8 items-center justify-center text-on-surface-variant hover:text-on-surface"
                >
                  <span className="material-symbols-outlined text-base">skip_next</span>
                </button>
                <button
                  onClick={() => setLoop((l) => !l)}
                  title="Auto-loop"
                  aria-label="Toggle auto-loop"
                  aria-pressed={loop}
                  className={`neo-btn-round flex h-8 w-8 items-center justify-center ${
                    loop ? "text-primary" : "text-on-surface-variant hover:text-primary"
                  }`}
                >
                  <span className="material-symbols-outlined text-base">replay</span>
                </button>
              </div>

              <div className="flex items-center gap-0.5 rounded-lg bg-surface-container-lowest p-0.5 font-mono text-[10px] shadow-[inset_2px_2px_5px_rgba(0,0,0,0.7)]">
                {SPEEDS.map((s, i) => (
                  <button
                    key={s}
                    onClick={() => setSpeedIdx(i)}
                    aria-pressed={i === speedIdx}
                    className={`rounded px-1.5 py-0.5 ${
                      i === speedIdx
                        ? "bg-surface-container text-primary font-bold shadow-[2px_2px_5px_rgba(0,0,0,0.7)]"
                        : "text-on-surface-variant hover:text-on-surface"
                    }`}
                  >
                    {s}x
                  </button>
                ))}
              </div>

              <button
                onClick={() => setExpanded(false)}
                title="Hide controls"
                aria-label="Hide controls"
                aria-expanded
                className="ml-auto flex h-7 w-7 items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:text-primary"
              >
                <span className="material-symbols-outlined text-base">
                  keyboard_arrow_down
                </span>
              </button>
            </div>

            <div className="mt-1.5 flex items-center gap-2 px-0.5">
              <span className="font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
                scrub
              </span>
              <input
                type="range"
                className="w-full min-w-20 accent-primary-container"
                min={0}
                max={Math.max(0, result.steps.length - 1)}
                value={index}
                aria-label="Simulation step"
                onChange={(e) => {
                  stop();
                  setIndex(Number(e.target.value));
                }}
              />
            </div>
          </div>
        ) : (
          <div className="fixed inset-x-3 bottom-3 z-50 mx-auto flex max-w-4xl items-center gap-1.5 rounded-full border border-outline-variant/40 bg-surface-container/95 px-2 py-1 shadow-[0_8px_24px_rgba(0,0,0,0.6)] backdrop-blur">
            <button
              onClick={() => setPlaying((p) => !p)}
              title="Play / Pause"
              aria-label={playing ? "Pause" : "Play"}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-primary-fixed-dim text-on-primary"
            >
              <span className="material-symbols-outlined text-base font-bold">
                {playing ? "pause" : "play_arrow"}
              </span>
            </button>
            <button
              onClick={back}
              title="Step back"
              aria-label="Step back"
              className="flex h-7 w-7 items-center justify-center rounded-full text-on-surface-variant hover:text-on-surface"
            >
              <span className="material-symbols-outlined text-base">skip_previous</span>
            </button>
            <button
              onClick={forward}
              title="Step forward"
              aria-label="Step forward"
              className="flex h-7 w-7 items-center justify-center rounded-full text-on-surface-variant hover:text-on-surface"
            >
              <span className="material-symbols-outlined text-base">skip_next</span>
            </button>
            <span className="font-mono text-[10px] text-on-surface-variant">
              step <strong className="text-primary">{index + 1}</strong>/
              {result.steps.length}
              <span className="mx-1 text-outline">·</span>
              <span className="text-primary-fixed-dim">t={step?.tick ?? 0}</span>
            </span>
            <button
              onClick={() => setExpanded(true)}
              title="Show controls"
              aria-label="Show controls"
              aria-expanded={false}
              className="ml-auto flex h-7 items-center gap-1 rounded-full px-2 font-mono text-[9px] uppercase tracking-wider text-primary-fixed-dim hover:text-primary"
            >
              <span className="material-symbols-outlined text-base">open_in_full</span>
              controls
            </button>
          </div>
        )}
      </div>

      <p className="px-1 font-mono text-xs text-on-surface-variant">
        {step?.explanation}
      </p>
    </div>
  );
}
