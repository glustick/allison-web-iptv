// VOD reload continuity (v0.117.0, ported from the desktop's 0.30.0): the film player's own
// reload path (a failed session replaced, a source re-attached) used to re-apply the ORIGINAL
// resume point — losing everything watched since. This in-memory map remembers where each
// title actually got to, so a reload continues from there instead of rewinding.
//
// In memory on purpose: the durable copy is the resume-position store the progress reporter
// already writes; this only has to survive the seconds between a reload's teardown and its
// re-attach. Bounded like every other map here.

const MAX_ENTRIES = 20

const positions = new Map<string, number>()

export function rememberVodPosition(titleKey: string, positionSeconds: number): void {
  if (!titleKey) return
  if (!Number.isFinite(positionSeconds) || positionSeconds < 0) return
  // Delete-then-set keeps the LRU order for free.
  positions.delete(titleKey)
  positions.set(titleKey, positionSeconds)
  while (positions.size > MAX_ENTRIES) {
    const oldest = positions.keys().next().value
    if (oldest === undefined) break
    positions.delete(oldest)
  }
}

export function vodContinuityPosition(titleKey: string): number | null {
  return positions.get(titleKey) ?? null
}

export function clearVodContinuity(titleKey: string): void {
  positions.delete(titleKey)
}
