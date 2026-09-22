// Client side of the operational surfaces: search, the health page, and backup/restore.

import type { MediaKind } from './prefs'

export interface SearchHit {
  kind: MediaKind
  streamId: number
  name: string
  category: string | null
  icon: string | null
  score: number
}

export interface SearchStatus {
  live: number
  movie: number
  series: number
  total: number
  indexedAt: string | null
  indexing: boolean
  lastError: string | null
}

export interface SearchResponse {
  hits: SearchHit[]
  index: SearchStatus
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`)
  return data
}

export async function search(query: string, limit = 40): Promise<SearchResponse> {
  const data = await request<SearchResponse>(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}`)
  return { hits: data.hits ?? [], index: data.index }
}

export async function searchStatus(): Promise<SearchStatus> {
  const data = await request<{ index: SearchStatus }>('/api/search/status')
  return data.index
}

export async function reindexSearch(): Promise<SearchStatus> {
  const data = await request<{ index: SearchStatus }>('/api/search/reindex', { method: 'POST' })
  return data.index
}

export interface HealthReport {
  server: { version: string; uptimeSeconds: number; node: string; platform: string; memoryMb: number }
  database: {
    /** Whether the database can actually be *written* — see the boot check's own comment. A
     *  read-only data directory is a total outage (sign-in writes), not a degraded mode. */
    ok?: boolean
    error?: string
    /** Free space on the filesystem holding the database — the value that explains a
     *  "disk I/O error" when nothing else about the setup looks wrong. */
    freeBytes?: number | null
    totalBytes?: number | null
    lowSpace?: boolean
    path: string
    exists: boolean
    bytes: number
    sizeLabel: string
    modifiedAt: string | null
    wal: { bytes: number }
    counts: Record<string, number>
  }
  guide: Array<{ kind: string; url: string; status: string; channelCount: number; programmeCount: number; error?: string }> | null
  transcode: {
    active: Array<{
      sessionId: string
      startedAt: string
      runningSeconds: number
      hasPlaylist: boolean
      bytes: number
      /** Average output rate in bytes/second since the session started (null under 1s). Every live
       *  segment is relayed through this host, so this is the bandwidth it carries for one viewer. */
      bytesPerSecond: number | null
      /** Seconds since anything fetched this session's output. The server stops a session at 120. */
      idleSeconds: number
    }>
    /** Where transcoded segments are written, and the free space there. A VOD session keeps every
     *  segment until it stops, so this is the number that tells you whether a film will fit. */
    storage: { dir: string; freeBytes: number | null; totalBytes: number | null }
  }
  search: SearchStatus
  provider: Record<string, unknown> & { reachable?: boolean; error?: string; configured?: boolean }
  backups: Array<{ name: string; bytes: number; modifiedAt: string }>
  errors: Array<{ at: string; message: string }>
}

export async function fetchHealth(): Promise<HealthReport> {
  return request<HealthReport>('/api/admin/health')
}

export function backupDownloadUrl(): string {
  return '/api/admin/backup'
}

/** Uploads a database file to be applied on the next start. */
export async function uploadRestore(file: File): Promise<{ requiresRestart: boolean }> {
  const res = await fetch('/api/admin/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string; requiresRestart?: boolean }
  if (!res.ok) throw new Error(data.error ?? `Upload failed (${res.status})`)
  return { requiresRestart: Boolean(data.requiresRestart) }
}
