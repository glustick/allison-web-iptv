// Which competition groups the Sports tab's fixtures pane is showing **collapsed**, remembered per
// device.
//
// Kept out of the component as plain functions, the same shape as lib/libraryView.ts, so the
// parsing rules — a corrupt or hand-edited value must never throw — are unit-tested rather than
// buried inside a useState initialiser.

// One id per group (a competition, an api-only competition, or an unscheduled bucket). Bounded so a
// bad value cannot grow an unbounded list in localStorage.
const MAX_GROUP_IDS = 300

/** Parses the stored list. Anything unreadable is "nothing collapsed", never an exception. */
export function parseCollapsedGroups(raw: string | null): Set<string> {
  if (!raw) return new Set()
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(
      parsed.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, MAX_GROUP_IDS)
    )
  } catch {
    return new Set()
  }
}

export function serializeCollapsedGroups(groups: Set<string>): string {
  return JSON.stringify([...groups].slice(0, MAX_GROUP_IDS))
}

/** A new set with `id` toggled — expand becomes collapse and back, leaving the rest alone. */
export function toggleCollapsedGroup(groups: Set<string>, id: string): Set<string> {
  const next = new Set(groups)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}
