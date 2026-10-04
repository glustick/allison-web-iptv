import type { Database } from 'better-sqlite3'
import { openDatabase } from './db.js'

// Manual channel→guide mappings (v0.76.0): the operator's answer to the matching layer's
// deliberate conservatism. The automatic tiers (exact id → normalized id → exact name →
// unambiguous fuzzy) refuse to guess, so a channel whose name genuinely differs from every
// guide entry — "BBC One HD London" against a guide that only lists "BBC One HD", a provider
// that renames channels wholesale — stays unmapped, and the EPG grid shows it with no
// programmes. A manual mapping is the operator's override: it wins over every automatic tier,
// and clearing it hands the decision back.
//
// Account-scoped (like favourites/history — see prefsStore.ts), because guide sources are
// configured per deployment but the matching is judged against a provider's channel list that
// is per account; two accounts on different providers cannot share mappings. The channel key is
// the Xtream stream id as a string, so the row survives a provider renumbering the same way a
// favourite's denormalised name does — and the denormalised channel name is kept for the same
// reason: a provider dropping/renaming a channel must not silently blank the operator's intent.
//
// There is deliberately one mapping per channel (the grid needs ONE guide channel's programmes);
// setting a new one replaces the old. The guide channel id is stored verbatim — the id space
// belongs to the guide source, and the epgService resolves which source a mapping's guide lives
// in at read time (a mapping whose guide channel no longer exists simply matches nothing, the
// same as an unmapped channel, rather than corrupting another channel's row).

export interface GuideMapping {
  streamId: number
  /** The channel's name at mapping time, kept for display when the provider drops the channel. */
  channelName: string
  /** The guide channel id this channel is pinned to. */
  guideChannelId: string
  /** The guide channel's display name at mapping time, for the UI without a guide lookup. */
  guideChannelName: string
  setAt: number
}

export interface GuideMappingsStore {
  /** The mapping for one stream, or null. */
  get(owner: string, streamId: number): GuideMapping | null
  /** Every mapping the account has set, most recently set first. */
  list(owner: string): GuideMapping[]
  /** Sets (or replaces) the mapping for one stream. */
  set(owner: string, mapping: Omit<GuideMapping, 'setAt'>): GuideMapping
  /** Clears the mapping for one stream. Returns whether a row was removed. */
  clear(owner: string, streamId: number): boolean
}

const MAX_MAPPINGS_PER_USER = 2000

export function createGuideMappingsStore(opts: { dataDir: string }): GuideMappingsStore {
  let handle: ReturnType<typeof openDatabase> | null = null
  const db = (): Database => {
    if (!handle) handle = openDatabase(opts.dataDir)
    return handle.db
  }

  function ensureTable(): void {
    db().exec(`
      CREATE TABLE IF NOT EXISTS guide_mappings (
        owner TEXT NOT NULL,
        stream_id INTEGER NOT NULL,
        channel_name TEXT NOT NULL,
        guide_channel_id TEXT NOT NULL,
        guide_channel_name TEXT NOT NULL,
        set_at INTEGER NOT NULL,
        PRIMARY KEY (owner, stream_id)
      )
    `)
  }

  const rowToMapping = (row: {
    stream_id: number
    channel_name: string
    guide_channel_id: string
    guide_channel_name: string
    set_at: number
  }): GuideMapping => ({
    streamId: row.stream_id,
    channelName: row.channel_name,
    guideChannelId: row.guide_channel_id,
    guideChannelName: row.guide_channel_name,
    setAt: row.set_at
  })

  return {
    get(owner: string, streamId: number): GuideMapping | null {
      ensureTable()
      const row = db()
        .prepare('SELECT stream_id, channel_name, guide_channel_id, guide_channel_name, set_at FROM guide_mappings WHERE owner = ? AND stream_id = ?')
        .get(owner, streamId) as Parameters<typeof rowToMapping>[0] | undefined
      return row ? rowToMapping(row) : null
    },

    list(owner: string): GuideMapping[] {
      ensureTable()
      const rows = db()
        .prepare('SELECT stream_id, channel_name, guide_channel_id, guide_channel_name, set_at FROM guide_mappings WHERE owner = ? ORDER BY set_at DESC, stream_id DESC')
        .all(owner) as Parameters<typeof rowToMapping>[0][]
      return rows.map(rowToMapping)
    },

    set(owner: string, mapping: Omit<GuideMapping, 'setAt'>): GuideMapping {
      ensureTable()
      const setAt = Date.now()
      db()
        .prepare(
          `INSERT INTO guide_mappings (owner, stream_id, channel_name, guide_channel_id, guide_channel_name, set_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (owner, stream_id) DO UPDATE SET
             channel_name = excluded.channel_name,
             guide_channel_id = excluded.guide_channel_id,
             guide_channel_name = excluded.guide_channel_name,
             set_at = excluded.set_at`
        )
        .run(owner, mapping.streamId, mapping.channelName, mapping.guideChannelId, mapping.guideChannelName, setAt)
      // Bounded, like every per-user table: the oldest-set mappings go first when the cap is
      // hit. Reaching this at all means two thousand hand-made decisions, which is a household
      // curating, not a loop.
      db()
        .prepare(
          `DELETE FROM guide_mappings WHERE owner = ? AND stream_id NOT IN (
             SELECT stream_id FROM guide_mappings WHERE owner = ? ORDER BY set_at DESC, stream_id DESC LIMIT ?
           )`
        )
        .run(owner, owner, MAX_MAPPINGS_PER_USER)
      return { ...mapping, setAt }
    },

    clear(owner: string, streamId: number): boolean {
      ensureTable()
      const result = db().prepare('DELETE FROM guide_mappings WHERE owner = ? AND stream_id = ?').run(owner, streamId)
      return result.changes > 0
    }
  }
}
