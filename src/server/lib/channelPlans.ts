import type { Database } from 'better-sqlite3'
import { openDatabase } from './db.js'

// What each channel needs, remembered once and shared.
//
// The problem this exists for, in the operator's words (2026-09-28): *"rather than discovering each
// time we click a channel … this will save time when each channel is clicked and waiting for
// timeouts."* Measured history says the same from the other end: Sky News FHD carries E-AC-3 first
// (undecodable in Chrome) and Batman Begins is E-AC-3 5.1 inside Matroska — both play *nothing* for
// 10-30 seconds before the fallback notices and starts converting.
//
// There was already a client-side hint (`lib/transcodeHints.ts`, localStorage, per device, 14 days),
// and it worked — but it was per device and rebuilt on every new browser. This is the same idea with
// the state where it belongs: the app's own database, in the persisted volume, so it survives image
// updates and is shared by every device.
//
// A row carries two different kinds of thing, and the difference matters:
//
//   - **Facts** — the codecs the stream actually carries (`videoCodec`, `audioCodecs`), learned by
//     probing it. Cheap to trust, expensive to fetch: an ffprobe against a live source is the round
//     trip this store exists to remove, so facts are kept even for channels nobody has played yet.
//     They expire after `FACTS_TTL_MS` because a provider can swap a feed.
//   - **A plan** — whether this channel needed the video re-encode tier and whether its audio had to
//     be re-encoded. A plan is a **bet, not a fact**: it is only ever written from a playback that
//     *worked* (`proved`), it expires, and it is **dropped the moment it fails**, so a wrong answer
//     is re-discovered once instead of repeated for a month.

/** How long a proved plan is trusted before the channel is re-discovered once. */
export const PLAN_TTL_MS = 30 * 24 * 3_600_000

/** How long probed codecs are trusted. Shorter: providers swap feeds, and a fact is not a proof. */
export const FACTS_TTL_MS = 7 * 24 * 3_600_000

export interface ChannelPlan {
  key: string
  /** The video re-encode tier (H.264) was needed, not just the audio remux. */
  video: boolean
  /** The audio had to be re-encoded (Dolby in a browser with no AC-3 decoder). */
  audio: boolean
  /** When playback last proved this plan worked (0 when only facts are known). */
  verifiedAt: number
  /** True once a playback has proved this plan; facts-only rows are not plans. */
  proved: boolean
  /** Consecutive failures since, if any — a non-zero value means "reassess before trusting". */
  failures: number
  note: string | null
  /** The video codec the stream carries, as ffmpeg names it, when it has been probed. */
  videoCodec: string | null
  /** The audio codecs the stream carries, in track order, when it has been probed. */
  audioCodecs: string[]
  /** When the codecs above were learned (0 when never). */
  factsAt: number
}

export interface ProbedFacts {
  videoCodec: string | null
  audioCodecs: string[]
}

/** Fresh *and* proved *and* unbroken: the only state the player should act on without re-checking. */
export function planIsTrustworthy(plan: ChannelPlan | null, now: number = Date.now()): boolean {
  if (!plan) return false
  if (!plan.proved) return false
  if (plan.failures > 0) return false
  if (!Number.isFinite(plan.verifiedAt)) return false
  return now - plan.verifiedAt <= PLAN_TTL_MS
}

/** Fresh probed codecs, usable without asking the provider anything. */
export function factsAreFresh(plan: ChannelPlan | null, now: number = Date.now()): plan is ChannelPlan {
  if (!plan) return false
  if (!plan.videoCodec && plan.audioCodecs.length === 0) return false
  if (!Number.isFinite(plan.factsAt) || plan.factsAt <= 0) return false
  return now - plan.factsAt <= FACTS_TTL_MS
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
  record(
    owner: string,
    key: string,
    plan: { video: boolean; audio: boolean; note?: string | null; facts?: ProbedFacts }
  ): ChannelPlan
  /** Codecs learned by probing — kept even before any playback, since fetching them is the cost. */
  rememberFacts(owner: string, key: string, facts: ProbedFacts): void
  /** The plan failed: forget what was learned so the next play discovers it fresh. */
  markFailed(owner: string, key: string, note?: string | null): void
  forget(owner: string, key: string): void
}

