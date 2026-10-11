import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPrefsStore, PrefsError, type PrefsStore } from './prefsStore.js'
import { createUsersStore } from './usersStore.js'
import Database from 'better-sqlite3'

let dir: string
let store: PrefsStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'allison-prefs-'))
  store = createPrefsStore({ dataDir: dir })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const live = (streamId: number, name: string) => ({ kind: 'live' as const, streamId, name, category: 'UK | News' })

describe('favourites', () => {
  it('adds, updates and removes, newest first, and validates its input', () => {
    store.setFavourite('alice', live(1, 'Sky News HD'), true)
    store.setFavourite('alice', live(2, 'BBC One'), true)
    store.setFavourite('alice', live(1, 'Sky News HD (renamed)'), true)

    const favourites = store.listFavourites('alice')
    expect(favourites).toHaveLength(2)
    expect(favourites.map((f) => f.name)).toContain('Sky News HD (renamed)')

    store.setFavourite('alice', live(1, 'Sky News HD'), false)
    expect(store.listFavourites('alice').map((f) => f.streamId)).toEqual([2])

    expect(() => store.setFavourite('alice', { kind: 'nope' as never, streamId: 3, name: 'x' }, true)).toThrow(PrefsError)
    expect(() => store.setFavourite('alice', { kind: 'live', streamId: Number.NaN, name: 'x' }, true)).toThrow(/streamId/)
    expect(() => store.setFavourite('alice', { kind: 'live', streamId: 4, name: '   ' }, true)).toThrow(/required/)
  })

  it('stores channel artwork with favourites and category entries', () => {
    const withIcon = { kind: 'live' as const, streamId: 9, name: 'Logo Channel', icon: 'https://logos.example/9.png' }
    store.setFavourite('alice', withIcon, true)
    expect(store.listFavourites('alice')[0].icon).toBe('https://logos.example/9.png')

    // Re-saving without an icon keeps the one already stored (COALESCE), and a re-save with a new
    // one updates it.
    store.setFavourite('alice', { ...withIcon, icon: null }, true)
    expect(store.listFavourites('alice')[0].icon).toBe('https://logos.example/9.png')
    store.setFavourite('alice', { ...withIcon, icon: 'https://logos.example/new.png' }, true)
    expect(store.listFavourites('alice')[0].icon).toBe('https://logos.example/new.png')

    // Junk is rejected rather than becoming a broken image in the UI.
    store.setFavourite('alice', { ...withIcon, streamId: 10, icon: 'javascript:alert(1)' }, true)
    expect(store.listFavourites('alice').find((f) => f.streamId === 10)?.icon).toBeNull()

    const category = store.createCategory('alice', 'Logos')
    store.addChannelToCategory('alice', category.id, withIcon)
    expect(store.listCategories('alice')[0].channels[0].icon).toBe('https://logos.example/9.png')
  })

  it('keeps favourites per user', () => {
    store.setFavourite('alice', live(1, 'A'), true)
    store.setFavourite('bob', live(2, 'B'), true)
    expect(store.listFavourites('alice').map((f) => f.name)).toEqual(['A'])
    expect(store.listFavourites('bob').map((f) => f.name)).toEqual(['B'])
  })
})

describe('history', () => {
  it('records newest first and honours the requested limit', () => {
    for (let i = 1; i <= 6; i++) store.recordHistory('alice', live(i, `Channel ${i}`))
    const all = store.listHistory('alice')
    expect(all).toHaveLength(6)
    expect(all[0].name).toBe('Channel 6')
    expect(store.listHistory('alice', 2).map((h) => h.name)).toEqual(['Channel 6', 'Channel 5'])
  })

  it('stays bounded rather than growing forever', () => {
    for (let i = 1; i <= 510; i++) store.recordHistory('alice', live(i, `Channel ${i}`))
    expect(store.listHistory('alice', 1000)).toHaveLength(500)
    expect(store.listHistory('alice', 1000)[0].name).toBe('Channel 510')
  })

  it('clears on request and validates entries', () => {
    store.recordHistory('alice', live(1, 'One'))
    store.clearHistory('alice')
    expect(store.listHistory('alice')).toEqual([])
    expect(() => store.recordHistory('alice', { kind: 'live', streamId: 1, name: '' })).toThrow(PrefsError)
  })
})

