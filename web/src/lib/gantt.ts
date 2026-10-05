import type { Step } from "./types";

export interface GanttSegment {
  pid: string;
  start: number;
  end: number;
}

export function getGantt(steps: Step[]): GanttSegment[] {
  const segments: GanttSegment[] = [];
  for (const s of steps) {
    const pid = s.state.running as string | null;
    if (pid == null) continue;
    const last = segments[segments.length - 1];
    if (last && last.pid === pid && last.end === s.tick) {
      last.end = s.tick + 1;
    } else {
      segments.push({ pid, start: s.tick, end: s.tick + 1 });
    }
  }
  return segments;
}

const PALETTE = [
  "#006970", "#0284c7", "#4f46e5", "#059669",
  "#b45309", "#be185d", "#0d9488", "#7c3aed",
];

export function pidColor(pid: string, allIds: string[]): string {
  const idx = allIds.indexOf(pid);
  return PALETTE[(idx >= 0 ? idx : 0) % PALETTE.length];
}
