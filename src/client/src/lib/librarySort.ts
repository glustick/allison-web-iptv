/**
 * How a library list is ordered (v0.93.0): as the provider sent it, A–Z, or newest first.
 *
 * Per device, in `localStorage`, like the other browsing preferences — it is a reading habit, not
 * an account setting. Sorting is deliberately **stable and non-destructive**: it returns a copy,
 * and `default` returns the provider's own order untouched, because that order is sometimes
 * meaningful (a custom category the operator arranged by hand).
 */
export type LibrarySort = 'default' | 'name' | 'added'

export const LIBRARY_SORT_KEY = 'iptv:library-sort'

export function isLibrarySort(value: unknown): value is LibrarySort {
  return value === 'default' || value === 'name' || value === 'added'
}

export function readLibrarySort(storage: Pick<Storage, 'getItem'> | null = safeStorage()): LibrarySort {
  if (!storage) return 'default'
  try {
    const raw = storage.getItem(LIBRARY_SORT_KEY)
    return isLibrarySort(raw) ? raw : 'default'
  } catch {
    return 'default'
  }
}

export function writeLibrarySort(sort: LibrarySort, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  if (!storage) return
  try {
    storage.setItem(LIBRARY_SORT_KEY, sort)
  } catch {
    // A full store is not worth failing a browse over.
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * `added` arrives in two shapes from real panels: a unix timestamp as a string, or
 * `YYYY-MM-DD HH:mm:ss`. Both are accepted; anything unparseable sorts last rather than first,
 * since a missing date is not evidence of recency.
 */
function addedAt(value: string | undefined): number {
  if (!value) return Number.NaN
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed)
    return Number.isFinite(seconds) ? seconds * 1000 : Number.NaN
  }
  const parsed = Date.parse(trimmed.replace(' ', 'T'))
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

export function sortFilms<T extends { name: string; added?: string }>(films: T[], sort: LibrarySort): T[] {
  if (sort === 'default') return films
  const copy = films.slice()
  if (sort === 'name') {
    copy.sort((a, b) => collator.compare(a.name, b.name))
    return copy
  }
  copy.sort((a, b) => {
    const left = addedAt(a.added)
    const right = addedAt(b.added)
    if (Number.isNaN(left) && Number.isNaN(right)) return 0
    if (Number.isNaN(left)) return 1
    if (Number.isNaN(right)) return -1
    return right - left
  })
  return copy
}

export type SeriesSort = 'default' | 'name' | 'newest'

/**
 * Series ordering (v0.94.0). The catalogue carries `releaseDate` rather than the panel's `added`,
 * so "newest" means newest *release* — which is what a viewer means by "newest series" anyway.
 */
export function sortSeries<T extends { name: string; releaseDate?: string }>(series: T[], sort: SeriesSort): T[] {
  if (sort === 'default') return series
  const copy = series.slice()
  if (sort === 'name') {
    copy.sort((a, b) => collator.compare(a.name, b.name))
    return copy
  }
  copy.sort((a, b) => {
    const left = a.releaseDate ? Date.parse(a.releaseDate) : Number.NaN
    const right = b.releaseDate ? Date.parse(b.releaseDate) : Number.NaN
    if (Number.isNaN(left) && Number.isNaN(right)) return 0
    if (Number.isNaN(left)) return 1
    if (Number.isNaN(right)) return -1
    return right - left
  })
  return copy
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
