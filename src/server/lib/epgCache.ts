import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'

// Guides are cached on disk as well as in memory.
//
// The in-memory cache (epgService.ts) is what serves requests. The file is what stops a restart —
// a deploy, a container bounce, a reboot — from re-downloading a guide the operator asked to fetch
// **once a day**. That matters because the expensive one is large: the provider's own guide was
// measured at 168 MB on the deployment, and a restart used to mean paying for it again immediately
// after login.
//
// The text is stored exactly as fetched (decoded), so a load costs a read and the same parse the
// fetch would have cost anyway — strictly cheaper than the download it replaces. The file's mtime
// is the fetched-at time, which is what lets a stale file be ignored without a separate index.

const CACHE_DIR_NAME = 'epg'
const MAX_URL_KEY_CHARS = 32

function cacheDir(dataDir: string): string {
  return join(dataDir, CACHE_DIR_NAME)
}

/** A filename derived from the URL, so the same source always lands on the same file. */
function cachePath(dataDir: string, url: string): string {
  const digest = createHash('sha256').update(url).digest('hex').slice(0, MAX_URL_KEY_CHARS)
  return join(cacheDir(dataDir), `${digest}.xml`)
}

export interface CachedGuide {
  text: string
  /** When it was fetched (the file's mtime), so the caller can report and age it. */
  fetchedAt: number
}

function isFresh(fetchedAt: number, maxAgeMs: number, now: number): boolean {
  return Number.isFinite(fetchedAt) && now - fetchedAt < maxAgeMs
}

/** The cached guide for a URL, or null when there is none or it is older than `maxAgeMs`. */
export async function loadCachedGuide(
  dataDir: string,
  url: string,
  maxAgeMs: number,
  now: number = Date.now()
): Promise<CachedGuide | null> {
  const path = cachePath(dataDir, url)
  try {
    const stats = await stat(path)
    if (!isFresh(stats.mtimeMs, maxAgeMs, now)) return null
    return { text: await readFile(path, 'utf8'), fetchedAt: stats.mtimeMs }
  } catch (err) {
    // A missing file is the normal cold path; anything else is worth knowing about but is not
    // fatal — the caller simply fetches instead.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.error('[epg] could not read the cached guide:', err instanceof Error ? err.message : err)
    }
    return null
  }
}

/** Persists a fetched guide and returns its fetched-at time. Never throws. */
export async function saveCachedGuide(dataDir: string, url: string, text: string): Promise<number> {
  const path = cachePath(dataDir, url)
  const tmp = `${path}.tmp`
  try {
    await mkdir(cacheDir(dataDir), { recursive: true })
    // Written under a temp name and renamed: a crash mid-write cannot leave a half guide that the
    // next boot would parse as if it were whole.
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, path)
    return (await stat(path)).mtimeMs
  } catch (err) {
    console.error('[epg] could not cache the guide:', err instanceof Error ? err.message : err)
    try {
      if (existsSync(tmp)) await unlink(tmp)
    } catch {
      // Best effort: a stray .tmp is harmless, and it is overwritten next time.
    }
    return Date.now()
  }
}

/** Removes a cached guide (used when a source is deleted). Never throws. */
export async function dropCachedGuide(dataDir: string, url: string): Promise<void> {
  try {
    await unlink(cachePath(dataDir, url))
  } catch {
    // Nothing to remove is the normal case.
  }
}
