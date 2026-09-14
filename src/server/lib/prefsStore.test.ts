import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPrefsStore, PrefsError, type PrefsStore } from './prefsStore.js'
import { createUsersStore } from './usersStore.js'

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
})