interface Row {
  channel_key: string
  video: number
  audio: number
  verified_at: number
  proved: number
  failures: number
  note: string | null
  video_codec: string | null
  audio_codecs: string | null
  facts_at: number
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
        verified_at INTEGER NOT NULL DEFAULT 0,
        proved INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        video_codec TEXT,
        audio_codecs TEXT,
        facts_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (owner, channel_key)
      )
    `)
    // An installation that ran v0.61.0 has the older, narrower table. Additive, and checked rather
    // than attempted: ALTER TABLE has no IF NOT EXISTS, and a failure here must not stop the app.
    const columns = new Set(
      (db().prepare('PRAGMA table_info(channel_plans)').all() as Array<{ name?: string }>).map((column) => column.name)
    )
    for (const [name, definition] of [
      ['proved', 'INTEGER NOT NULL DEFAULT 0'],
      ['video_codec', 'TEXT'],
      ['audio_codecs', 'TEXT'],
      ['facts_at', 'INTEGER NOT NULL DEFAULT 0']
    ] as const) {
      if (!columns.has(name)) db().exec(`ALTER TABLE channel_plans ADD COLUMN ${name} ${definition}`)
    }
  }

  function toPlan(row: Row): ChannelPlan {
    let audioCodecs: string[] = []
    try {
      const parsed = row.audio_codecs ? (JSON.parse(row.audio_codecs) as unknown) : []
      audioCodecs = Array.isArray(parsed) ? parsed.filter((codec): codec is string => typeof codec === 'string') : []
    } catch {
      audioCodecs = []
    }
    return {
      key: row.channel_key,
      video: row.video === 1,
      audio: row.audio === 1,
      verifiedAt: row.verified_at,
      proved: row.proved === 1,
      failures: row.failures,
      note: row.note,
      videoCodec: row.video_codec,
      audioCodecs,
      factsAt: row.facts_at
    }
  }

  const SELECT = `SELECT channel_key, video, audio, verified_at, proved, failures, note, video_codec, audio_codecs, facts_at FROM channel_plans`

  return {
    list(owner: string): ChannelPlan[] {
      try {
        ensureTable()
        const rows = db().prepare(`${SELECT} WHERE owner = ?`).all(owner) as Row[]
        return rows.map(toPlan)
      } catch (err) {
        // A cache that cannot be read is a cache miss, never a failed playback.
        console.error('[plans] could not read channel plans:', err instanceof Error ? err.message : err)
        return []
      }
    },

    record(owner, key, plan): ChannelPlan {
      ensureTable()
      const verifiedAt = Date.now()
      const facts = plan.facts
      db()
        .prepare(
          `INSERT INTO channel_plans (owner, channel_key, video, audio, verified_at, proved, failures, note, video_codec, audio_codecs, facts_at)
           VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)
           ON CONFLICT(owner, channel_key) DO UPDATE SET
             video = excluded.video,
             audio = excluded.audio,
             verified_at = excluded.verified_at,
             proved = 1,
             failures = 0,
             note = excluded.note,
             video_codec = COALESCE(excluded.video_codec, channel_plans.video_codec),
             audio_codecs = COALESCE(excluded.audio_codecs, channel_plans.audio_codecs),
             facts_at = MAX(excluded.facts_at, channel_plans.facts_at)`
        )
        .run(
          owner,
          key,
          plan.video ? 1 : 0,
          plan.audio ? 1 : 0,
          verifiedAt,
          plan.note ?? null,
          facts?.videoCodec ?? null,
          facts ? JSON.stringify(facts.audioCodecs) : null,
          facts ? verifiedAt : 0
        )
      return {
        key,
        video: plan.video,
        audio: plan.audio,
        verifiedAt,
        proved: true,
        failures: 0,
        note: plan.note ?? null,
        videoCodec: facts?.videoCodec ?? null,
        audioCodecs: facts?.audioCodecs ?? [],
        factsAt: facts ? verifiedAt : 0
      }
    },

    rememberFacts(owner: string, key: string, facts: ProbedFacts): void {
      try {
        ensureTable()
        // Deliberately does not touch `proved` or `verified_at`: knowing what a stream *is* is not the
        // same as knowing it plays, and claiming otherwise would let a probe masquerade as a proof.
        db()
          .prepare(
            `INSERT INTO channel_plans (owner, channel_key, video_codec, audio_codecs, facts_at, verified_at)
             VALUES (?, ?, ?, ?, ?, 0)
             ON CONFLICT(owner, channel_key) DO UPDATE SET
               video_codec = excluded.video_codec,
               audio_codecs = excluded.audio_codecs,
               facts_at = excluded.facts_at`
          )
          .run(owner, key, facts.videoCodec, JSON.stringify(facts.audioCodecs), Date.now())
      } catch (err) {
        console.error('[plans] could not remember probed codecs:', err instanceof Error ? err.message : err)
      }
    },

    markFailed(owner: string, key: string, note?: string | null): void {
      try {
        ensureTable()
        // Deliberately does NOT keep the learned *plan*: a plan that failed is a plan to re-discover,
        // and keeping the flags is exactly the trap this store exists to avoid. The probed codecs are
        // kept — they are facts about the stream, and the failure says nothing about them.
        db()
          .prepare(
            `UPDATE channel_plans SET proved = 0, verified_at = 0, failures = failures + 1, video = 0, audio = 0
             WHERE owner = ? AND channel_key = ?`
          )
          .run(owner, key)
        // A row with nothing left on it is not worth keeping.
        db()
          .prepare(
            `DELETE FROM channel_plans
             WHERE owner = ? AND channel_key = ? AND proved = 0 AND video_codec IS NULL AND audio_codecs IS NULL`
          )
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
