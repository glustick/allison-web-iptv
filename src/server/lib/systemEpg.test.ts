import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSystemEpgStore } from './systemEpg.js'
import { openDatabase } from './db.js'

// The guide sources are a system setting (one household, one set of guides), so what matters here
// is that they persist across processes and that a bad row cannot take the guide down.

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'epg-system-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('system-wide EPG sources', () => {
  it('starts empty and remembers what was written', () => {
    const store = createSystemEpgStore({ dataDir: tempDir() })
    expect(store.read()).toEqual({ urls: [], updatedAt: null, updatedBy: null })
    expect(store.hasStoredConfig()).toBe(false)

    const written = store.write(['https://example.com/a.xml'], 'chris')
    expect(written.urls).toEqual(['https://example.com/a.xml'])
    expect(written.updatedBy).toBe('chris')
    expect(store.hasStoredConfig()).toBe(true)
    expect(store.read().urls).toEqual(['https://example.com/a.xml'])
  })

  it('survives a new store instance over the same data directory — a restart', () => {
    const dir = tempDir()
    createSystemEpgStore({ dataDir: dir }).write(['https://example.com/a.xml'], 'chris')
    expect(createSystemEpgStore({ dataDir: dir }).read().urls).toEqual(['https://example.com/a.xml'])
  })

  it('keeps the list a household shares, not a per-user one', () => {
    const dir = tempDir()
    const store = createSystemEpgStore({ dataDir: dir })
    store.write(['https://example.com/a.xml', 'https://example.com/b.xml'], 'admin')
    // A second instance stands in for another signed-in user reading the same setting.
    expect(createSystemEpgStore({ dataDir: dir }).read().urls).toHaveLength(2)
  })

  it('treats a corrupt row as empty rather than failing every EPG request', () => {
    const dir = tempDir()
    const store = createSystemEpgStore({ dataDir: dir })
    store.write(['https://example.com/a.xml'], 'chris')

    const handle = openDatabase(dir)
    handle.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('{ not json', 'epg_sources')
    handle.close()

    expect(store.read()).toEqual({ urls: [], updatedAt: null, updatedBy: null })
  })

  it('drops non-string entries instead of handing them to a fetch', () => {
    const dir = tempDir()
    const handle = openDatabase(dir)
    handle.db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run('epg_sources', JSON.stringify({ urls: ['https://example.com/a.xml', 7, null], updatedAt: 'x' }))
    handle.close()

    expect(createSystemEpgStore({ dataDir: dir }).read().urls).toEqual(['https://example.com/a.xml'])
  })
})
