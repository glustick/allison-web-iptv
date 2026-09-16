import { describe, expect, it } from 'vitest'
import { isDetachedTab, TAB_KEYS, tabFromSearch, tabHref } from './tabs'

describe('isDetachedTab', () => {
  it('detaches exactly the configuration surfaces', () => {
    // These three are not part of watching anything, so they must not replace the player.
    expect(isDetachedTab('epg')).toBe(true)
    expect(isDetachedTab('admin')).toBe(true)
    expect(isDetachedTab('system')).toBe(true)
  })

  it('leaves the media tabs where they are', () => {
    for (const tab of ['live', 'movies', 'series', 'nonsense', '']) {
      expect(isDetachedTab(tab), tab).toBe(false)
    }
  })
})

describe('tabHref', () => {
  it('points at a plain same-origin URL the new tab can load', () => {
    expect(tabHref('epg')).toBe('?tab=epg')
    expect(tabHref('admin')).toBe('?tab=admin')
  })
})

describe('tabFromSearch', () => {
  it('reads a valid tab out of the query string', () => {
    expect(tabFromSearch('?tab=admin')).toBe('admin')
    expect(tabFromSearch('tab=system')).toBe('system')
    expect(tabFromSearch('?foo=1&tab=epg&bar=2')).toBe('epg')
  })

  it('falls back rather than rendering nothing', () => {
    expect(tabFromSearch('')).toBe('live')
    expect(tabFromSearch('?tab=')).toBe('live')
    expect(tabFromSearch('?tab=<script>')).toBe('live')
    expect(tabFromSearch('?tab=admin', 'live')).toBe('admin')
    expect(tabFromSearch('?other=1', 'series')).toBe('series')
  })

  it('covers every tab the app knows', () => {
    for (const tab of TAB_KEYS) expect(tabFromSearch(`?tab=${tab}`), tab).toBe(tab)
  })
})
