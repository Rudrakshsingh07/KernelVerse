export default function DeadlocksPage() {
  return (
    <main className="flex flex-col gap-6">
      <header className="flex items-center gap-4 p-4 rounded-xl bg-surface-container shadow-[6px_6px_14px_rgba(0,0,0,0.65),-5px_-5px_12px_rgba(255,255,255,0.04)]">
        <span className="material-symbols-outlined text-primary-fixed-dim text-xl">lock</span>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Deadlocks</h1>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-surface-container-lowest text-on-surface-variant shadow-[inset_1px_1px_3px_rgba(0,0,0,0.7)]">Planned</span>
      </header>
      <div className="neo-panel text-on-surface-variant font-mono text-sm py-16 text-center">
        Coffman conditions, detection, and the Banker&apos;s algorithm simulator coming soon.
      </div>
    </main>
  );
}
