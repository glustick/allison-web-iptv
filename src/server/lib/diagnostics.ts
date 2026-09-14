import { statSync } from 'fs'

// A small, boring diagnostic surface: what the server knows about its own health, and the last
// few errors it hit. The point is that "is it them or us?" stops being guesswork — the questions
// that took a dozen messages to answer earlier (provider reachable? guide sources healthy?
// transcodes still running? disk space? which error actually happened?) are all answerable from
// one page.
//
// Recent errors come from wrapping console.error rather than adding a logger call at every one of
// the dozens of existing error sites: those sites already log, and a wrapper can't be forgotten.

export interface ErrorRecord {
  at: string
  message: string
}

const MAX_ERRORS = 50
const errors: ErrorRecord[] = []

/** Captures recent console.error output. Installed once at startup. */
export function captureErrors(): void {
  const original = console.error.bind(console)
  console.error = (...args: unknown[]): void => {
    original(...args)
    const message = args
      .map((arg) => (arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join(' ')
      .slice(0, 500)
    errors.push({ at: new Date().toISOString(), message })
    if (errors.length > MAX_ERRORS) errors.splice(0, errors.length - MAX_ERRORS)
  }
}

export function recentErrors(limit = 20): ErrorRecord[] {
  return errors.slice(-limit).reverse()
}

export function clearErrors(): void {
  errors.length = 0
}

export interface FileStats {
  path: string
  exists: boolean
  bytes: number
  modifiedAt: string | null
}

/** Size/mtime for the database (and its WAL), so growth is visible instead of a surprise. */
export function fileStats(path: string): FileStats {
  try {
    const stats = statSync(path)
    return { path, exists: true, bytes: stats.size, modifiedAt: stats.mtime.toISOString() }
  } catch {
    return { path, exists: false, bytes: 0, modifiedAt: null }
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
