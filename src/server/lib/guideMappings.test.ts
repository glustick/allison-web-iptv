import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createGuideMappingsStore } from './guideMappings.js'
import { openDatabase } from './db.js'

// The operator's override for channels the conservative matcher cannot resolve. The contracts
// that matter: one mapping per channel (replacing, not stacking), account isolation, a cap
// so a runaway client cannot grow the table without bound — and, since v0.78.0, the playlist
// dimension: two playlists can hand out the same stream id (even under the same provider
// username) without sharing a mapping.

const MAPPING = {
  streamId: 668,
  channelName: 'Sky Sports Main Event UHD',
  guideChannelId: 'sky-sports-main-event-uhd.example',
  guideChannelName: 'Sky Sports Main Event'
}

describe('guideMappingsStore', () => {
  let dataDir: string
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'allisoniptv-guide-mappings-'))
  })
  function fresh(): ReturnType<typeof createGuideMappingsStore> {
    return createGuideMappingsStore({ dataDir })
  }

  it('sets, gets, and clears one mapping', () => {
    const store = fresh()
    expect(store.get('tester', '', MAPPING.streamId)).toBeNull()

    const set = store.set('tester', '', MAPPING)
    expect(set.setAt).toBeGreaterThan(0)
    expect(set.playlistId).toBe('')
    expect(store.get('tester', '', MAPPING.streamId)).toEqual(set)

    expect(store.clear('tester', '', MAPPING.streamId)).toBe(true)
    expect(store.get('tester', '', MAPPING.streamId)).toBeNull()
    expect(store.clear('tester', '', MAPPING.streamId)).toBe(false)
  })

  it('replaces rather than stacks: one mapping per channel', () => {
    const store = fresh()
    store.set('tester', '', MAPPING)
    const changed = store.set('tester', '', { ...MAPPING, guideChannelId: 'other.example', guideChannelName: 'Other' })
    const got = store.get('tester', '', MAPPING.streamId)
    expect(got?.guideChannelId).toBe('other.example')
    expect(store.list('tester', '')).toEqual([changed])
  })

  it('isolates accounts — one household member’s mappings are nobody else’s', () => {
    const store = fresh()
    store.set('tester', '', MAPPING)
    expect(store.get('someone-else', '', MAPPING.streamId)).toBeNull()
    expect(store.list('someone-else', '')).toEqual([])
  })

  it('lists most-recently-set first', () => {
    const store = fresh()
    store.set('tester', '', MAPPING)
    const second = store.set('tester', '', { ...MAPPING, streamId: 669, channelName: 'Sky Sports F1 UHD' })
    const list = store.list('tester', '')
    expect(list).toHaveLength(2)
    expect(list[0]?.streamId).toBe(second.streamId)
  })

  it('is bounded: past the cap, the oldest mappings are evicted across playlists', () => {
    const store = fresh()
    for (let i = 0; i < 2005; i++) {
      store.set('tester', i % 2 === 0 ? '' : 'p2', { ...MAPPING, streamId: i, channelName: `Channel ${i}` })
    }
    const list = store.list('tester', '').concat(store.list('tester', 'p2'))
    expect(list.length).toBeLessThanOrEqual(2000)
    // The most recent survive (whichever playlist they are on); the earliest are gone.
    expect(store.get('tester', '', 0)).toBeNull()
    // Even ids went to '' (primary), odd ids to 'p2'.
    expect(store.get('tester', '', 2004)).not.toBeNull()
    expect(store.get('tester', 'p2', 2003)).not.toBeNull()
  })

  it('keeps same-id playlists apart — the playlist dimension is part of the key', () => {
    const store = fresh()
    const primary = store.set('tester', '', MAPPING)
    const backup = store.set('tester', 'p2', { ...MAPPING, guideChannelId: 'backup-feed.example', guideChannelName: 'Backup Feed' })
    // Same provider username, same stream id, different playlists: two independent mappings.
    expect(store.get('tester', '', 668)?.guideChannelId).toBe('sky-sports-main-event-uhd.example')
    expect(store.get('tester', 'p2', 668)?.guideChannelId).toBe('backup-feed.example')
    expect(store.list('tester', '')).toEqual([primary])
    expect(store.list('tester', 'p2')).toEqual([backup])
    // Clearing one leaves the other untouched.
    expect(store.clear('tester', '', 668)).toBe(true)
    expect(store.get('tester', 'p2', 668)).not.toBeNull()
  })

  it('survives a store rebuild (the same database reopened)', () => {
    const first = createGuideMappingsStore({ dataDir })
    first.set('tester', '', MAPPING)
    const second = createGuideMappingsStore({ dataDir })
    expect(second.get('tester', '', MAPPING.streamId)?.guideChannelId).toBe(MAPPING.guideChannelId)
  })

  it('migrates a pre-playlist database: rows come back as primary-playlist mappings', () => {
    // Build the old-shape table by hand, exactly as v0.76.x wrote it, then open the store on it.
    const legacy = openDatabase(dataDir)
    legacy.db.exec(`
      CREATE TABLE guide_mappings (
        owner TEXT NOT NULL,
        stream_id INTEGER NOT NULL,
        channel_name TEXT NOT NULL,
        guide_channel_id TEXT NOT NULL,
        guide_channel_name TEXT NOT NULL,
        set_at INTEGER NOT NULL,
        PRIMARY KEY (owner, stream_id)
      )
    `)
    legacy.db
      .prepare(
        'INSERT INTO guide_mappings (owner, stream_id, channel_name, guide_channel_id, guide_channel_name, set_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run('tester', 668, MAPPING.channelName, MAPPING.guideChannelId, MAPPING.guideChannelName, 1700000000000)
    legacy.close()

    const store = fresh()
    const got = store.get('tester', '', 668)
    expect(got?.guideChannelId).toBe(MAPPING.guideChannelId)
    expect(got?.playlistId).toBe('')
    // And the migrated row still participates in the new key: it never bleeds into p2.
    expect(store.get('tester', 'p2', 668)).toBeNull()
    // The widened table keeps its replace semantics after the rebuild.
    store.set('tester', '', { ...MAPPING, guideChannelId: 'replaced.example', guideChannelName: 'Replaced' })
    expect(store.get('tester', '', 668)?.guideChannelId).toBe('replaced.example')
  })
})

