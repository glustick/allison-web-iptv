import { describe, expect, it } from 'vitest'
import { planAutoRelease, tileLedgerKey, type ReleaseCandidate } from './connectionRelease.js'
import type { MultiViewSlot } from './multiViewPrefs.js'

const slot = (streamId: number, name: string, playlistId?: string) => ({ streamId, name, playlistId })

type Override = Partial<Omit<ReleaseCandidate, 'slot' | 'slotIndex'>> & { slotIndex: number; slot?: MultiViewSlot; streamId?: number; name?: string; playlistId?: string }

function candidates(overrides: Array<Override>): ReleaseCandidate[] {
  return overrides.map((o) => ({
    slotIndex: o.slotIndex,
    slot: o.slot ?? slot(o.streamId ?? o.slotIndex + 1, o.name ?? `Tile ${o.slotIndex + 1}`, o.playlistId),
    idleMs: 'idleMs' in o ? o.idleMs ?? null : 10_000,
    isAudible: o.isAudible ?? false
  }))
}

describe('tileLedgerKey', () => {
  it("derives the primary relay path the ledger records a playing tile under", () => {
    expect(tileLedgerKey(slot(668, 'Sky News'))).toBe('/api/stream/live/668.m3u8')
  })

  it('derives the playlist-scoped path for an additional playlist’s tile', () => {
    expect(tileLedgerKey(slot(668, 'Sky News', 'p2'))).toBe('/api/iptv/playlists/p2/stream/live/668.m3u8')
  })
})

describe('planAutoRelease', () => {
  it('names the idlest tile of the account, with a note that says which and why', () => {
    const plan = planAutoRelease(candidates([
      { slotIndex: 0, idleMs: 5_000 },
      { slotIndex: 1, idleMs: 120_000 },
      { slotIndex: 2, idleMs: 40_000 }
    ]), 2, 2, 'New Channel')
    expect(plan?.slotIndex).toBe(1)
    expect(plan?.note).toContain('Tile 2')
    expect(plan?.note).toContain('2-stream limit')
    expect(plan?.note).toContain('New Channel')
  })

  it('never stops the audible tile, however idle its ledger says it is', () => {
    const plan = planAutoRelease(candidates([
      { slotIndex: 0, idleMs: 999_000, isAudible: true },
      { slotIndex: 1, idleMs: 30_000 }
    ]), 2, 2, 'New Channel')
    expect(plan?.slotIndex).toBe(1)
  })

  it('does nothing without a known ceiling — an invented number never acts (v0.86.0 rule)', () => {
    expect(planAutoRelease(candidates([{ slotIndex: 0 }]), 9, null, 'X')).toBeNull()
  })

  it('does nothing when the account is not at its ceiling', () => {
    expect(planAutoRelease(candidates([{ slotIndex: 0 }]), 1, 3, 'X')).toBeNull()
  })

  it('a tile with no ledger presence is not worth stopping — it holds nothing to free', () => {
    expect(planAutoRelease(candidates([{ slotIndex: 0, idleMs: null }]), 2, 2, 'X')).toBeNull()
  })

  it('breaks an all-idle tie on slot index — the earlier tile goes first', () => {
    const plan = planAutoRelease(candidates([
      { slotIndex: 0, idleMs: 50_000 },
      { slotIndex: 1, idleMs: 50_000 }
    ]), 2, 2, 'X')
    expect(plan?.slotIndex).toBe(0)
  })
})
