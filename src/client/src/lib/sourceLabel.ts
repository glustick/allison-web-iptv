/**
 * How to show a guide source's address.
 *
 * Two rules, and the second is the important one:
 *
 * 1. An external source is shown **in full**. It used to be cut to 65 characters in code, which meant
 *    widening the column could never reveal the rest — the text was never rendered. A URL is exactly the
 *    thing you need in full when telling two sources apart.
 * 2. The provider's own guide is shown **without its query string**, because that query carries the
 *    account credentials (`xmltv.php?username=…&password=…`). This page is admin-only, but an admin page
 *    gets screenshotted and screen-shared, and a password does not belong in a table cell.
 */
export function displaySourceUrl(url: string, kind: string | null | undefined): string {
  if (kind === 'provider') return 'Provider guide'
  return url
}

/** The host and path of a URL, with any query stripped — safe to display. */
export function sourceUrlWithoutCredentials(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url.split('?')[0]
  }
}

/** A short label for a source: its host and path, never its query. */
export function sourceLabel(url: string, kind: string | null | undefined): string {
  if (kind === 'provider') return 'Provider guide'
  return sourceUrlWithoutCredentials(url)
}
