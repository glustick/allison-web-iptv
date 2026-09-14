import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'

// Backup and restore for the one file that holds everything now (allison.db). Pulling a new image
// can't lose the database — it lives on the volume — but a bad restore, a corrupted write or a
// mistake with the volume could, so the admin panel can take a copy and put one back.
//
// Restores are applied on the *next start* rather than under a live process: swapping the file
// underneath open connections is exactly how SQLite databases get corrupted, and the app already
// restarts as part of a normal update.

const BACKUP_DIR_NAME = 'backups'
const PENDING_NAME = 'allison.db.pending-restore'
const DAILY_INTERVAL_MS = 24 * 3_600_000
const KEEP_BACKUPS = 7

export function backupDir(dataDir: string): string {
  return join(dataDir, BACKUP_DIR_NAME)
}

export function pendingRestorePath(dataDir: string): string {
  return join(dataDir, PENDING_NAME)
}

/** Opens a file as a database and checks it looks like ours. Never trusts the upload. */
export function validateDatabaseFile(path: string): { ok: true } | { ok: false; error: string } {
  let db: Database.Database | null = null
  try {
    db = new Database(path, { readonly: true, fileMustExist: true })
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    const names = new Set(tables.map((table) => table.name))
    if (!names.has('users')) return { ok: false, error: 'That file is not an Allison database (no users table)' }
    // Read from it, not just its schema: a truncated file can still have the tables.
    db.prepare('SELECT COUNT(*) AS count FROM users').get()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    db?.close()
  }
}

/**
 * Writes a consistent copy of the database to `destination` using SQLite's own backup API, which
 * is safe while the app is running (a plain file copy of a live WAL database is not).
 */
export async function backupDatabase(dataDir: string, destination: string): Promise<void> {
  const db = new Database(join(dataDir, 'allison.db'), { fileMustExist: true })
  try {
    await db.backup(destination)
  } finally {
    db.close()
  }
}

/** Once-a-day snapshot into backups/, keeping a handful. Cheap insurance, no UI required. */
export function dailyBackup(dataDir: string): { created: boolean; path?: string; error?: string } {
  try {
    const databasePath = join(dataDir, 'allison.db')
    if (!existsSync(databasePath)) return { created: false }
    const dir = backupDir(dataDir)
    mkdirSync(dir, { recursive: true })
    const existing = readdirSync(dir)
      .filter((name) => name.startsWith('allison-') && name.endsWith('.db'))
      .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    const newest = existing[0]
    if (newest && Date.now() - newest.mtime < DAILY_INTERVAL_MS) return { created: false, path: join(dir, newest.name) }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = join(dir, `allison-${stamp}.db`)
    copyFileSync(databasePath, target)
    for (const stale of existing.slice(KEEP_BACKUPS - 1)) rmSync(join(dir, stale.name), { force: true })
    return { created: true, path: target }
  } catch (err) {
    return { created: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function listBackups(dataDir: string): Array<{ name: string; bytes: number; modifiedAt: string }> {
  try {
    return readdirSync(backupDir(dataDir))
      .filter((name) => name.endsWith('.db'))
      .map((name) => {
        const stats = statSync(join(backupDir(dataDir), name))
        return { name, bytes: stats.size, modifiedAt: stats.mtime.toISOString() }
      })
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
  } catch {
    return []
  }
}

/**
 * Applies an uploaded database that is waiting to be restored. Runs at startup, before any store
 * opens the database: the current file is copied to backups/ first, so a restore is itself
 * undoable.
 */
export function applyPendingRestore(dataDir: string): { applied: boolean; message?: string } {
  const pending = pendingRestorePath(dataDir)
  if (!existsSync(pending)) return { applied: false }

  const check = validateDatabaseFile(pending)
  if (!check.ok) {
    rmSync(pending, { force: true })
    return { applied: false, message: `Discarded an invalid pending restore: ${check.error}` }
  }

  const databasePath = join(dataDir, 'allison.db')
  try {
    if (existsSync(databasePath)) {
      mkdirSync(backupDir(dataDir), { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      copyFileSync(databasePath, join(backupDir(dataDir), `allison-replaced-${stamp}.db`))
    }
    // Stale WAL/SHM sidecars belong to the database being replaced; leaving them would corrupt
    // the restored file.
    for (const suffix of ['-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true })
    renameSync(pending, databasePath)
    return { applied: true }
  } catch (err) {
    return { applied: false, message: `Restore failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}