describe('custom categories', () => {
  it('creates, renames, deletes, and refuses duplicate names', () => {
    const created = store.createCategory('alice', '  My News  ')
    expect(created.name).toBe('My News')

    expect(() => store.createCategory('alice', 'my news')).toThrow(/already exists/)
    store.renameCategory('alice', created.id, 'News & Docs')
    expect(store.listCategories('alice')[0].name).toBe('News & Docs')
    expect(() => store.renameCategory('alice', created.id, 'OTHERCAT')).not.toThrow()

    store.deleteCategory('alice', created.id)
    expect(store.listCategories('alice')).toEqual([])
    expect(() => store.deleteCategory('alice', created.id)).toThrow(/does not exist/)
  })

  it('collects channels from any category, without duplicating, and cascades on delete', () => {
    const category = store.createCategory('alice', 'Sports Mix')
    store.addChannelToCategory('alice', category.id, live(10, 'Sky Sports 1'))
    store.addChannelToCategory('alice', category.id, { kind: 'movie', streamId: 20, name: 'A Film', category: 'Movies' })
    // Same channel twice: updated, not duplicated.
    store.addChannelToCategory('alice', category.id, live(10, 'Sky Sports 1 HD'))

    let listed = store.listCategories('alice')[0]
    expect(listed.channels).toHaveLength(2)
    expect(listed.channels.map((c) => c.name)).toContain('Sky Sports 1 HD')
    expect(listed.channels.map((c) => c.sourceCategory)).toContain('Movies')

    store.removeChannelFromCategory('alice', category.id, 'live', 10)
    listed = store.listCategories('alice')[0]
    expect(listed.channels).toHaveLength(1)

    store.deleteCategory('alice', category.id)
    // A fresh category with the same name starts empty — the cascade took the old rows.
    const replacement = store.createCategory('alice', 'Sports Mix')
    expect(store.listCategories('alice').find((c) => c.id === replacement.id)?.channels).toEqual([])
  })

  it('is per user', () => {
    const alice = store.createCategory('alice', 'Mine')
    store.addChannelToCategory('alice', alice.id, live(1, 'A'))
    expect(store.listCategories('bob')).toEqual([])
    expect(() => store.addChannelToCategory('bob', alice.id, live(2, 'B'))).toThrow(/does not exist/)
  })
})

describe('persistence', () => {
  it('survives a reopen, like an image update would', () => {
    store.setFavourite('alice', live(1, 'Sky News HD'), true)
    store.recordHistory('alice', live(1, 'Sky News HD'))
    const category = store.createCategory('alice', 'Faves')
    store.addChannelToCategory('alice', category.id, live(1, 'Sky News HD'))

    const reopened = createPrefsStore({ dataDir: dir })
    expect(reopened.listFavourites('alice').map((f) => f.name)).toEqual(['Sky News HD'])
    expect(reopened.listHistory('alice')).toHaveLength(1)
    expect(reopened.listCategories('alice')[0].channels).toHaveLength(1)
  })

  it('drops a deleted user’s favourites, history and categories', () => {
    const users = createUsersStore({ dataDir: dir })
    users.createUser({ username: 'goner', password: 'password1', role: 'user' })
    store.setFavourite('goner', live(1, 'A'), true)
    store.recordHistory('goner', live(1, 'A'))
    const category = store.createCategory('goner', 'Mine')
    store.addChannelToCategory('goner', category.id, live(1, 'A'))

    users.deleteUser('goner')

    expect(store.listFavourites('goner')).toEqual([])
    expect(store.listHistory('goner')).toEqual([])
    expect(store.listCategories('goner')).toEqual([])
  })

})

