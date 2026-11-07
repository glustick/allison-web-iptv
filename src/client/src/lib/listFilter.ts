/**
 * A filter box over a list that is already in memory (v0.94.0) — the fastest way through a
 * thousand-channel library or a long film list without leaving the view or hitting the server.
 *
 * Case- and accent-insensitive, because someone typing "matchday" should find "Matchday" and someone
 * typing "cuenta" should find "Cuenta atrás". Nothing cleverer than that: no fuzzy scoring, no
 * ranking — a filter that reorders surprises people more than it helps them.
 */
export function normalizeForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

export function matchesText(haystack: string, query: string): boolean {
  const needle = normalizeForSearch(query)
  if (!needle) return true
  return normalizeForSearch(haystack).includes(needle)
}

export function filterByText<T>(items: T[], query: string, pick: (item: T) => string): T[] {
  const needle = normalizeForSearch(query)
  if (!needle) return items
  return items.filter((item) => matchesText(pick(item), needle))
}
