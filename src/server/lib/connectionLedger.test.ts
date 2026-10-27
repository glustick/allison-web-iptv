import { describe, expect, it } from 'vitest'
import { createConnectionLedger, type ConnectionLedgerDeps } from './connectionLedger.js'

function ledgerWithClock(startAt = 1000, deps: ConnectionLedgerDeps = {}) {
  let now = startAt
  const ledger = createConnectionLedger({ ...deps, now: () => now })
  return {
    ledger,
    advance: (ms: number): void => {
      now += ms
    }
  }
}

describe('connectionLedger', () => {
  it('counts a recorded stream as active with its idle age', () => {
    const { ledger, advance } = ledgerWithClock()
    ledger.record('/api/stream/live/668.m3u8')
    advance(1500)
    const active = ledger.active()
    expect(active).toEqual([{ key: '/api/stream/live/668.m3u8', idleMs: 1500 }])
  })

  it('drops a stream whose last request is older than the window — no request, no connection', () => {
    const { ledger, advance } = ledgerWithClock()
    ledger.record('/api/stream/live/668.m3u8')
    advance(29_999)
    expect(ledger.active()).toHaveLength(1)
    advance(1)
    expect(ledger.active()).toEqual([])
  })

  it('keeps a stream alive when later requests refresh it', () => {
    const { ledger, advance } = ledgerWithClock()
    ledger.record('/api/stream/live/668.m3u8')
    advance(20_000)
    // The segment Referer records under the same key — a playing stream keeps refreshing it.
    ledger.record('/api/stream/live/668.m3u8')
    advance(20_000)
    expect(ledger.active()).toEqual([{ key: '/api/stream/live/668.m3u8', idleMs: 20_000 }])
  })

  it('lists several streams oldest-stable (sorted by key) and prunes only the stale one', () => {
    const { ledger, advance } = ledgerWithClock()
    ledger.record('/b')
    advance(5000)
    ledger.record('/a')
    advance(26_000)
    // '/b' is now 31s old (stale), '/a' is 26s (inside the window).
    const active = ledger.active()
    expect(active.map((entry) => entry.key)).toEqual(['/a'])
    expect(active[0]?.idleMs).toBe(26_000)
  })

  it('caps remembered keys, evicting the least recently recorded', () => {
    let now = 0
    const ledger = createConnectionLedger({ now: () => now, maxEntries: 2 })
    ledger.record('/one')
    now = 1
    ledger.record('/two')
    now = 2
    ledger.record('/three')
    expect(ledger.active().map((entry) => entry.key)).toEqual(['/three', '/two'])
  })

  it('ignores an empty key rather than counting an anonymous entry', () => {
    const ledger = createConnectionLedger()
    ledger.record('')
    expect(ledger.active()).toEqual([])
  })

  it('honours an injected window for tests', () => {
    let now = 0
    const ledger = createConnectionLedger({ now: () => now, windowMs: 100 })
    ledger.record('/api/stream/live/1.m3u8')
    now = 100
    expect(ledger.active()).toEqual([])
  })
})
