import { describe, it, expect } from 'vitest'
import {
  MIGRATED_PLAYLIST_ID,
  channelMatchKey,
  nextPlaylistId,
  parsePlaylists,
  primaryPlaylist,
  serializePlaylists,
  type Playlist
} from './playlists.js'

describe('parsePlaylists (migration)', () => {
  it('turns a legacy single-profile blob into one playlist, keeping the account’s own fields', () => {
    // The stored object is not only credentials — epgUrls and alertWebhook live alongside them, and a
    // migration that dropped those would silently take the guide and alerts with it.
    const legacy = {
      server: 'https://provider.example',
      username: 'glustick',
      password: 'secret',
      epgUrls: ['https://guide.example/xmltv.php'],
      alertWebhook: 'https://discord.example/hook'
    }
    const parsed = parsePlaylists(legacy)

    expect(parsed.migrated).toBe(true)
    expect(parsed.envelope.playlists).toEqual([
      { id: MIGRATED_PLAYLIST_ID, label: 'Primary', server: 'https://provider.example', username: 'glustick', password: 'secret' }
    ])
    expect(parsed.carried).toEqual({
      epgUrls: ['https://guide.example/xmltv.php'],
      alertWebhook: 'https://discord.example/hook'
    })
  })

  it('round-trips a migrated blob without losing anything', () => {
    const legacy = { server: 's', username: 'u', password: 'p', epgUrls: ['g'], alertWebhook: 'w' }
    const stored = serializePlaylists(parsePlaylists(legacy))
    expect(stored).toEqual({ epgUrls: ['g'], alertWebhook: 'w', version: 1, playlists: [
      { id: MIGRATED_PLAYLIST_ID, label: 'Primary', server: 's', username: 'u', password: 'p' }
    ] })
    // Reading the written shape back is a no-op migration, which is what makes the write safe to do.
    expect(parsePlaylists(stored).migrated).toBe(false)
    expect(parsePlaylists(stored).envelope.playlists).toHaveLength(1)
  })

  it('carries unrecognised fields through, so a newer build’s setting survives an older one', () => {
    const parsed = parsePlaylists({ server: 's', username: 'u', password: 'p', somethingNew: { a: 1 } })
    expect(serializePlaylists(parsed).somethingNew).toEqual({ a: 1 })
  })

  it('reads the new shape as-is and reports it as already migrated', () => {
    const playlists: Playlist[] = [
      { id: 'primary', label: 'Main', server: 's1', username: 'u1', password: 'p1' },
      { id: 'p2', label: 'Backup', server: 's2', username: 'u2', password: 'p2' }
    ]
    const parsed = parsePlaylists({ version: 1, playlists })
    expect(parsed.migrated).toBe(false)
    expect(parsed.envelope.playlists).toEqual(playlists)
  })

  it('accepts a JSON string, because that is how the column is written', () => {
    expect(parsePlaylists('{"server":"s","username":"u","password":"p"}').envelope.playlists).toHaveLength(1)
  })

  it('never throws on anything unreadable — this runs on the path that decides whether anything plays', () => {
    for (const input of [null, undefined, '', 'not json', '[]', 42, true, {}, { playlists: 'nonsense' }]) {
      const parsed = parsePlaylists(input)
      expect(Array.isArray(parsed.envelope.playlists)).toBe(true)
    }
  })

  it('drops entries that are not addressable rather than keeping a half-playlist', () => {
    const parsed = parsePlaylists({
      version: 1,
      playlists: [
        { id: 'a', label: 'A', server: 's', username: 'u', password: 'p' },
        { label: 'no id', server: 's', username: 'u', password: 'p' },
        { id: 'c', server: '', username: 'u', password: 'p' }
      ]
    })
    expect(parsed.envelope.playlists.map((p) => p.id)).toEqual(['a'])
  })

  it('does not invent a playlist for a blob with no provider details', () => {
    expect(parsePlaylists({ epgUrls: ['g'] }).envelope.playlists).toEqual([])
    expect(parsePlaylists({ epgUrls: ['g'] }).carried).toEqual({ epgUrls: ['g'] })
  })
})

describe('primaryPlaylist', () => {
  it('is the first listed — the operator’s own order, with no flag that can disagree with it', () => {
    const playlists: Playlist[] = [
      { id: 'primary', label: 'Main', server: 's1', username: 'u1', password: 'p1' },
      { id: 'p2', label: 'Backup', server: 's2', username: 'u2', password: 'p2' }
    ]
    expect(primaryPlaylist(playlists)?.id).toBe('primary')
    expect(primaryPlaylist([])).toBeNull()
  })
})

describe('nextPlaylistId', () => {
  it('hands out a readable id that is never already taken', () => {
    expect(nextPlaylistId([])).toBe('p1')
    expect(nextPlaylistId([{ id: 'primary', label: 'Main', server: 's', username: 'u', password: 'p' }])).toBe('p2')
    const taken = ['p1', 'p2', 'p3'].map((id) => ({ id, label: id, server: 's', username: 'u', password: 'p' }))
    expect(nextPlaylistId(taken)).toBe('p4')
  })
})

describe('channelMatchKey', () => {
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
