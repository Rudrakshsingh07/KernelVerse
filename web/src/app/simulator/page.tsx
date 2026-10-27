import Link from "next/link";

const TOPICS = [
  { slug: "cpu-scheduling", name: "CPU Scheduling", status: "Complete", icon: "speed", desc: "FCFS, SJF, SRTF, Round Robin" },
  { slug: "memory-management", name: "Memory Management", status: "Complete", icon: "memory_alt", desc: "Contiguous allocation, first/best/worst fit, segmentation" },
  { slug: "paging", name: "Paging", status: "Complete", icon: "grid_view", desc: "FIFO, LRU, Optimal replacement, TLB behavior" },
  { slug: "disk-scheduling", name: "Disk Scheduling", status: "Complete", icon: "hard_drive", desc: "FCFS, SSTF, SCAN, C-SCAN, LOOK" },
  { slug: "deadlocks", name: "Deadlocks", status: "Complete", icon: "lock", desc: "Coffman conditions, detection, Banker's algorithm" },
];

export default function SimulatorIndex() {
  return (
    <main className="flex flex-col gap-6">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Topics &amp; Modules</h1>
      <ul className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {TOPICS.map((t) => (
          <li key={t.slug} className="neo-panel flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary-fixed-dim">{t.icon}</span>
              <Link href={`/simulator/${t.slug}`} className="font-display text-lg font-semibold hover:text-primary transition-colors">{t.name}</Link>
              <span className="ml-auto font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-surface-container-lowest text-on-surface-variant shadow-[inset_1px_1px_3px_rgba(0,0,0,0.7)]">{t.status}</span>
            </div>
            <p className="text-sm text-on-surface-variant">{t.desc}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