describe('resume positions', () => {
  const movie = (streamId: number, name: string) => ({ kind: 'movie' as const, streamId, name, category: 'Movies' })

  it('stores and updates where playback got to', () => {
    store.setResumePosition('alice', movie(7, 'Dune'), 600, 9000)
    expect(store.listResumePositions('alice')).toHaveLength(1)
    expect(store.listResumePositions('alice')[0]).toMatchObject({ kind: 'movie', streamId: 7, positionSeconds: 600, durationSeconds: 9000 })

    store.setResumePosition('alice', movie(7, 'Dune'), 1200, 9000)
    const [entry] = store.listResumePositions('alice')
    expect(entry.positionSeconds).toBe(1200)
    expect(store.listResumePositions('alice')).toHaveLength(1)
  })

  it('refuses live TV — there is nothing to resume', () => {
    expect(() => store.setResumePosition('alice', live(1, 'Sky News'), 300, null)).toThrow(/movies and series/)
    expect(store.listResumePositions('alice')).toEqual([])
  })

  it('treats a few seconds in as not started, and the tail as finished', () => {
    store.setResumePosition('alice', movie(8, 'Alien'), 400, 6000)
    expect(store.listResumePositions('alice')).toHaveLength(1)

    // Seeking back to the start drops the stale entry rather than offering a bogus resume.
    expect(store.setResumePosition('alice', movie(8, 'Alien'), 3, 6000)).toBeNull()
    expect(store.listResumePositions('alice')).toEqual([])

    // Watching to the end does the same (inside the 30s tail of a 5100s title).
    store.setResumePosition('alice', movie(9, 'Se7en'), 5090, 5100)
    expect(store.listResumePositions('alice')).toEqual([])
  })

  it('keeps positions per user and per kind, and survives a reopen', () => {
    store.setResumePosition('alice', movie(1, 'A'), 300, 3000)
    store.setResumePosition('alice', { kind: 'series', streamId: 2, name: 'B Episode 1' }, 300, 3000)
    store.setResumePosition('bob', movie(3, 'C'), 300, 3000)

    expect(store.listResumePositions('alice')).toHaveLength(2)
    expect(store.listResumePositions('alice', 'series').map((r) => r.name)).toEqual(['B Episode 1'])
    expect(store.listResumePositions('bob').map((r) => r.name)).toEqual(['C'])

    const reopened = createPrefsStore({ dataDir: dir })
    expect(reopened.listResumePositions('alice')).toHaveLength(2)
    expect(reopened.listResumePositions('alice').find((r) => r.kind === 'movie')?.positionSeconds).toBe(300)
  })

  it('validates its input and can be cleared explicitly', () => {
    expect(() => store.setResumePosition('alice', movie(4, 'D'), -1, 100)).toThrow(/zero or more/)
    expect(() => store.setResumePosition('alice', movie(4, 'D'), Number.NaN, 100)).toThrow(/zero or more/)
    expect(() => store.setResumePosition('alice', movie(4, 'D'), 300, 0)).toThrow(/positive/)

    store.setResumePosition('alice', movie(4, 'D'), 300, 3000)
    store.clearResumePosition('alice', 'movie', 4)
    expect(store.listResumePositions('alice')).toEqual([])
  })

  it('goes with the user when they are deleted', () => {
    const users = createUsersStore({ dataDir: dir })
    users.createUser({ username: 'temp', password: 'password1', role: 'user' })
    store.setResumePosition('temp', movie(5, 'E'), 300, 3000)
    users.deleteUser('temp')
    expect(store.listResumePositions('temp')).toEqual([])
  })
})

