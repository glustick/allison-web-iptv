import { describe, expect, it } from 'vitest'
import { libraryEntryIsStale, providerLookup, resolveLibraryEntry } from './libraryResolve'
import type { LiveStream } from './types'

function channel(id: number, name: string, extra: Partial<LiveStream> = {}): LiveStream {
  return {
    num: 0, name, stream_type: 'live', stream_id: id, stream_icon: '', epg_channel_id: null,
    added: '', category_id: '1', custom_sid: null, tv_archive: 0, direct_source: '',
    tv_archive_duration: 0, ...extra
  } as LiveStream
}

describe('resolveLibraryEntry', () => {
  it("prefers the provider's current entry for the same id", () => {
    const lookup = providerLookup([channel(42783, 'Sky News FHD', { tv_archive: 1, tv_archive_duration: 3 })])
    const found = resolveLibraryEntry({ streamId: 42783, name: 'Sky News FHD', category: 'uk' }, lookup)
    expect(found?.stream_id).toBe(42783)
    expect(found?.tv_archive).toBe(1)
  })

  it('finds a renumbered channel by name — the case that reported "channel unavailable"', () => {
    // saved when it was 37237, the provider now calls it 42783
    const lookup = providerLookup([channel(42783, 'Sky News FHD')])
    const found = resolveLibraryEntry({ streamId: 37237, name: 'Sky News FHD', category: 'uk' }, lookup)
    expect(found?.stream_id).toBe(42783)
  })

  it('matches a name ignoring case and surrounding space', () => {
    const lookup = providerLookup([channel(7, 'Sky News FHD')])
    expect(resolveLibraryEntry({ streamId: 1, name: '  sky news fhd ', category: null }, lookup)?.stream_id).toBe(7)
  })

  it('returns nothing when the channel has genuinely gone', () => {
    const lookup = providerLookup([channel(1, 'BBC One FHD')])
    expect(resolveLibraryEntry({ streamId: 999, name: 'Gone FHD', category: null }, lookup)).toBeNull()
  })

  it('is not stale before anything has loaded, so the UI does not call a good row broken', () => {
    const empty = providerLookup([])
    expect(libraryEntryIsStale({ streamId: 5, name: 'Anything', category: null }, empty)).toBe(false)
  })

  it('reports a row as stale once the list is loaded and the channel is absent', () => {
    const lookup = providerLookup([channel(1, 'BBC One FHD')])
    expect(libraryEntryIsStale({ streamId: 5, name: 'Gone', category: null }, lookup)).toBe(true)
    expect(libraryEntryIsStale({ streamId: 1, name: 'BBC One FHD', category: null }, lookup)).toBe(false)
  })
})
