import { describe, expect, it } from 'vitest'
import { createRateLimiter } from './rateLimit.js'

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return { now: () => current, advance: (ms: number) => (current += ms) }
}

describe('createRateLimiter', () => {
  it('allows attempts until the limit is reached, then locks the key out', () => {
    const limiter = createRateLimiter({ maxAttempts: 3, windowMs: 60_000, lockoutMs: 60_000, now: clock().now })

    expect(limiter.check('ip:1.2.3.4').allowed).toBe(true)
    limiter.recordFailure('ip:1.2.3.4')
    limiter.recordFailure('ip:1.2.3.4')
    expect(limiter.check('ip:1.2.3.4').allowed).toBe(true)
    limiter.recordFailure('ip:1.2.3.4')

    const decision = limiter.check('ip:1.2.3.4')
    expect(decision.allowed).toBe(false)
    expect(decision.retryAfterSeconds).toBe(60)
  })

  it('lets a locked key back in once the lockout expires, with a clean slate', () => {
    const time = clock()
    const limiter = createRateLimiter({ maxAttempts: 2, windowMs: 60_000, lockoutMs: 30_000, now: time.now })
    limiter.recordFailure('k')
    limiter.recordFailure('k')
    expect(limiter.check('k').allowed).toBe(false)

    time.advance(30_001)
    expect(limiter.check('k').allowed).toBe(true)
    // One more failure must not immediately re-lock — the previous window was cleared.
    limiter.recordFailure('k')
    expect(limiter.check('k').allowed).toBe(true)
  })

  it('back doubles the wait on repeated lockouts, capped', () => {
    const time = clock()
    const limiter = createRateLimiter({ maxAttempts: 1, windowMs: 60_000, lockoutMs: 1_000, maxLockoutMs: 4_000, now: time.now })

    limiter.recordFailure('k')
    expect(limiter.check('k').retryAfterSeconds).toBe(1)
    time.advance(1_001)
    limiter.recordFailure('k')
    expect(limiter.check('k').retryAfterSeconds).toBe(2)
    time.advance(2_001)
    limiter.recordFailure('k')
    expect(limiter.check('k').retryAfterSeconds).toBe(4)
    time.advance(4_001)
    limiter.recordFailure('k')
    expect(limiter.check('k').retryAfterSeconds).toBe(4) // capped
  })

  it('forgets old failures so a slow trickle never locks anyone out', () => {
    const time = clock()
    const limiter = createRateLimiter({ maxAttempts: 3, windowMs: 10_000, lockoutMs: 60_000, now: time.now })
    limiter.recordFailure('k')
    limiter.recordFailure('k')
    time.advance(10_001)
    limiter.recordFailure('k')
    expect(limiter.check('k').allowed).toBe(true)
  })

  it('caps how many keys it will track', () => {
    const limiter = createRateLimiter({ maxAttempts: 3, windowMs: 60_000, lockoutMs: 60_000, maxKeys: 10, now: clock().now })
    for (let i = 0; i < 40; i++) limiter.recordFailure(`ip:${i}`)
    expect(limiter.size()).toBeLessThanOrEqual(11)
  })

  it('tracks keys independently and clears on success', () => {
    const limiter = createRateLimiter({ maxAttempts: 2, windowMs: 60_000, lockoutMs: 60_000, now: clock().now })
    limiter.recordFailure('ip:a')
    limiter.recordFailure('ip:a')
    expect(limiter.check('ip:a').allowed).toBe(false)
    expect(limiter.check('ip:b').allowed).toBe(true)

    limiter.recordSuccess('ip:a')
    expect(limiter.check('ip:a').allowed).toBe(true)
    // Only failures are tracked — a check must not create an entry, or random keys could grow it.
    expect(limiter.size()).toBe(0)
  })
})
