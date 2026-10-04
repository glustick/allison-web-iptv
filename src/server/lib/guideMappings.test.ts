import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createGuideMappingsStore } from './guideMappings.js'

// The operator's override for channels the conservative matcher cannot resolve. The contracts
// that matter: one mapping per channel (replacing, not stacking), account isolation, and a cap
// so a runaway client cannot grow the table without bound.

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
    expect(store.get('tester', MAPPING.streamId)).toBeNull()

    const set = store.set('tester', MAPPING)
    expect(set.setAt).toBeGreaterThan(0)
    expect(store.get('tester', MAPPING.streamId)).toEqual(set)

    expect(store.clear('tester', MAPPING.streamId)).toBe(true)
    expect(store.get('tester', MAPPING.streamId)).toBeNull()
    expect(store.clear('tester', MAPPING.streamId)).toBe(false)
  })

  it('replaces rather than stacks: one mapping per channel', () => {
    const store = fresh()
    store.set('tester', MAPPING)
    const changed = store.set('tester', { ...MAPPING, guideChannelId: 'other.example', guideChannelName: 'Other' })
    const got = store.get('tester', MAPPING.streamId)
    expect(got?.guideChannelId).toBe('other.example')
    expect(store.list('tester')).toEqual([changed])
  })

  it('isolates accounts — one household member’s mappings are nobody else’s', () => {
    const store = fresh()
    store.set('tester', MAPPING)
    expect(store.get('someone-else', MAPPING.streamId)).toBeNull()
    expect(store.list('someone-else')).toEqual([])
  })

  it('lists most-recently-set first', () => {
    const store = fresh()
    store.set('tester', MAPPING)
    const second = store.set('tester', { ...MAPPING, streamId: 669, channelName: 'Sky Sports F1 UHD' })
    const list = store.list('tester')
    expect(list).toHaveLength(2)
    expect(list[0]?.streamId).toBe(second.streamId)
  })

  it('is bounded: past the cap, the oldest mappings are evicted', () => {
    const store = fresh()
    for (let i = 0; i < 2005; i++) {
      store.set('tester', { ...MAPPING, streamId: i, channelName: `Channel ${i}` })
    }
    const list = store.list('tester')
    expect(list.length).toBeLessThanOrEqual(2000)
    // The most recent survive; the earliest are gone.
    expect(store.get('tester', 0)).toBeNull()
    expect(store.get('tester', 2004)).not.toBeNull()
  })

  it('survives a store rebuild (the same database reopened)', () => {
    const first = createGuideMappingsStore({ dataDir })
    first.set('tester', MAPPING)
    const second = createGuideMappingsStore({ dataDir })
    expect(second.get('tester', MAPPING.streamId)?.guideChannelId).toBe(MAPPING.guideChannelId)
  })
})
