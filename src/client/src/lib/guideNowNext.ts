/**
 * "What's on now, and what follows" — the two questions a viewer asks about the channel they are
 * already watching, answered from the same short-EPG data the guide uses.
 *
 * Pure, because the interesting cases are the edges: a channel with no guide at all, a gap between
 * programmes, and a programme that started before the guide window (or the device's clock) says it
 * did. The player must never invent a programme to fill a gap.
 */
export interface GuideProgramme {
  startMs: number
  stopMs: number
  title: string
}

export interface NowNext {
  current: GuideProgramme | null
  next: GuideProgramme | null
}

export function pickNowNext(programmes: GuideProgramme[] | null | undefined, now: number): NowNext {
  const list = (programmes ?? [])
    .filter((programme) => Number.isFinite(programme.startMs) && Number.isFinite(programme.stopMs))
    .slice()
    .sort((a, b) => a.startMs - b.startMs)
  const current = list.find((programme) => programme.startMs <= now && now < programme.stopMs) ?? null
  // "Next" is the first programme that has not started yet — not simply the one after `current`,
  // which would name a gap's following programme as if it were on now.
  const next = list.find((programme) => programme.startMs > now) ?? null
  return { current, next }
}

/** How far through a programme playback is, 0–1, clamped — for the progress bar. */
export function programmeProgress(programme: GuideProgramme, now: number): number {
  const span = programme.stopMs - programme.startMs
  if (!(span > 0)) return 0
  return Math.min(1, Math.max(0, (now - programme.startMs) / span))
}

/** "20:00" — the guide's own time shape, without seconds. */
export function clockLabel(ms: number): string {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
