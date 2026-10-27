import Link from "next/link";

export default function Home() {
  return (
    <main className="flex flex-col items-center justify-center text-center py-20 gap-6">
      <span className="material-symbols-outlined text-primary-fixed-dim text-5xl">memory</span>
      <h1 className="font-display text-5xl font-semibold tracking-tight">KernelVerse</h1>
      <p className="max-w-xl text-on-surface-variant">
        An interactive OS concepts laboratory — CPU scheduling, memory management, paging,
        disk scheduling, and deadlocks, visualized step by step.
      </p>
      <Link href="/simulator" className="neo-btn px-8 py-3 font-display font-semibold text-primary">
        Open Simulators
      </Link>
    </main>
  );
}
