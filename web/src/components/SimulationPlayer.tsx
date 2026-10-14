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

  return (
    <div className="flex flex-col gap-4">
      <div className="neo-inset p-4 min-h-40">{step && renderState(step)}</div>

      <p className="font-mono text-xs text-on-surface-variant px-1">{step?.explanation}</p>

      {/* Docked transport deck */}
      <div className="flex flex-col md:flex-row items-center justify-between gap-4 p-4 rounded-xl bg-surface-container-low shadow-[inset_2px_2px_6px_rgba(0,0,0,0.8)]">
        <div className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-surface-container-lowest shadow-[inset_2px_2px_5px_rgba(0,0,0,0.7)] font-mono text-sm">
          <span className="material-symbols-outlined text-sm text-primary">pin</span>
          <span className="font-semibold">Step {index + 1} of {result.steps.length}</span>
          <span className="text-on-surface-variant">|</span>
          <span className="text-primary-fixed-dim">t = {step?.tick ?? 0}</span>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={() => { stop(); setIndex(0); }} title="Reset" className="neo-btn-round w-10 h-10 flex items-center justify-center text-on-surface-variant hover:text-error">
            <span className="material-symbols-outlined text-lg">restart_alt</span>
          </button>
          <button onClick={() => { stop(); setIndex((i) => Math.max(0, i - 1)); }} title="Step back" className="neo-btn-round w-10 h-10 flex items-center justify-center text-on-surface-variant hover:text-on-surface">
            <span className="material-symbols-outlined text-lg">skip_previous</span>
          </button>
          <button onClick={() => setPlaying((p) => !p)} title="Play / Pause" className="w-14 h-14 flex items-center justify-center rounded-full bg-gradient-to-br from-primary-fixed-dim to-inverse-primary text-on-primary shadow-[0_0_18px_rgba(0,240,255,0.35),6px_6px_14px_rgba(0,0,0,0.8)] hover:scale-105 transition-all">
            <span className="material-symbols-outlined text-2xl font-bold">{playing ? "pause" : "play_arrow"}</span>
          </button>
          <button onClick={() => { stop(); setIndex((i) => Math.min(result.steps.length - 1, i + 1)); }} title="Step forward" className="neo-btn-round w-10 h-10 flex items-center justify-center text-on-surface-variant hover:text-on-surface">
            <span className="material-symbols-outlined text-lg">skip_next</span>
          </button>
          <button onClick={() => setLoop((l) => !l)} title="Auto-loop" className={`neo-btn-round w-10 h-10 flex items-center justify-center ${loop ? "text-primary" : "text-on-surface-variant hover:text-primary"}`}>
            <span className="material-symbols-outlined text-lg">replay</span>
          </button>
        </div>

        <div className="flex items-center gap-1 p-1 rounded-lg bg-surface-container-lowest shadow-[inset_2px_2px_5px_rgba(0,0,0,0.7)] font-mono text-xs">
          {SPEEDS.map((s, i) => (
            <button key={s} onClick={() => setSpeedIdx(i)} className={`px-2.5 py-1 rounded ${i === speedIdx ? "bg-surface-container text-primary font-bold shadow-[2px_2px_5px_rgba(0,0,0,0.7)]" : "text-on-surface-variant hover:text-on-surface"}`}>
              {s}x
            </button>
          ))}
        </div>
      </div>

      <input
        type="range"
        className="w-full accent-primary-container"
        min={0}
        max={Math.max(0, result.steps.length - 1)}
        value={index}
        onChange={(e) => { stop(); setIndex(Number(e.target.value)); }}
      />
    </div>
  );
}
