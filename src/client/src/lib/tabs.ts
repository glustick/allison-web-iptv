// Which top-level tab the app is on, and which of them open in their own browser tab.
//
// EPG (the guide sources), Admin and System are all *configuration* surfaces: nothing in them is
// part of watching something. Switching to them in the same tab unmounts the player, so a stream
// stops playing — reported as "should open new tabs, as to not disrupt the media being played".
// Opening them separately leaves the player exactly where it was.
export const TAB_KEYS = ['live', 'movies', 'series', 'epg', 'admin', 'system'] as const
export type TabKey = (typeof TAB_KEYS)[number]

/** Tabs that open in their own browser tab rather than replacing what is playing. */
export const DETACHED_TABS: readonly TabKey[] = ['epg', 'admin', 'system']

export function isDetachedTab(tab: string): boolean {
  return (DETACHED_TABS as readonly string[]).includes(tab)
}

/** Where a detached tab's link points: a plain same-origin URL, so the new tab reads the same app. */
export function tabHref(tab: TabKey): string {
  return `?tab=${tab}`
}

/**
 * The tab a URL asks for, when it asks for a valid one.
 *
 * Needed because a detached tab is a *fresh page load* — it has no memory of which tab the user was
 * looking at, so the tab has to come from the URL. Anything unrecognised falls back, rather than
 * rendering nothing.
 */
export function tabFromSearch(search: string, fallback: TabKey = 'live'): TabKey {
  const value = new URLSearchParams(search.startsWith('?') ? search : `?${search}`).get('tab')
  return value && (TAB_KEYS as readonly string[]).includes(value) ? (value as TabKey) : fallback
}
