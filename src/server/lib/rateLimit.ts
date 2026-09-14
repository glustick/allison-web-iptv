// Login throttling. The app can be reached from the public internet, and before this the login
// endpoint accepted unlimited attempts — so an account with a guessable password was only as safe
// as its entropy. Two independent keys are tracked (the caller's address and the account name),
// because they defend against different attacks: one host trying many accounts, and many hosts
// trying one account.
//
// Time comes from an injected clock so the window/lockout behaviour is testable without waiting.

export interface RateLimitDecision {
  allowed: boolean
  /** Seconds until the key may be tried again (only meaningful when not allowed). */
  retryAfterSeconds?: number
}

export interface RateLimiter {
  check(key: string): RateLimitDecision
  recordFailure(key: string): void
  recordSuccess(key: string): void
  /** Diagnostics: how many keys are currently tracked (used by tests and the health page). */
  size(): number
}

export interface RateLimitOptions {
  /** Failures allowed inside the window before the key is locked out. */
  maxAttempts?: number
  /** Ceiling on tracked keys: a public endpoint must not be able to grow this map forever. */
  maxKeys?: number
  /** How far back failures are counted. */
  windowMs?: number
  /** Base lockout once the limit is hit; doubles on each further lockout, up to maxLockoutMs. */
  lockoutMs?: number
  maxLockoutMs?: number
  now?: () => number
}

interface Entry {
  failures: number[]
  blockedUntil: number
  lockouts: number
}

export function createRateLimiter({
  maxAttempts = 8,
  windowMs = 15 * 60_000,
  lockoutMs = 5 * 60_000,
  maxLockoutMs = 60 * 60_000,
  maxKeys = 5_000,
  now = Date.now
}: RateLimitOptions = {}): RateLimiter {
  // Insertion-ordered, so the oldest keys are evicted first when the cap is reached.
  const entries = new Map<string, Entry>()

  function entryFor(key: string): Entry {
    const existing = entries.get(key)
    if (existing) return existing
    const created: Entry = { failures: [], blockedUntil: 0, lockouts: 0 }
    entries.set(key, created)
    return created
  }

  function prune(entry: Entry, at: number): void {
    const cutoff = at - windowMs
    entry.failures = entry.failures.filter((at_) => at_ > cutoff)
  }

  return {
    check(key: string): RateLimitDecision {
      const at = now()
      const entry = entries.get(key)
      if (!entry) return { allowed: true }
      if (entry.blockedUntil > at) {
        return { allowed: false, retryAfterSeconds: Math.ceil((entry.blockedUntil - at) / 1000) }
      }
      // A lockout that has expired clears the slate so the next window starts fresh, rather than
      // locking again on a single further mistake.
      if (entry.blockedUntil !== 0 && entry.blockedUntil <= at) {
        entry.blockedUntil = 0
        entry.failures = []
      }
      prune(entry, at)
      return { allowed: true }
    },

    recordFailure(key: string): void {
      const at = now()
      const entry = entryFor(key)
      prune(entry, at)
      entry.failures.push(at)
      if (entries.size > maxKeys) {
        // Evict the oldest tracked key. Losing a throttling record is a far better failure mode
        // than letting an attacker consume memory.
        const oldest = entries.keys().next()
        if (!oldest.done) entries.delete(oldest.value)
      }
      if (entry.failures.length >= maxAttempts) {
        entry.lockouts += 1
        const wait = Math.min(maxLockoutMs, lockoutMs * 2 ** (entry.lockouts - 1))
        entry.blockedUntil = at + wait
        entry.failures = []
      }
    },

    recordSuccess(key: string): void {
      entries.delete(key)
    },

    size(): number {
      return entries.size
    }
  }
}
