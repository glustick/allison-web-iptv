import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { prepareTranscodeDir, resolveTranscodeDir, sweepStaleTranscodeDirs, TRANSCODE_DIR_PREFIX } from './transcodeService.js'

// The transcode temp directory moved from "wherever the OS puts it" to a configurable path
// because a feature-length VOD keeps every segment it produces. These cover the boot-time
// contract that replaced the old silent failure mode: the directory is proven writable and
// yesterday's leftovers are cleared, both reported rather than assumed.

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'transcode-dir-test-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.TRANSCODE_TMP_DIR
})

describe('resolveTranscodeDir', () => {
  it('falls back to the OS temp dir when unset', () => {
    delete process.env.TRANSCODE_TMP_DIR
    expect(resolveTranscodeDir()).toBe(tmpdir())
  })

  it('honours TRANSCODE_TMP_DIR when set', () => {
    process.env.TRANSCODE_TMP_DIR = '/mnt/transcode'
    expect(resolveTranscodeDir()).toBe('/mnt/transcode')
  })

  it('treats a blank/whitespace value as unset rather than writing to ""', () => {
    process.env.TRANSCODE_TMP_DIR = '   '
    expect(resolveTranscodeDir()).toBe(tmpdir())
  })
})

describe('sweepStaleTranscodeDirs', () => {
  it('removes leftover session directories and nothing else', async () => {
    const stale = join(root, `${TRANSCODE_DIR_PREFIX}abc123`)
    const alsoStale = join(root, `${TRANSCODE_DIR_PREFIX}def456`)
    const keep = join(root, 'unrelated-directory')
    const keepFile = join(root, 'notes.txt')
    mkdirSync(stale)
    mkdirSync(alsoStale)
    mkdirSync(keep)
    writeFileSync(join(stale, 'seg_00000.ts'), 'x')
    writeFileSync(keepFile, 'keep me')

    expect(await sweepStaleTranscodeDirs(root)).toBe(2)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(alsoStale)).toBe(false)
    expect(existsSync(keep)).toBe(true)
    expect(existsSync(keepFile)).toBe(true)
  })

  it('returns 0 for a directory that does not exist yet', async () => {
    expect(await sweepStaleTranscodeDirs(join(root, 'nope'))).toBe(0)
  })
})

describe('prepareTranscodeDir', () => {
  it('creates a missing directory, clears stale sessions and reports no error', async () => {
    const dir = join(root, 'nested', 'transcode')
    const r = await prepareTranscodeDir(dir)
    expect(r.error).toBeNull()
    expect(r.swept).toBe(0)
    expect(existsSync(dir)).toBe(true)
  })

  it('clears stale session directories as part of preparation', async () => {
    const stale = join(root, `${TRANSCODE_DIR_PREFIX}old`)
    mkdirSync(stale)
    writeFileSync(join(stale, 'seg_00001.ts'), 'x')
    const r = await prepareTranscodeDir(root)
    expect(r).toMatchObject({ error: null, swept: 1 })
    expect(existsSync(stale)).toBe(false)
  })

  it('leaves no write-probe file behind', async () => {
    await prepareTranscodeDir(root)
    expect(readdirSync(root).filter((f) => f.startsWith('.write-test'))).toEqual([])
  })

  it('reports an unwritable directory instead of throwing (skipped when running as root)', async () => {
    // Root ignores mode bits, so this asserts the *shape* of the contract only where it can bite.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    const locked = join(root, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o500)
    const r = await prepareTranscodeDir(locked)
    expect(r.error).toContain('not writable')
    chmodSync(locked, 0o700)
  })
})
