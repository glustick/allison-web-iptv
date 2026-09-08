// Ported verbatim from the desktop app's lib/epgTime.ts — pure time/percent math for the
// Gantt-chart EPG grid, kept dependency-free so it's directly unit-testable.
export function pct(t: number, start: number, end: number): number {
  if (end <= start) return 0
  return Math.min(100, Math.max(0, ((t - start) / (end - start)) * 100))
}
