import { describe, expect, it } from 'vitest'
import { channelMatchKey, buildAlsoOnIndex, type PlaylistChannels } from './crossPlaylist.js'
import type { LiveStream } from './types.js'

// The manual "also on →" switch (v0.78.0): the operator sees that the other line has the
// channel and switches by hand. The key is ported from the server's playlists.ts (tests and
// all), so both sides of the app match channels the same way.

const asLive = (streamId: number, name: string, category: string, playlistId?: string, playlistLabel?: string): LiveStream => ({
  num: 0,
  name,
  stream_type: 'live',
  stream_id: streamId,
  stream_icon: '',
  epg_channel_id: null,
  added: '',
  category_id: category,
  custom_sid: null,
  tv_archive: 0,
  direct_source: '',
  tv_archive_duration: 0,
  ...(playlistId ? { playlistId, playlistLabel } : {})
})

const others: PlaylistChannels[] = [
  {
    id: 'p2',
    label: 'Backup',
    channels: [
      asLive(668, 'UK: Sky Sports Main Event UHD', 'UK Sports', 'p2', 'Backup'),
      asLive(101, 'BBC One HD', 'Entertainment', 'p2', 'Backup')
    ]
  },
  {
    id: 'p3',
    label: 'Third line',
    channels: [asLive(90210, 'Sky Sports Main Event FHD', 'Sports', 'p3', 'Third line')]
  }
]

describe('channelMatchKey (ported from playlists.ts)', () => {
  it('matches the same channel across two providers, which renumber everything', () => {
    // Ids are provider-scoped: the same channel has different ids on each line, and the same id can
    // mean different channels. Name and category are what a person would match on.
    const a = channelMatchKey({ name: 'UK: Sky Sports Main Event UHD', category: 'UK Sports' })
    const b = channelMatchKey({ name: 'Sky Sports Main Event', category: 'uk sports' })
    expect(a).toBe(b)
  })

  it('separates channels that really are different', () => {
    const main = channelMatchKey({ name: 'Sky Sports Main Event', category: 'Sports' })
    const f1 = channelMatchKey({ name: 'Sky Sports F1', category: 'Sports' })
    expect(main).not.toBe(f1)
  })

  it('ignores punctuation, case and quality suffixes, but not a missing category', () => {
    expect(channelMatchKey({ name: 'Sky News HD' })).toBe(channelMatchKey({ name: 'sky news' }))
    expect(channelMatchKey({ name: 'Sky News', category: 'News' })).not.toBe(
      channelMatchKey({ name: 'Sky News', category: 'Sports' })
    )
  })
})

describe('buildAlsoOnIndex', () => {
  it('finds the same channel on the other playlists, normalising region tags and quality words', () => {
    const alsoOn = buildAlsoOnIndex(others)
    const matches = alsoOn({ name: 'Sky Sports Main Event' }, '')
    // Name-only matching (see buildAlsoOnIndex): the providers spell the category differently
    // ("UK Sports" vs "Sports") and the offer must survive that.
    expect(matches.map((m) => m.playlistId).sort()).toEqual(['p2', 'p3'])
    expect(matches[0].channel.playlistLabel).toBe('Backup')
    // The matched channel is the other playlist's own row — playing it goes through the
    // ordinary select path, which routes it through that playlist's scoped relay.
    expect(matches[0].channel.stream_id).toBe(668)
  })

  it('never suggests the playlist the row already belongs to', () => {
    const alsoOn = buildAlsoOnIndex(others)
    // The backup's own main-event row only offers the third line.
    const fromBackup = alsoOn({ name: 'UK: Sky Sports Main Event' }, 'p2')
    expect(fromBackup.map((m) => m.playlistId)).toEqual(['p3'])
    // And a row for a channel only the backup has, offers nothing from the backup itself.
    const bbc = alsoOn({ name: 'BBC One' }, 'p2')
    expect(bbc).toEqual([])
    expect(alsoOn({ name: 'BBC One' }, '').map((m) => m.playlistId)).toEqual(['p2'])
  })

  it('answers nothing when no other line carries the channel', () => {
    const alsoOn = buildAlsoOnIndex(others)
    expect(alsoOn({ name: 'Channel Only I Have' }, '')).toEqual([])
  })
})