describe('drag-and-drop ordering', () => {
  it('stores an explicit favourites order, keeps it across a reopen, and puts new ones on top', () => {
    store.setFavourite('alice', live(1, 'One'), true)
    store.setFavourite('alice', live(2, 'Two'), true)
    store.setFavourite('alice', live(3, 'Three'), true)
    // Newest first by default.
    expect(store.listFavourites('alice').map((f) => f.name)).toEqual(['Three', 'Two', 'One'])

    store.setFavouriteOrder('alice', [
      { kind: 'live', streamId: 1 },
      { kind: 'live', streamId: 3 },
      { kind: 'live', streamId: 2 }
    ])
    expect(store.listFavourites('alice').map((f) => f.name)).toEqual(['One', 'Three', 'Two'])

    const reopened = createPrefsStore({ dataDir: dir })
    expect(reopened.listFavourites('alice').map((f) => f.name)).toEqual(['One', 'Three', 'Two'])

    // A newly favourited channel appears at the top without disturbing the arrangement.
    reopened.setFavourite('alice', live(4, 'Four'), true)
    expect(reopened.listFavourites('alice').map((f) => f.name)).toEqual(['Four', 'One', 'Three', 'Two'])
  })

  it('validates the order payload and ignores rows belonging to other users', () => {
    store.setFavourite('alice', live(1, 'One'), true)
    store.setFavourite('bob', live(2, 'Two'), true)
    expect(() => store.setFavouriteOrder('alice', 'nope' as never)).toThrow(/array/)

    // Alice's order can't touch Bob's rows.
    store.setFavouriteOrder('alice', [{ kind: 'live', streamId: 2 }])
    expect(store.listFavourites('bob').map((f) => f.name)).toEqual(['Two'])
  })

  it('reorders the channels inside a custom category', () => {
    const category = store.createCategory('alice', 'Mix')
    store.addChannelToCategory('alice', category.id, live(10, 'Ten'))
    store.addChannelToCategory('alice', category.id, live(11, 'Eleven'))
    store.addChannelToCategory('alice', category.id, { kind: 'movie', streamId: 12, name: 'Twelve' })
    expect(store.listCategories('alice')[0].channels.map((c) => c.name)).toEqual(['Ten', 'Eleven', 'Twelve'])

    store.reorderCategoryChannels('alice', category.id, [
      { kind: 'movie', streamId: 12 },
      { kind: 'live', streamId: 10 },
      { kind: 'live', streamId: 11 }
    ])
    expect(store.listCategories('alice')[0].channels.map((c) => c.name)).toEqual(['Twelve', 'Ten', 'Eleven'])

    const reopened = createPrefsStore({ dataDir: dir })
    expect(reopened.listCategories('alice')[0].channels.map((c) => c.name)).toEqual(['Twelve', 'Ten', 'Eleven'])

    expect(() => store.reorderCategoryChannels('alice', 9999, [])).toThrow(/does not exist/)
  })

  it('adds the ordering column to a database created before it existed', () => {
    // Upgrades must migrate in place: CREATE TABLE IF NOT EXISTS would leave an older
    // favourites table without the column and every ordered query would fail.
    const legacyDir = mkdtempSync(join(tmpdir(), 'allison-legacy-order-'))
    const legacy = new Database(join(legacyDir, 'allison.db'))
    legacy.exec(`CREATE TABLE favourites (
      username TEXT NOT NULL, kind TEXT NOT NULL, stream_id INTEGER NOT NULL,
      name TEXT NOT NULL, category TEXT, added_at TEXT NOT NULL,
      PRIMARY KEY (username, kind, stream_id))`)
    legacy.prepare('INSERT INTO favourites VALUES (?, ?, ?, ?, ?, ?)').run('alice', 'live', 5, 'Legacy Channel', null, '2026-01-01T00:00:00.000Z')
    legacy.close()

    const migrated = createPrefsStore({ dataDir: legacyDir })
    expect(migrated.listFavourites('alice').map((f) => f.name)).toEqual(['Legacy Channel'])
    migrated.setFavouriteOrder('alice', [{ kind: 'live', streamId: 5 }])
    expect(migrated.listFavourites('alice')).toHaveLength(1)
    // The artwork column arrives the same way, and an old row simply has none until the client
    // backfills it.
    const before = migrated.listFavourites('alice')[0]
    expect(before.icon).toBeNull()
    migrated.setFavourite('alice', { kind: 'live', streamId: 5, name: 'Legacy Channel', icon: 'https://logos.example/5.png' }, true)
    expect(migrated.listFavourites('alice')[0].icon).toBe('https://logos.example/5.png')
    rmSync(legacyDir, { recursive: true, force: true })
  })
})

