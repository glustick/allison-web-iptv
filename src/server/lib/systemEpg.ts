import { createSystemSettingsStore, type SystemSettingsStore } from './systemSettings.js'

// The EPG source list is a **system** setting, not an account one: one household, one set of
// guides. It is stored in the app's own database (see systemSettings.ts), so it survives restarts
// and image updates and is never rebuilt per login.
//
// Only an admin may write it (enforced at the endpoint, requireAdmin); every signed-in user reads
// it. The provider's *own* guide is not part of this — it is derived from whichever account is
// asking, because it is addressed with that account's credentials.

const META_KEY = 'epg_sources'

export interface SystemEpgConfig {
  urls: string[]
  updatedAt: string | null
  updatedBy: string | null
}

export interface SystemEpgStore {
  read(): SystemEpgConfig
  write(urls: string[], updatedBy: string): SystemEpgConfig
  /** Whether the setting has ever been written — the migration reads this exactly once. */
  hasStoredConfig(): boolean
}

export function createSystemEpgStore(opts: { dataDir: string; settings?: SystemSettingsStore }): SystemEpgStore {
  const settings = opts.settings ?? createSystemSettingsStore({ dataDir: opts.dataDir })

  function read(): SystemEpgConfig {
    const stored = settings.read<{ urls?: unknown; updatedAt?: unknown; updatedBy?: unknown }>(META_KEY)
    if (!stored) return { urls: [], updatedAt: null, updatedBy: null }
    const urls = Array.isArray(stored.urls)
      ? stored.urls.filter((url): url is string => typeof url === 'string' && url.length > 0)
      : []
    return {
      urls,
      updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
      updatedBy: typeof stored.updatedBy === 'string' ? stored.updatedBy : null
    }
  }

  function write(urls: string[], updatedBy: string): SystemEpgConfig {
    const config: SystemEpgConfig = { urls, updatedAt: new Date().toISOString(), updatedBy }
    settings.write(META_KEY, config)
    return config
  }

  function hasStoredConfig(): boolean {
    return settings.has(META_KEY)
  }

  return { read, write, hasStoredConfig }
}
