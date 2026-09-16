// Watching the IPTV provider, and telling someone when it goes away.
//
// Written after a provider hung twice in two days — DNS fine, TCP accepted, then no HTTP response
// at all — and the only way anyone found out was by trying to watch something. The provider's own
// support channel is where that belongs, so this posts there on the two events that matter: it
// stopped, and it came back.
//
// Two deliberate properties:
//
//  * Transitions only. A flapping provider must not turn into a stream of messages, so a state
//    change needs several consecutive samples to agree, and the same state is never announced
//    twice.
//  * It never mentions the account. The alert says which host failed and how, plus when — never a
//    username, never a password. Support channels are public to everyone in them.
export type WatchState = 'unknown' | 'up' | 'down'

export interface WatchSample {
  reachable: boolean
}

export interface WatchThresholds {
  /** Consecutive bad samples before calling it down — one blip is not an outage. */
  failuresToDeclareDown: number
  /** Consecutive good samples before calling it recovered. */
  successesToDeclareUp: number
}

export const DEFAULT_WATCH_THRESHOLDS: WatchThresholds = { failuresToDeclareDown: 2, successesToDeclareUp: 2 }

export type WatchEvent = 'down' | 'up' | 'none'

export interface WatchTransition {
  state: WatchState
  event: WatchEvent
  streak: number
}

/**
 * Fold one sample into the watch state.
 *
 * `streak` is *signed*: positive counts consecutive good samples, negative counts consecutive bad
 * ones. One number is then enough to answer both questions — "has the provider been failing long
 * enough to call this an outage?" and "has it been answering long enough to call it recovered?" —
 * and a single good sample in the middle of an outage breaks the run, which is what makes "down"
 * mean down rather than "one request happened to fail".
 */
export function advanceWatch(
  state: WatchState,
  streak: number,
  sample: WatchSample,
  thresholds: WatchThresholds = DEFAULT_WATCH_THRESHOLDS
): WatchTransition {
  const good = sample.reachable
  const nextStreak = good ? Math.max(1, streak + 1) : Math.min(-1, streak - 1)

  if (good && nextStreak >= thresholds.successesToDeclareUp && state !== 'up') {
    // From 'down' this is the recovery and worth announcing; from 'unknown' it is merely the first
    // verdict — posting "recovered" for an outage nobody saw would be nonsense.
    return { state: 'up', event: state === 'down' ? 'up' : 'none', streak: nextStreak }
  }
  if (!good && nextStreak <= -thresholds.failuresToDeclareDown && state !== 'down') {
    return { state: 'down', event: 'down', streak: nextStreak }
  }
  return { state, streak: nextStreak, event: 'none' }
}

export interface AlertFacts {
  host: string
  /** What the last probe actually said — the provider's own words are more useful than ours. */
  detail: string
  /** When this state started, and when it was noticed. */
  since: Date
  at: Date
  /** How long the outage lasted, for a recovery message. */
  downForMs?: number
}

function clockTime(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `${hours} h ${minutes % 60} min`
}

/**
 * The Discord message body. Written to be read by the provider's support channel rather than by
 * this app's own user: it says what is broken, from where, since when, and that nobody is watching
 * it — so a human there knows what to check.
 */
export function buildProviderAlert(event: 'down' | 'up', facts: AlertFacts): { content: string } {
  if (event === 'down') {
    return {
      content: [
        `⚠️ **Provider not responding — ${facts.host}**`,
        `First failed at **${clockTime(facts.since)}**; still failing at **${clockTime(facts.at)}**.`,
        `Last error: \`${facts.detail.slice(0, 300)}\``,
        '_Automated check from a self-hosted IPTV client (repeating TCP connects, no HTTP response). ' +
          'Sent on state change only, so this will not repeat while the outage continues._'
      ].join('\n')
    }
  }
  return {
    content: [
      `✅ **Provider recovered — ${facts.host}**`,
      `Responding again at **${clockTime(facts.at)}**` +
        (facts.downForMs ? `, after about **${duration(facts.downForMs)}** down.` : '.'),
      '_Automated check from a self-hosted IPTV client._'
    ].join('\n')
  }
}

/** Only Discord webhook URLs, and only https — this posts to a URL from the account's own config. */
export function isDiscordWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'discord.com' || parsed.hostname === 'discordapp.com' || parsed.hostname.endsWith('.discord.com')) &&
      parsed.pathname.startsWith('/api/webhooks/')
    )
  } catch {
    return false
  }
}

// --- the watch itself ---------------------------------------------------------------------------

export interface ProviderWatchOptions {
  /** What to watch, for the message. */
  host: string
  /** The app's own provider probe — the same one the health page uses, so both agree. */
  probe: () => Promise<{ reachable: boolean; detail: string }>
  /** Where to post. Refused unless it is a Discord webhook URL (see isDiscordWebhookUrl). */
  postAlert: (body: { content: string }) => Promise<boolean>
  intervalMs?: number
  thresholds?: WatchThresholds
  now?: () => Date
}

export interface ProviderWatch {
  /** One probe-and-maybe-announce cycle; the loop calls this, tests call it directly. */
  checkOnce(): Promise<WatchState>
  state(): WatchState
  stop(): void
}

export function createProviderWatch(options: ProviderWatchOptions): ProviderWatch {
  const intervalMs = options.intervalMs ?? 90_000
  const thresholds = options.thresholds ?? DEFAULT_WATCH_THRESHOLDS
  const now = options.now ?? ((): Date => new Date())
  let state: WatchState = 'unknown'
  let streak = 0
  let since: Date | null = null
  let running = false

  async function checkOnce(): Promise<WatchState> {
    if (running) return state
    running = true
    try {
      let sample: { reachable: boolean; detail: string }
      try {
        sample = await options.probe()
      } catch (err) {
        // The app's probe is built to answer "unreachable" rather than throw (see
        // nodeUpstreamRequest.ts), so a throw here means the probe itself is broken. Skipping the
        // sample keeps a bug in the watchdog from being reported as a provider outage — and, since
        // this runs from setInterval, from becoming an unhandled rejection.
        console.error('[watch] probe failed:', err instanceof Error ? err.message : String(err))
        return state
      }
      const { reachable, detail } = sample
      const at = now()
      const transition = advanceWatch(state, streak, { reachable }, thresholds)
      const previous = state
      state = transition.state
      streak = transition.streak
      if (previous === 'up' && state !== 'up') since = at
      if (transition.event === 'none') return state

      const body = buildProviderAlert(transition.event, {
        host: options.host,
        detail,
        since: since ?? at,
        at,
        downForMs: transition.event === 'up' && since ? at.getTime() - since.getTime() : undefined
      })
      const posted = await options.postAlert(body).catch(() => false)
      console.log(
        `[watch] provider ${transition.event}: ${options.host} — ${detail.slice(0, 120)}` +
          (posted ? ' (alert posted)' : ' (alert not delivered)')
      )
      if (transition.event === 'up') since = null
      return state
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void checkOnce(), intervalMs)
  timer.unref?.()

  return {
    checkOnce,
    state: () => state,
    stop: () => clearInterval(timer)
  }
}

/** Posts a message to a Discord webhook, refusing anything that is not one. Never throws. */
export async function postDiscordWebhook(url: string, body: { content: string }): Promise<boolean> {
  if (!isDiscordWebhookUrl(url)) return false
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000)
    })
    // Discord answers 204 for a delivered webhook message.
    return res.ok
  } catch {
    return false
  }
}