describe('setMany (v0.82.0 bulk suggestions)', () => {
  let dataDir: string
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'allisoniptv-guide-mappings-bulk-'))
  })

  it('writes a batch in one transaction; every row reads back with denormalized names', () => {
    const store = createGuideMappingsStore({ dataDir })
    const written = store.setMany('user1', '', [
      { ...MAPPING, streamId: 1 },
      { ...MAPPING, streamId: 2, channelName: 'Second Channel' },
      { ...MAPPING, streamId: 3, guideChannelId: 'other.example', guideChannelName: 'Other Guide Channel' }
    ])
    expect(written).toBe(3)
    expect(store.get('user1', '', 2)).toMatchObject({ channelName: 'Second Channel', guideChannelName: MAPPING.guideChannelName })
    expect(store.get('user1', '', 3)).toMatchObject({ guideChannelId: 'other.example', guideChannelName: 'Other Guide Channel' })
    expect(store.list('user1', '').length).toBe(3)
  })

  it('replaces existing mappings rather than stacking, same as set()', () => {
    const store = createGuideMappingsStore({ dataDir })
    store.set('user1', '', { ...MAPPING, streamId: 1, guideChannelId: 'old.example' })
    store.setMany('user1', '', [{ ...MAPPING, streamId: 1, guideChannelId: 'new.example' }])
    expect(store.get('user1', '', 1)?.guideChannelId).toBe('new.example')
    expect(store.list('user1', '').length).toBe(1)
  })

  it('answers zero and writes nothing for an empty batch', () => {
    const store = createGuideMappingsStore({ dataDir })
    expect(store.setMany('user1', '', [])).toBe(0)
    expect(store.list('user1', '')).toEqual([])
  })

  it('enforces the per-owner cap once for the whole batch, keeping the newest', () => {
    const store = createGuideMappingsStore({ dataDir })
    // Pre-fill all but two slots, then apply a batch of three: one of them must be evicted
    // (the oldest-set row), not the batch rejected — and the eviction happens once, after
    // the batch, so the batch itself is never partially truncated.
    const filler = Array.from({ length: 1998 }, (_, i) => ({
      streamId: 10_000 + i,
      channelName: `Filler ${i}`,
      guideChannelId: `filler-${i}.example`,
      guideChannelName: `Filler ${i}`
    }))
    store.setMany('user1', '', filler)
    const written = store.setMany('user1', '', [
      { ...MAPPING, streamId: 1 },
      { ...MAPPING, streamId: 2 },
      { ...MAPPING, streamId: 3 }
    ])
    expect(written).toBe(3)
    expect(store.list('user1', '').length).toBe(2000)
    // The batch's rows survive; the oldest filler went.
    expect(store.get('user1', '', 1)).not.toBeNull()
    expect(store.get('user1', '', 3)).not.toBeNull()
    expect(store.get('user1', '', 10_000)).toBeNull()
  })
})
