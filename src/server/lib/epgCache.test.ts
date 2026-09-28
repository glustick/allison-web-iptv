import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { dropCachedGuide, loadCachedGuide, saveCachedGuide } from './epgCache.js'

// The disk cache is what lets "fetch once a day" survive a restart (a deploy, a container bounce).
// These pin the two things it must get right: a fresh guide comes back whole, and a stale one is
// ignored rather than served for ever.

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'epg-cache-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const DAY = 24 * 3_600_000

describe('guide disk cache', () => {
  it('round-trips a guide and reports when it was fetched', async () => {
    const dir = tempDir()
    const at = await saveCachedGuide(dir, 'https://example.com/a.xml', '<tv><channel id="c1"/></tv>')
    const loaded = await loadCachedGuide(dir, 'https://example.com/a.xml', DAY)
    expect(loaded?.text).toBe('<tv><channel id="c1"/></tv>')
    expect(loaded?.fetchedAt).toBeGreaterThan(0)
    expect(Math.abs((loaded?.fetchedAt ?? 0) - at)).toBeLessThan(2_000)
  })

  it('ignores a guide older than the window', async () => {
    const dir = tempDir()
    await saveCachedGuide(dir, 'https://example.com/a.xml', '<tv/>')
    // The clock moved past the window: the file is there, but no longer worth trusting.
    expect(await loadCachedGuide(dir, 'https://example.com/a.xml', DAY, Date.now() + 2 * DAY)).toBeNull()
  })

  it('returns null for a source that was never cached', async () => {
    expect(await loadCachedGuide(tempDir(), 'https://example.com/never.xml', DAY)).toBeNull()
  })

  it('keeps two sources in two files', async () => {
    const dir = tempDir()
    await saveCachedGuide(dir, 'https://example.com/a.xml', '<tv>a</tv>')
    await saveCachedGuide(dir, 'https://example.com/b.xml', '<tv>b</tv>')
    expect((await loadCachedGuide(dir, 'https://example.com/a.xml', DAY))?.text).toBe('<tv>a</tv>')
    expect((await loadCachedGuide(dir, 'https://example.com/b.xml', DAY))?.text).toBe('<tv>b</tv>')
  })

  it('drops a cached guide on request', async () => {
    const dir = tempDir()
    await saveCachedGuide(dir, 'https://example.com/a.xml', '<tv/>')
    await dropCachedGuide(dir, 'https://example.com/a.xml')
    expect(await loadCachedGuide(dir, 'https://example.com/a.xml', DAY)).toBeNull()
    // Dropping something that is not there is a no-op, not an error.
    await expect(dropCachedGuide(dir, 'https://example.com/absent.xml')).resolves.toBeUndefined()
  })
})
