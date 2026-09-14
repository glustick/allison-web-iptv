// Client side of the per-user library: favourites, watch history and custom categories. All of
// it is stored server-side (SQLite under /appdata), so it survives updates and follows the
// account rather than the browser — the desktop app kept favourites in local storage, which is
// exactly what this replaces.

export type MediaKind = 'live' | 'movie' | 'series'

export interface Favourite {
  kind: MediaKind
  streamId: number
  name: string
  category: string | null
  /** Channel artwork, stored with the entry so a list renders without the provider's own list. */
  icon: string | null
  addedAt: string
}

export interface HistoryEntry {
  id: number
  kind: MediaKind
  streamId: number
  name: string
  category: string | null
  watchedAt: string
}

export interface CustomCategoryChannel {
  kind: MediaKind
  streamId: number
  name: string
  sourceCategory: string | null
  icon: string | null
  position: number
}

export interface CustomCategory {
  id: number
  name: string
  position: number
  channels: CustomCategoryChannel[]
}

export interface ResumePosition {
  kind: MediaKind
  streamId: number
  name: string
  category: string | null
  positionSeconds: number
  durationSeconds: number | null
  updatedAt: string
}

export interface PrefsState {
  favourites: Favourite[]
  categories: CustomCategory[]
  history: HistoryEntry[]
  resume: ResumePosition[]
}

export interface ChannelRef {
  kind: MediaKind
  streamId: number
  name: string
  category?: string | null
  icon?: string | null
}

const EMPTY: PrefsState = { favourites: [], categories: [], history: [], resume: [] }

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`)
  return data
}

export async function fetchPrefs(): Promise<PrefsState> {
  const data = await request<Partial<PrefsState>>('/api/prefs')
  return { ...EMPTY, ...data }
}

const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
})

export async function setFavourite(channel: ChannelRef, favourite: boolean): Promise<Favourite[]> {
  const data = await request<{ favourites: Favourite[] }>('/api/prefs/favourites', jsonPost({ ...channel, favourite }))
  return data.favourites ?? []
}

/** Replaces the display order of the account's favourites (drag-and-drop / move buttons). */
export async function setFavouriteOrder(order: Array<{ kind: MediaKind; streamId: number }>): Promise<Favourite[]> {
  const data = await request<{ favourites: Favourite[] }>('/api/prefs/favourites/order', jsonPost({ order }))
  return data.favourites ?? []
}

/** Replaces the display order of a custom category's channels. */
export async function reorderCategoryChannels(
  id: number,
  order: Array<{ kind: MediaKind; streamId: number }>
): Promise<CustomCategory[]> {
  const data = await request<{ categories: CustomCategory[] }>(`/api/prefs/categories/${id}/order`, jsonPost({ order }))
  return data.categories ?? []
}

export async function recordHistory(channel: ChannelRef): Promise<void> {
  await request('/api/prefs/history', jsonPost(channel))
}

export async function fetchHistory(limit = 100): Promise<HistoryEntry[]> {
  const data = await request<{ history: HistoryEntry[] }>(`/api/prefs/history?limit=${limit}`)
  return data.history ?? []
}

export async function clearHistory(): Promise<HistoryEntry[]> {
  const data = await request<{ history: HistoryEntry[] }>('/api/prefs/history', { method: 'DELETE' })
  return data.history ?? []
}

/** Records where playback got to. The server ignores live TV, too-early positions and
 *  anything inside the final seconds of a title (those clear the entry instead). */
export async function setResumePosition(
  channel: ChannelRef,
  positionSeconds: number,
  durationSeconds: number | null
): Promise<ResumePosition[]> {
  const data = await request<{ resumePositions: ResumePosition[] }>(
    '/api/prefs/resume',
    jsonPost({ ...channel, positionSeconds, durationSeconds })
  )
  return data.resumePositions ?? []
}

export async function clearResumePosition(kind: MediaKind, streamId: number): Promise<ResumePosition[]> {
  const data = await request<{ resumePositions: ResumePosition[] }>(`/api/prefs/resume/${kind}/${streamId}`, {
    method: 'DELETE'
  })
  return data.resumePositions ?? []
}

export async function createCategory(name: string): Promise<CustomCategory[]> {
  const data = await request<{ categories: CustomCategory[] }>('/api/prefs/categories', jsonPost({ name }))
  return data.categories ?? []
}

export async function renameCategory(id: number, name: string): Promise<CustomCategory[]> {
  const data = await request<{ categories: CustomCategory[] }>(`/api/prefs/categories/${id}/rename`, jsonPost({ name }))
  return data.categories ?? []
}

export async function deleteCategory(id: number): Promise<CustomCategory[]> {
  const data = await request<{ categories: CustomCategory[] }>(`/api/prefs/categories/${id}`, { method: 'DELETE' })
  return data.categories ?? []
}

export async function addChannelToCategory(id: number, channel: ChannelRef): Promise<CustomCategory[]> {
  const data = await request<{ categories: CustomCategory[] }>(`/api/prefs/categories/${id}/channels`, jsonPost(channel))
  return data.categories ?? []
}

export async function removeChannelFromCategory(id: number, kind: MediaKind, streamId: number): Promise<CustomCategory[]> {
  const data = await request<{ categories: CustomCategory[] }>(`/api/prefs/categories/${id}/channels/${kind}/${streamId}`, {
    method: 'DELETE'
  })
  return data.categories ?? []
}
