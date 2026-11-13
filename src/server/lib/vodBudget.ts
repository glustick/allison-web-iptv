// The VOD disk bound (v0.103.0). A film session deliberately keeps every segment it produces
// (`-hls_list_size 0`) so the viewer can scrub anywhere — which is the feature AND the exposure:
// a 2h20 feature at ~10.7 Mbps holds 10 GB+ for its runtime, and two of them plus a cold night
// can fill whatever filesystem TRANSCODE_TMP_DIR aims at. The free-space guardrail (v0.12.2)
// already refuses starts and stops everything when the DISK is nearly full; this bounds the
// retained VOD total BEFORE the disk gets to that point, so the guardrail stays a last resort.
//
// The design decision this encodes (recorded in ROADMAP since v0.12.2): rather than capping a
// single film's retained window and giving up far-back scrubbing mid-film, the bound evicts the
// most-idle VOD sessions first — an abandoned-but-buffered film nobody has fetched for minutes
// goes before the film someone is watching. An actively-watched film is never evicted for
// another's sake unless it is itself the most idle (in which case nothing was being watched).

/** The default total: generous for a household (two long films concurrently), small for a NAS. */
export const DEFAULT_VOD_BUDGET_BYTES = 16 * 1024 * 1024 * 1024

/**
 * Reads TRANSCODE_VOD_MAX_TOTAL_BYTES. Accepts plain bytes or KiB/MiB/GiB suffixes (the same
 * shapes docker compose users write for mem_limit). 0 (or a negative/garbage value) disables the
 * bound — an operator who wants the v0.102 behaviour back can say so explicitly.
 */
export function resolveVodBudgetBytes(raw: string | undefined): number {
  const text = (raw ?? '').trim().toLowerCase()
  if (text === '' ) return DEFAULT_VOD_BUDGET_BYTES
  const match = /^(\d+(?:\.\d+)?)\s*(kib|mib|gib|kb|mb|gb|k|m|g)?$/.exec(text)
  if (!match) return DEFAULT_VOD_BUDGET_BYTES
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return 0
  const multipliers: Record<string, number> = {
    kib: 1024, kb: 1000, k: 1000,
    mib: 1024 ** 2, mb: 1000 ** 2, m: 1000 ** 2,
    gib: 1024 ** 3, gb: 1000 ** 3, g: 1000 ** 3
  }
  const unit = match[2] ?? ''
  return Math.round(value * (multipliers[unit] ?? 1))
}

/** The refusal a new VOD start gets when the retained total is already at the bound. */
export function vodStartRefusal(totalVodBytes: number, budgetBytes: number): string | null {
  if (budgetBytes <= 0) return null
  if (totalVodBytes < budgetBytes) return null
  const usedGb = (totalVodBytes / 1024 ** 3).toFixed(1)
  const budgetGb = (budgetBytes / 1024 ** 3).toFixed(1)
  return (
    `This film would push retained video past the deployment's disk bound ` +
    `(${usedGb} GB of ${budgetGb} GB already held by open films). ` +
    `Close another film first, or raise TRANSCODE_VOD_MAX_TOTAL_BYTES.`
  )
}

export interface VodEvictionCandidate {
  sessionId: string
  isVod: boolean
  /** How long since anything fetched this session's output — the eviction order. */
  idleMs: number
  bytes: number
  /** How long the session has existed. Sessions younger than the grace window are never
   *  evicted: a film seconds into its transcode holds almost nothing, and stopping it mid-start
   *  races startTranscode's own settle flow (measured by the test that pinned this). */
  ageMs: number
}

/** A film this young is never the sweep's business — its bytes have not arrived yet. */
export const VOD_EVICTION_GRACE_MS = 120_000

/**
 * Which VOD sessions to stop to get back under the bound: most-idle first, until the projected
 * total fits. Live sessions are never candidates — they hold kilobytes, not gigabytes, and
 * stopping one costs a live viewer to save nothing. An empty answer means "already within the
 * bound" (or the bound is disabled).
 */
export function planVodEvictions(
  sessions: VodEvictionCandidate[],
  totalVodBytes: number,
  budgetBytes: number,
  graceMs: number = VOD_EVICTION_GRACE_MS
): string[] {
  if (budgetBytes <= 0 || totalVodBytes < budgetBytes) return []
  // A young session still counts toward the TOTAL (its bytes are real) but is not evicted —
  // the projected arithmetic below only subtracts sessions actually on the eviction list, so a
  // bound that only a young session exceeds stays over until the grace window passes. That is
  // the honest answer: refusing new starts (the other half of the bound) holds the line meanwhile.
  const vod = sessions
    .filter((session) => session.isVod && session.ageMs >= graceMs)
    .sort((a, b) => b.idleMs - a.idleMs || b.bytes - a.bytes)
  const evicted: string[] = []
  let projected = totalVodBytes
  for (const session of vod) {
    if (projected < budgetBytes) break
    evicted.push(session.sessionId)
    projected -= session.bytes
  }
  return evicted
}
