import { describe, expect, it } from 'vitest'
import {
  REMINDER_LEAD_MS,
  REMINDERS_KEY,
  dropReminder,
  dueReminders,
  markFired,
  pruneReminders,
  readReminders,
  reminderId,
  upsertReminder,
  writeReminders,
  type Reminder
} from './reminders'

const NOW = Date.UTC(2026, 10, 7, 20, 0, 0)

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: reminderId(42, undefined, NOW + 10 * 60_000),
    streamId: 42,
    channelName: 'Sky Sports Main Event',
    title: 'Newcastle v Arsenal',
    startMs: NOW + 10 * 60_000,
    stopMs: NOW + 130 * 60_000,
    firedAt: 0,
    ...overrides
  }
}

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    has: (k: string) => map.has(k)
  }
}

describe('programme reminders', () => {
  it('identifies a programme by its channel and its start, not by its title', () => {
    // Titles repeat ("Live: ...") and re-runs start later; the start time is the identity.
    expect(reminderId(42, undefined, NOW)).toBe(':42:' + NOW)
    expect(reminderId(42, 'backup', NOW)).toBe('backup:42:' + NOW)
  })

  it('replaces rather than duplicates when the same programme is set twice', () => {
    const one = reminder()
    const twice = upsertReminder(upsertReminder([], one, NOW), one, NOW)
    expect(twice).toHaveLength(1)
  })

  it('keeps the list ordered by start, so the panel reads like a schedule', () => {
    const later = reminder({ id: reminderId(7, undefined, NOW + 60 * 60_000), streamId: 7, startMs: NOW + 60 * 60_000, stopMs: NOW + 90 * 60_000 })
    const earlier = reminder({ id: reminderId(9, undefined, NOW + 5 * 60_000), streamId: 9, startMs: NOW + 5 * 60_000, stopMs: NOW + 15 * 60_000 })
    expect(upsertReminder([later], earlier, NOW).map((r) => r.streamId)).toEqual([9, 7])
  })

  it('drops a programme that ended more than a grace period ago', () => {
    const ended = reminder({ startMs: NOW - 3 * 60 * 60_000, stopMs: NOW - 2 * 60 * 60_000 })
    expect(pruneReminders([ended], NOW)).toEqual([])
    // Still inside the grace period: the banner may still be on screen.
    const justEnded = reminder({ startMs: NOW - 70 * 60_000, stopMs: NOW - 60_000 })
    expect(pruneReminders([justEnded], NOW)).toHaveLength(1)
  })

  it('fires once, within the lead window, and not after the programme is over', () => {
    const soon = reminder({ startMs: NOW + 30_000 })
    const later = reminder({ id: 'later', startMs: NOW + 30 * 60_000, stopMs: NOW + 90 * 60_000 })
    expect(dueReminders([soon, later], NOW)).toEqual([soon])
    // Exactly at the lead boundary counts; a second earlier does not.
    const edge = reminder({ startMs: NOW + REMINDER_LEAD_MS })
    expect(dueReminders([edge], NOW)).toHaveLength(1)
    expect(dueReminders([edge], NOW - 1)).toHaveLength(0)
    // A far-future programme is not due, and an ended one never becomes due.
    expect(dueReminders([later], NOW)).toHaveLength(0)
    expect(dueReminders([reminder({ startMs: NOW - 60 * 60_000, stopMs: NOW - 30 * 60_000 })], NOW)).toHaveLength(0)
  })

  it('never fires the same reminder twice — a reload is not a second reminder', () => {
    const fired = markFired([reminder({ startMs: NOW + 1_000 })], reminder().id, NOW)
    expect(fired[0].firedAt).toBe(NOW)
    expect(dueReminders(fired, NOW + 2_000)).toEqual([])
  })

  it('round-trips through storage and drops rubbish', () => {
    const storage = fakeStorage()
    const one = reminder()
    writeReminders([one], storage)
    expect(readReminders(NOW, storage)).toEqual([one])

    const rubbish = fakeStorage({ [REMINDERS_KEY]: JSON.stringify([{ id: 'x' }, null, 'nope']) })
    expect(readReminders(NOW, rubbish)).toEqual([])
    expect(readReminders(NOW, fakeStorage({ [REMINDERS_KEY]: 'not json' }))).toEqual([])
  })

  it('reads an old record without firedAt as not yet fired', () => {
    const legacy = { ...reminder(), firedAt: undefined }
    const storage = fakeStorage({ [REMINDERS_KEY]: JSON.stringify([legacy]) })
    expect(readReminders(NOW, storage)[0].firedAt).toBe(0)
  })

  it('removes one reminder without touching the others', () => {
    const a = reminder()
    const b = reminder({ id: 'b', startMs: NOW + 30 * 60_000, stopMs: NOW + 60 * 60_000 })
    expect(dropReminder([a, b], a.id)).toEqual([b])
  })
})
