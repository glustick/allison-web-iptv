import { describe, expect, it } from 'vitest'
import {
  advanceWatch,
  createProviderWatch,
  buildProviderAlert,
  DEFAULT_WATCH_THRESHOLDS,
  isDiscordWebhookUrl,
  type WatchState
} from './providerWatch.js'

const bad = { reachable: false }
const good = { reachable: true }

describe('advanceWatch', () => {
  it('calls it down only after the agreed number of failures', () => {
    // One failed probe is a blip; two in a row is an outage (the configured threshold).
    let t = advanceWatch('up', 5, bad)
    expect(t.event).toBe('none')
    t = advanceWatch('up', t.streak, bad)
    expect(t).toMatchObject({ state: 'down', event: 'down' })
  })

  it('never announces the same state twice', () => {
    // Already down; more bad samples must stay silent or a support channel gets a stream of them.
    let t = advanceWatch('down', 2, bad)
    expect(t.event).toBe('none')
    t = advanceWatch('down', t.streak, bad)
    expect(t.event).toBe('none')
  })

  it('resets the streak when the provider answers in between', () => {
    // Blip, answer, blip, blip → down. The answer in the middle breaks the run.
    let t = advanceWatch('up', 1, bad)          // streak 1
    t = advanceWatch('up', t.streak, good)      // streak 1 again, other way
    t = advanceWatch('up', t.streak, bad)       // streak 1
    t = advanceWatch('up', t.streak, bad)       // streak 2 → down
    expect(t.state).toBe('down')
  })

  it('announces the recovery once, after agreement', () => {
    let t = advanceWatch('down', -6, good)     // first good sample: back to +1, not yet a verdict
    expect(t.event).toBe('none')
    t = advanceWatch('down', t.streak, good)   // +2 → recovered
    expect(t).toMatchObject({ state: 'up', event: 'up' })
    expect(advanceWatch('up', t.streak, good).event).toBe('none')
  })

  it('does not announce a recovery for an outage it never saw', () => {
    const first = advanceWatch('unknown' as WatchState, 0, good)
    const second = advanceWatch('unknown' as WatchState, first.streak, good)
    expect(second.state).toBe('up')
    expect(second.event).toBe('none')
  })

  it('takes the first verdict from nothing, using the same thresholds', () => {
    // From 'unknown', the first sample is not a verdict yet — it starts the run.
    const first = advanceWatch('unknown' as WatchState, 0, good)
    expect(first.state).toBe('unknown')
    expect(first.streak).toBe(1)
    expect(advanceWatch('unknown' as WatchState, first.streak, good).state).toBe('up')

    const firstBad = advanceWatch('unknown' as WatchState, 0, bad)
    expect(firstBad.state).toBe('unknown')
    expect(firstBad.streak).toBe(-1)
    expect(advanceWatch('unknown' as WatchState, firstBad.streak, bad).state).toBe('down')
  })

  it('keeps the run when the same disposition repeats', () => {
    // A negative streak counts failures; it must keep going negative, not reset.
    expect(advanceWatch('up', -1, bad).streak).toBe(-2)
    expect(advanceWatch('up', -7, bad).streak).toBe(-8)
    expect(advanceWatch('up', 3, good).streak).toBe(4)
  })

  it('uses the shipped defaults sensibly', () => {
    expect(DEFAULT_WATCH_THRESHOLDS.failuresToDeclareDown).toBeGreaterThanOrEqual(2)
    expect(DEFAULT_WATCH_THRESHOLDS.successesToDeclareUp).toBeGreaterThanOrEqual(1)
  })
})

describe('buildProviderAlert', () => {
  const facts = {
    host: 'primehub.primeprox.store',
    detail: 'Upstream did not respond within 8000ms (no response headers)',
    since: new Date('2026-09-16T01:19:00Z'),
    at: new Date('2026-09-16T01:25:00Z'),
    downForMs: 6 * 60_000
  }

  it('says which host failed, how, and since when', () => {
    const body = buildProviderAlert('down', facts)
    expect(body.content).toContain('primehub.primeprox.store')
    expect(body.content).toContain('2026-09-16 01:19')
    expect(body.content).toContain('no response headers')
  })

  it('never mentions the account — a support channel is not private', () => {
    const down = buildProviderAlert('down', facts).content
    const up = buildProviderAlert('up', facts).content
    for (const text of [down, up]) {
      expect(text).not.toMatch(/glustick|password|username|user=/i)
    }
  })

  it('says how long the outage lasted when it recovers', () => {
    expect(buildProviderAlert('up', facts).content).toContain('6 min')
  })

  it('keeps within Discord’s content limit', () => {
    const long = buildProviderAlert('down', { ...facts, detail: 'x'.repeat(5000) })
    expect(long.content.length).toBeLessThanOrEqual(2000)
  })
})

describe('isDiscordWebhookUrl', () => {
  it('accepts a real webhook URL', () => {
    expect(isDiscordWebhookUrl('https://discord.com/api/webhooks/1234/abcdef')).toBe(true)
    expect(isDiscordWebhookUrl('https://discordapp.com/api/webhooks/1234/abcdef')).toBe(true)
  })

  it('refuses anything else, so this can never be pointed at an arbitrary host', () => {
    for (const url of [
      'http://discord.com/api/webhooks/1/x',
      'https://evil.example.com/api/webhooks/1/x',
      'https://discord.com/channels/1/2',
      'not a url',
      ''
    ]) {
      expect(isDiscordWebhookUrl(url), url).toBe(false)
    }
  })
})

describe('createProviderWatch', () => {
  const host = 'primehub.primeprox.store'
  function watchWith(samples: boolean[], posted: string[]) {
    let i = 0
    return createProviderWatch({
      host,
      intervalMs: 1_000_000, // the loop is not what is under test here
      probe: async () => ({ reachable: samples[Math.min(i++, samples.length - 1)], detail: 'no response headers' }),
      postAlert: async (body) => {
        posted.push(body.content)
        return true
      }
    })
  }

  it('announces an outage once, and the recovery once', async () => {
    const posted: string[] = []
    // up, up, down, down, down, up, up
    const watch = watchWith([true, true, false, false, false, true, true], posted)
    for (let i = 0; i < 7; i += 1) await watch.checkOnce()
    expect(posted).toHaveLength(2)
    expect(posted[0]).toContain('Provider not responding')
    expect(posted[1]).toContain('Provider recovered')
    expect(watch.state()).toBe('up')
    watch.stop()
  })

  it('says nothing while the state does not change', async () => {
    const posted: string[] = []
    const watch = watchWith([true, true, true, true], posted)
    for (let i = 0; i < 4; i += 1) await watch.checkOnce()
    expect(posted).toHaveLength(0)
    watch.stop()
  })

  it('swallows a broken probe instead of reporting it as an outage', async () => {
    // Otherwise a bug in the watchdog itself becomes a message in a support channel — and, from
    // setInterval, an unhandled rejection.
    const posted: string[] = []
    const watch = createProviderWatch({
      host,
      intervalMs: 1_000_000,
      probe: async () => {
        throw new Error('probe exploded')
      },
      postAlert: async (body) => {
        posted.push(body.content)
        return true
      }
    })
    await expect(watch.checkOnce()).resolves.toBe('unknown')
    await expect(watch.checkOnce()).resolves.toBe('unknown')
    watch.stop()
    expect(posted).toHaveLength(0)
  })
})
