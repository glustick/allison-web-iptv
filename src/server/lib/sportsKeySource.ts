import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

// Where an api-football key can be supplied *out of band* — rather than pasted through a chat,
// committed to a repository, or typed into the admin screen.
//
// Two sources, the env var first:
//   SPORTS_API_KEY        the key itself
//   SPORTS_API_KEY_FILE   a file holding it (default: <DATA_DIR>/api-football.txt)
//
// The default path matters: /appdata is the persisted volume every deployment already has, so
// dropping a file there configures the key without touching the container's environment — and it
// never passes through git. Whatever is found here is only ever **adopted when no key is set** (see
// index.ts): a key entered in Admin → Sports data is never silently overwritten by a stale file.

export interface SuppliedSportsKey {
  key: string
  /** Where it came from, for the log line — never the key itself. */
  source: string
}

export const DEFAULT_SPORTS_KEY_FILE = 'api-football.txt'

export function readSuppliedSportsKey(opts: {
  dataDir: string
  env?: Record<string, string | undefined>
  /** Injectable for tests; defaults to reading the filesystem. */
  readFile?: (path: string) => string | null
}): SuppliedSportsKey | null {
  const env = opts.env ?? process.env
  const fromEnv = env.SPORTS_API_KEY?.trim()
  if (fromEnv) return { key: fromEnv, source: 'SPORTS_API_KEY' }

  const path = env.SPORTS_API_KEY_FILE?.trim() || join(opts.dataDir, DEFAULT_SPORTS_KEY_FILE)
  const read = opts.readFile ?? ((file: string): string | null => (existsSync(file) ? readFileSync(file, 'utf8') : null))
  try {
    const key = (read(path) ?? '').trim()
    if (key.length > 0) return { key, source: path }
  } catch (err) {
    console.error('[sports] could not read the supplied key file:', err instanceof Error ? err.message : err)
  }
  return null
}
