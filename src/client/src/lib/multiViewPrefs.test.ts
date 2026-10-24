import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MULTI_VIEW_PREFS,
  loadMultiViewPrefs,
  resizeSlots,
  saveMultiViewPrefs,
  toggleActiveAudio,
  type MultiViewSlot
} from './multiViewPrefs'

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    }
  }
}

const SLOT: MultiViewSlot = { streamId: 41154, name: 'Sky Sports+ FHD' }

describe('resizeSlots', () => {
  it('grows by padding with empty slots', () => {
    expect(resizeSlots([SLOT], 4)).toEqual([SLOT, null, null, null])
    expect(resizeSlots([], 2)).toEqual([null, null])
  })

  it('shrinks by dropping the overflow, keeping the head', () => {
    const slots = [SLOT, { streamId: 2, name: 'Two' }, { streamId: 3, name: 'Three' }, null]
    expect(resizeSlots(slots, 2)).toEqual([SLOT, { streamId: 2, name: 'Two' }])
  })

  it('returns the same array when the size already matches', () => {
    const slots: Array<MultiViewSlot | null> = [SLOT, null]
    expect(resizeSlots(slots, 2)).toBe(slots)
  })
})

describe('toggleActiveAudio', () => {
  it('unmutes a silent tile and moves the audio between tiles', () => {
    expect(toggleActiveAudio(null, 1)).toBe(1)
    expect(toggleActiveAudio(0, 1)).toBe(1)
  })

  it('re-mutes the active tile when it is clicked again', () => {
    expect(toggleActiveAudio(1, 1)).toBeNull()
  })
})

describe('load/save round-trip', () => {
  it('persists and restores a full tile set with layout', () => {
    const storage = fakeStorage()
    saveMultiViewPrefs({ layout: 4, slots: [SLOT, null, { streamId: 668, name: 'Main Event UHD', playlistId: 'p2' }, null] }, storage)
    expect(loadMultiViewPrefs(storage)).toEqual({
      layout: 4,
      slots: [SLOT, null, { streamId: 668, name: 'Main Event UHD', playlistId: 'p2' }, null]
    })
  })

  it('answers the defaults when nothing was saved or storage is unavailable', () => {
    expect(loadMultiViewPrefs(fakeStorage())).toEqual(DEFAULT_MULTI_VIEW_PREFS)
    expect(loadMultiViewPrefs(null)).toEqual(DEFAULT_MULTI_VIEW_PREFS)
  })

  it('drops corrupt entries rather than failing the whole grid', () => {
    const storage = fakeStorage({
      'iptv:multi-view-prefs': JSON.stringify({
        layout: 4,
        slots: [SLOT, { streamId: 'not-a-number', name: 'Broken' }, { name: 'No id' }, 'junk', { streamId: -3, name: 'Negative' }]
      })
    })
    expect(loadMultiViewPrefs(storage)).toEqual({ layout: 4, slots: [SLOT, null, null, null] })
  })

  it('falls back to a clean layout-2 grid when the saved shape is unparseable', () => {
    const storage = fakeStorage({ 'iptv:multi-view-prefs': 'not json at all{' })
    expect(loadMultiViewPrefs(storage)).toEqual(DEFAULT_MULTI_VIEW_PREFS)
    const noSlots = fakeStorage({ 'iptv:multi-view-prefs': JSON.stringify({ layout: 4 }) })
    expect(loadMultiViewPrefs(noSlots)).toEqual({ layout: 4, slots: [null, null, null, null] })
  })

  it('normalizes an unknown layout to 2', () => {
    const storage = fakeStorage({ 'iptv:multi-view-prefs': JSON.stringify({ layout: 9, slots: [SLOT] }) })
    expect(loadMultiViewPrefs(storage).layout).toBe(2)
    expect(loadMultiViewPrefs(storage).slots).toEqual([SLOT, null])
  })
})
