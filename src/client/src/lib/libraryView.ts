// Whether a personal channel list ("Favourites", a custom category) is shown as a guide or as the
// reorderable list.
//
// These views were list-only until it was reported as a gap: "the favourite EPG is missing" — a
// provider category gives you the guide, so looking at your favourites and finding no guide at all
// reads as broken rather than as a deliberate design. Both views are genuinely useful and they do
// different jobs: the list is where you reorder and remove (its grip and ✕ only exist there), and
// the guide is where you see what is actually on.
//
// Stored in localStorage, like the column widths (see useResizableColumns.ts) — a display
// preference that should not cost a server round-trip.
export type LibraryView = 'guide' | 'list'

const STORAGE_KEY = 'live-library-view'

/** What the caller shows when nothing has been chosen yet: the guide for Favourites (asked for),
 *  the list for custom categories (adding and removing channels happens there). */
export function parseLibraryView(value: unknown, fallback: LibraryView): LibraryView {
  return value === 'guide' || value === 'list' ? value : fallback
}

export function loadStoredLibraryView(): LibraryView | null {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
    return raw === 'guide' || raw === 'list' ? raw : null
  } catch {
    // Private mode, disabled storage — a display preference is never worth failing a render over.
    return null
  }
}

export function saveLibraryView(view: LibraryView): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, view)
  } catch {
    /* see above */
  }
}