describe('playlist dimension (v0.78.0)', () => {
  // Stream ids are provider-scoped: the backup playlist's channel 668 is a different channel
  // from the primary's 668. The composite key (stream_id, playlist_id) is what keeps them apart.
  const backup = (streamId: number, name: string) => ({
    kind: 'live' as const,
    streamId,
    playlistId: 'p2',
    name,
    category: 'UK | News'
  })

  it('keeps the same stream id on two playlists apart', () => {
    store.setFavourite('alice', live(668, 'Primary 668'), true)
    store.setFavourite('alice', backup(668, 'Backup 668'), true)

    const favourites = store.listFavourites('alice')
    expect(favourites).toHaveLength(2)
    const primary = favourites.find((f) => f.playlistId === '')
    const other = favourites.find((f) => f.playlistId === 'p2')
    expect(primary?.name).toBe('Primary 668')
    expect(other?.name).toBe('Backup 668')

    // Removing one leaves the other: an un-favourite of the primary's 668 must not touch p2's.
    store.setFavourite('alice', live(668, 'Primary 668'), false)
    const remaining = store.listFavourites('alice')
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toMatchObject({ playlistId: 'p2', name: 'Backup 668' })
  })

  it('treats an absent playlistId as the primary playlist, and orders per composite row', () => {
    store.setFavourite('alice', live(1, 'One'), true)
    store.setFavourite('alice', backup(1, 'One (backup)'), true)
    expect(store.listFavourites('alice')).toHaveLength(2)

    // Ordering targets exactly one composite row.
    store.setFavouriteOrder('alice', [
      { kind: 'live', streamId: 1, playlistId: 'p2' },
      { kind: 'live', streamId: 1 }
    ])
    expect(store.listFavourites('alice').map((f) => f.playlistId)).toEqual(['p2', ''])
  })

  it('records history per playlist and lists the playlist id back', () => {
    store.recordHistory('alice', live(668, 'Primary 668'))
    store.recordHistory('alice', backup(668, 'Backup 668'))
    const history = store.listHistory('alice')
    expect(history).toHaveLength(2)
    expect(history.map((h) => h.playlistId).sort()).toEqual(['', 'p2'])
  })

  it('scopes resume positions per playlist', () => {
    const movie = (playlistId: string) => ({ kind: 'movie' as const, streamId: 77, playlistId, name: 'Same Id Film', category: 'Movies' })
    store.setResumePosition('alice', movie(''), 600, 9000)
    store.setResumePosition('alice', movie('p2'), 1200, 9000)

    const positions = store.listResumePositions('alice')
    expect(positions).toHaveLength(2)
    expect(positions.find((r) => r.playlistId === '')?.positionSeconds).toBe(600)
    expect(positions.find((r) => r.playlistId === 'p2')?.positionSeconds).toBe(1200)

    // Clearing one playlist's position leaves the other's.
    store.clearResumePosition('alice', 'movie', 77, 'p2')
    expect(store.listResumePositions('alice')).toHaveLength(1)
    expect(store.listResumePositions('alice')[0].playlistId).toBe('')
  })

  it('scopes custom-category channels per playlist', () => {
    const category = store.createCategory('alice', 'Mix')
    store.addChannelToCategory('alice', category.id, live(668, 'Primary 668'))
    store.addChannelToCategory('alice', category.id, backup(668, 'Backup 668'))
    const channels = store.listCategories('alice')[0].channels
    expect(channels).toHaveLength(2)
    expect(channels.map((c) => c.playlistId).sort()).toEqual(['', 'p2'])

    store.removeChannelFromCategory('alice', category.id, 'live', 668, '')
    const after = store.listCategories('alice')[0].channels
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ playlistId: 'p2', name: 'Backup 668' })
  })

  it('migrates a pre-playlist database: every row comes back on the primary playlist', () => {
    // The v0.77.x shapes: per-user tables keyed without any playlist dimension.
    const legacyDir = mkdtempSync(join(tmpdir(), 'allison-legacy-playlist-'))
    const legacy = new Database(join(legacyDir, 'allison.db'))
    legacy.exec(`
      CREATE TABLE favourites (
        username TEXT NOT NULL, kind TEXT NOT NULL, stream_id INTEGER NOT NULL,
        name TEXT NOT NULL, category TEXT, added_at TEXT NOT NULL, stream_icon TEXT, position INTEGER,
        PRIMARY KEY (username, kind, stream_id));
      CREATE TABLE history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, kind TEXT NOT NULL,
        stream_id INTEGER NOT NULL, name TEXT NOT NULL, category TEXT, watched_at TEXT NOT NULL);
      CREATE TABLE custom_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE (username, name));
      CREATE TABLE custom_category_channels (
        category_id INTEGER NOT NULL REFERENCES custom_categories (id) ON DELETE CASCADE,
        kind TEXT NOT NULL, stream_id INTEGER NOT NULL, name TEXT NOT NULL, source_category TEXT,
        stream_icon TEXT, position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (category_id, kind, stream_id));
      CREATE TABLE resume_positions (
        username TEXT NOT NULL, kind TEXT NOT NULL, stream_id INTEGER NOT NULL,
        name TEXT NOT NULL, category TEXT, position_seconds REAL NOT NULL, duration_seconds REAL,
        updated_at TEXT NOT NULL, PRIMARY KEY (username, kind, stream_id));
    `)
    legacy.prepare('INSERT INTO favourites (username, kind, stream_id, name, category, added_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('alice', 'live', 5, 'Legacy', null, '2026-01-01T00:00:00.000Z')
    legacy.prepare('INSERT INTO history (username, kind, stream_id, name, category, watched_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('alice', 'live', 5, 'Legacy', null, '2026-01-01T00:00:00.000Z')
    legacy.prepare('INSERT INTO resume_positions (username, kind, stream_id, name, category, position_seconds, duration_seconds, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('alice', 'movie', 7, 'Legacy Film', null, 600, 9000, '2026-01-01T00:00:00.000Z')
    const categoryId = Number(legacy.prepare('INSERT INTO custom_categories (username, name, position, created_at) VALUES (?, ?, ?, ?)')
      .run('alice', 'Legacy Cat', 0, '2026-01-01T00:00:00.000Z').lastInsertRowid)
    legacy.prepare('INSERT INTO custom_category_channels (category_id, kind, stream_id, name, position) VALUES (?, ?, ?, ?, ?)')
      .run(categoryId, 'live', 5, 'Legacy', 0)
    legacy.close()

    const migrated = createPrefsStore({ dataDir: legacyDir })
    expect(migrated.listFavourites('alice')[0]).toMatchObject({ playlistId: '', name: 'Legacy' })
    expect(migrated.listHistory('alice')[0]).toMatchObject({ playlistId: '', name: 'Legacy' })
    expect(migrated.listResumePositions('alice')[0]).toMatchObject({ playlistId: '', name: 'Legacy Film' })
    expect(migrated.listCategories('alice')[0].channels[0]).toMatchObject({ playlistId: '', name: 'Legacy' })

    // The migrated tables still enforce their composite keys: a same-id different-playlist row
    // is a new row, not a replacement.
    migrated.setFavourite('alice', backup(5, 'Backup 5'), true)
    expect(migrated.listFavourites('alice')).toHaveLength(2)
    rmSync(legacyDir, { recursive: true, force: true })
  })
})
