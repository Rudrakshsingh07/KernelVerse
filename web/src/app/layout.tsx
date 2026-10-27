import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "KernelVerse — OS Concepts Simulator",
  description: "Interactive OS concepts simulator: CPU scheduling, memory management, paging, disk scheduling, and deadlocks visualized step by step.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@500;600&display=swap"
          rel="stylesheet"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-full flex flex-col bg-surface text-on-surface font-body">
        <header className="w-full bg-[#0c0e12] shadow-[inset_0_-3px_7px_rgba(0,0,0,0.7)]">
          <div className="h-16 w-full max-w-[1800px] mx-auto px-6 flex items-center justify-between">
            <Link href="/" className="flex items-center gap-3">
              <span className="font-display text-xl tracking-tight font-semibold">KernelVerse</span>
              <span className="font-mono text-[11px] uppercase tracking-wider px-2 py-0.5 rounded bg-surface-container-low text-primary-fixed-dim shadow-[inset_2px_2px_4px_rgba(0,0,0,0.7)]">OS SIMULATOR</span>
            </Link>
            <nav className="hidden lg:flex items-center gap-1 p-1 rounded-xl bg-surface-container-lowest shadow-[inset_2px_2px_6px_rgba(0,0,0,0.8)]">
              <Link href="/simulator/cpu-scheduling" className="px-4 py-2 rounded-lg text-sm text-on-surface-variant hover:text-on-surface transition-all">CPU Scheduling</Link>
              <Link href="/simulator/memory-management" className="px-4 py-2 rounded-lg text-sm text-on-surface-variant hover:text-on-surface transition-all">Memory Management</Link>
              <Link href="/simulator/paging" className="px-4 py-2 rounded-lg text-sm text-on-surface-variant hover:text-on-surface transition-all">Paging</Link>
              <Link href="/simulator/disk-scheduling" className="px-4 py-2 rounded-lg text-sm text-on-surface-variant hover:text-on-surface transition-all">Disk Scheduling</Link>
              <Link href="/simulator/deadlocks" className="px-4 py-2 rounded-lg text-sm text-on-surface-variant hover:text-on-surface transition-all">Deadlocks</Link>
            </nav>
          </div>
        </header>
        <div className="flex-1 w-full max-w-[1800px] mx-auto px-6 py-6">{children}</div>
        <footer className="w-full bg-[#0c0e12] shadow-[inset_0_3px_7px_rgba(0,0,0,0.7)] py-4">
          <div className="max-w-[1800px] mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-2 text-on-surface-variant font-mono text-[11px]">
            <span>KERNEL ARCHITECTURE: X86_64 VIRTUALIZED</span>
            <span>© 2026 KernelVerse Interactive Laboratory System</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
