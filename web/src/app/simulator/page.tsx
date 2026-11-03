import Link from "next/link";

const TOPICS = [
  { slug: "cpu-scheduling", name: "CPU Scheduling", icon: "speed", desc: "FCFS, SJF, SRTF, Round Robin" },
  { slug: "paging", name: "Paging", icon: "grid_view", desc: "FIFO, LRU, Optimal replacement, TLB behavior" },
  { slug: "cache", name: "Cache", icon: "memory", desc: "Direct-mapped and set-associative caches, FIFO/LRU replacement" },
  { slug: "disk-scheduling", name: "Disk Scheduling", icon: "hard_drive", desc: "FCFS, SSTF, SCAN, C-SCAN, LOOK" },
  { slug: "deadlocks", name: "Deadlocks", icon: "lock", desc: "Banker's algorithm: safe states and all safe sequences" },
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
            </div>
            <p className="text-sm text-on-surface-variant">{t.desc}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
