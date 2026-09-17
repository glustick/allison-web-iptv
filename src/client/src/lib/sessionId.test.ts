import { afterEach, describe, expect, it } from 'vitest'
import { newSessionId } from './sessionId'

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const original = globalThis.crypto

afterEach(() => { Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true, writable: true }) })

describe('newSessionId', () => {
  it('returns a version-4 UUID', () => {
    expect(newSessionId()).toMatch(V4)
  })

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newSessionId()))
    expect(ids.size).toBe(200)
  })

  it('still works when randomUUID is missing — the insecure-context case that crashed the app', () => {
    // Exactly what a browser exposes over plain http:// on a LAN address: getRandomValues present,
    // randomUUID absent. This used to throw a TypeError inside a click handler and take the whole
    // app down with it.
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: (b: Uint8Array) => (original as Crypto).getRandomValues(b) },
      configurable: true,
      writable: true
    })
    const id = newSessionId()
    expect(id).toMatch(V4)
  })

  it('falls back further if the whole crypto object is gone', () => {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true })
    expect(newSessionId()).toMatch(V4)
  })
})
