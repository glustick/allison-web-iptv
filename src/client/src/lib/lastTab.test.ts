import { describe, expect, it } from 'vitest'
import { readLastTab, writeLastTab } from './lastTab'

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) }
}

describe('the remembered tab', () => {
  it('round-trips a content tab', () => {
    const storage = fakeStorage()
    writeLastTab('movies', storage)
    expect(readLastTab(storage)).toBe('movies')
  })

  it('never remembers an admin or system page', () => {
    const storage = fakeStorage()
    writeLastTab('admin', storage)
    expect(readLastTab(storage)).toBeNull()
    writeLastTab('system', storage)
    expect(readLastTab(storage)).toBeNull()
  })

  it('ignores rubbish and a missing store', () => {
    expect(readLastTab(fakeStorage({ 'iptv:last-tab': 'nonsense' }))).toBeNull()
    expect(readLastTab(null)).toBeNull()
  })
})
