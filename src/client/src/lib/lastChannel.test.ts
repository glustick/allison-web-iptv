import { describe, expect, it } from 'vitest'
import { readLastChannel, writeLastChannel } from './lastChannel'

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) }
}

describe('the last channel', () => {
  it('round-trips', () => {
    const storage = fakeStorage()
    writeLastChannel({ streamId: 42, playlistId: 'backup', name: 'Sky Sports', categoryId: '5' }, storage)
    expect(readLastChannel(storage)).toEqual({ streamId: 42, playlistId: 'backup', name: 'Sky Sports', categoryId: '5' })
  })

  it('drops a record with no usable id or name', () => {
    expect(readLastChannel(fakeStorage({ 'iptv:last-channel': '{"streamId":"42"}' }))).toBeNull()
    expect(readLastChannel(fakeStorage({ 'iptv:last-channel': '{"streamId":42,"name":"  "}' }))).toBeNull()
    expect(readLastChannel(fakeStorage({ 'iptv:last-channel': 'not json' }))).toBeNull()
  })

  it('treats a missing playlist as the primary and keeps an absent category null', () => {
    const storage = fakeStorage({ 'iptv:last-channel': '{"streamId":7,"name":"News"}' })
    expect(readLastChannel(storage)).toEqual({ streamId: 7, name: 'News', categoryId: null })
  })
})
