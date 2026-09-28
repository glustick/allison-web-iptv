import type { Database } from 'better-sqlite3'
import { openDatabase } from './db.js'

// What each channel needs, remembered once and shared.
//
// The problem this exists for, in the operator's words (2026-09-28): *"rather than discovering each
// time we click a channel … this will save time when each channel is clicked and waiting for
// timeouts."* Measured history says the same thing from the other end: Sky News FHD carries E-AC-3
// first (undecodable in Chrome) and Batman Begins is E-AC-3 5.1 inside Matroska — both play *nothing*
// for 10-30 seconds before the fallback notices and starts converting.
//
// There was already a client-side hint (`lib/transcodeHints.ts`, localStorage, per device, 14 days),
// and it worked — but it was per device and rebuilt on every new browser, and it could not be
// consulted by the *server*, which is where the transcoder actually is. This is the same idea with
// the state where it belongs: one row per channel in the app's own database, in the persisted volume,
// so it survives image updates, is shared by every device in the house, and can be read by anything
// that needs it.
//
// Two rules keep it honest, and both matter more than the caching does:
//
//   1. **A plan is a bet, not a fact.** Upstream re-encodes happen, providers swap feeds, and a
//      browser that once could not decode something may have been updated. So every plan carries the
//      moment it was proved, expires after `PLAN_TTL_MS`, and — the important half — is **dropped the
//      moment it fails**: `markFailed` forgets what was learned so the next play discovers it again
//      rather than repeating a wrong answer for a month.
//   2. **Failure is information.** A channel that needed the video tier last time and does not need
//      it now would burn a needless transcode for ever, so a plan is only ever written from a
//      *successful* playback, never from an attempt.

/** How long a plan is trusted before the channel is re-discovered once. */
export const PLAN_TTL_MS = 30 * 24 * 3_600_000

export interface ChannelPlan {
  key: string
  /** The video re-encode tier (H.264) was needed, not just the audio remux. */
  video: boolean
  /** The audio had to be re-encoded (Dolby in a browser with no AC-3 decoder). */
  audio: boolean
  /** When playback last proved this plan worked. */
  verifiedAt: number
  /** Consecutive failures since, if any — a non-zero value means "reassess before trusting". */
  failures: number
  note: string | null
}

/** Fresh *and* unproven-broken: the only state the player should act on without re-checking. */
export function planIsTrustworthy(plan: ChannelPlan | null, now: number = Date.now()): boolean {
  if (!plan) return false
  if (plan.failures > 0) return false
  if (!Number.isFinite(plan.verifiedAt)) return false
  return now - plan.verifiedAt <= PLAN_TTL_MS
}

/** One line for the diagnostics panel. */
export function describePlan(plan: ChannelPlan | null, now: number = Date.now()): string {
  if (!plan) return 'unknown — this channel has not been proved yet'
  const parts = [plan.video ? 'video re-encode' : 'video copy', plan.audio ? 'audio re-encode' : 'audio copy']
  const ageMs = now - plan.verifiedAt
  const age = ageMs < 3_600_000 ? `${Math.round(ageMs / 60_000)} min` : `${Math.round(ageMs / 3_600_000)} h`
  if (!planIsTrustworthy(plan, now)) {
    return `last known: ${parts.join(', ')} — but ${plan.failures > 0 ? 'it failed since' : 'stale'}, so it will be re-discovered`
  }
  return `${parts.join(', ')} — proved ${age} ago`
}

export interface ChannelPlansStore {
  list(owner: string): ChannelPlan[]
  record(owner: string, key: string, plan: { video: boolean; audio: boolean; note?: string | null }): ChannelPlan
  /** The plan failed: forget what was learned so the next play discovers it fresh. */
  markFailed(owner: string, key: string, note?: string | null): void
  forget(owner: string, key: string): void
}

interface Row {
  channel_key: string
  video: number
  audio: number
  verified_at: number
  failures: number
  note: string | null
}

export function createChannelPlansStore(opts: { dataDir: string }): ChannelPlansStore {
  let handle: ReturnType<typeof openDatabase> | null = null
  const db = (): Database => {
    if (!handle) handle = openDatabase(opts.dataDir)
    return handle.db
  }

  function ensureTable(): void {
    db().exec(`
      CREATE TABLE IF NOT EXISTS channel_plans (
        owner TEXT NOT NULL,
        channel_key TEXT NOT NULL,
        video INTEGER NOT NULL DEFAULT 0,
        audio INTEGER NOT NULL DEFAULT 0,
        verified_at INTEGER NOT NULL,
        failures INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        PRIMARY KEY (owner, channel_key)
      )
    `)
  }

  function toPlan(row: Row): ChannelPlan {
    return {
      key: row.channel_key,
      video: row.video === 1,
      audio: row.audio === 1,
      verifiedAt: row.verified_at,
      failures: row.failures,
      note: row.note
    }
  }

  return {
    list(owner: string): ChannelPlan[] {
      try {
        ensureTable()
        const rows = db()
          .prepare('SELECT channel_key, video, audio, verified_at, failures, note FROM channel_plans WHERE owner = ?')
          .all(owner) as Row[]
        return rows.map(toPlan)
      } catch (err) {
        // A cache that cannot be read is a cache miss, never a failed playback.
        console.error('[plans] could not read channel plans:', err instanceof Error ? err.message : err)
        return []
      }
    },

    record(owner: string, key: string, plan: { video: boolean; audio: boolean; note?: string | null }): ChannelPlan {
      ensureTable()
      const verifiedAt = Date.now()
      db()
        .prepare(
          `INSERT INTO channel_plans (owner, channel_key, video, audio, verified_at, failures, note)
           VALUES (?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(owner, channel_key) DO UPDATE SET
             video = excluded.video,
             audio = excluded.audio,
             verified_at = excluded.verified_at,
             failures = 0,
             note = excluded.note`
        )
        .run(owner, key, plan.video ? 1 : 0, plan.audio ? 1 : 0, verifiedAt, plan.note ?? null)
      return { key, video: plan.video, audio: plan.audio, verifiedAt, failures: 0, note: plan.note ?? null }
    },

    markFailed(owner: string, key: string, note?: string | null): void {
      try {
        ensureTable()
        // Deliberately does NOT keep the learned values: a plan that failed is a plan to re-discover,
        // and keeping the flags is exactly the trap this store exists to avoid.
        db()
          .prepare('DELETE FROM channel_plans WHERE owner = ? AND channel_key = ?')
          .run(owner, key)
        if (note) console.warn(`[plans] ${key} failed (${note}) — it will be re-discovered on the next play`)
      } catch (err) {
        console.error('[plans] could not clear a failed plan:', err instanceof Error ? err.message : err)
      }
    },

    forget(owner: string, key: string): void {
      try {
        ensureTable()
        db().prepare('DELETE FROM channel_plans WHERE owner = ? AND channel_key = ?').run(owner, key)
      } catch (err) {
        console.error('[plans] could not forget a plan:', err instanceof Error ? err.message : err)
      }
    }
  }
}
