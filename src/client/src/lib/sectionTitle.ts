// The heading shown above a Live TV channel panel (see LiveTv.tsx's list toolbar). Extracted
// because it is easy to get subtly wrong: a provider *category* selection used to fall through
// to "All channels", so a category's channel list (and the guide under it) was labelled as if
// it were the whole catalog.
export type LiveSectionSelection =
  | { type: 'all' }
  | { type: 'favourites' }
  | { type: 'history' }
  | { type: 'custom'; id: number }
  | { type: 'provider'; id: string }

export function sectionTitle(
  selection: LiveSectionSelection,
  names: { custom?: string; provider?: string } = {}
): string {
  switch (selection.type) {
    case 'favourites':
      return 'Favourites'
    case 'history':
      return 'Watch history'
    case 'custom':
      return names.custom ?? 'All channels'
    case 'provider':
      // The channels on screen are exactly this provider category's, so name it rather than
      // claiming they are everything.
      return names.provider ?? 'All channels'
    default:
      return 'All channels'
  }
}
