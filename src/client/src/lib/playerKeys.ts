/**
 * Keyboard control for the players — the keys a television remote has, on the machine most people
 * actually watch on.
 *
 * The rules are here, in a pure function, rather than inline in a listener, for one reason: the
 * interesting cases are *refusals*. A shortcut that fires while someone is typing in the search
 * box deletes a character instead of pausing, and a "seek" on a live channel is a lie — the stream
 * has no timeline to seek. Both are decisions, and both are tested.
 */

export type PlayerAction =
  | 'toggle'
  | 'seek-back'
  | 'seek-forward'
  | 'volume-up'
  | 'volume-down'
  | 'mute'
  | 'fullscreen'
  | 'help'

export interface KeyContext {
  /** False for live: there is no timeline, so left/right must do nothing rather than pretend. */
  seekable: boolean
}

/** How far one press of an arrow moves the picture, in seconds. */
export const SEEK_STEP_SECONDS = 10

/**
 * The action a key means, or null. Modifiers disqualify everything: Cmd+ArrowLeft is a browser
 * back gesture, and Ctrl+letter is someone else's shortcut — stealing them would be rude and
 * occasionally destructive.
 */
export function actionForKey(
  event: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean },
  context: KeyContext
): PlayerAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  switch (event.key) {
    case ' ':
    case 'k':
    case 'K':
      return 'toggle'
    case 'ArrowLeft':
      return context.seekable ? 'seek-back' : null
    case 'ArrowRight':
      return context.seekable ? 'seek-forward' : null
    case 'ArrowUp':
      return 'volume-up'
    case 'ArrowDown':
      return 'volume-down'
    case 'm':
    case 'M':
      return 'mute'
    case 'f':
    case 'F':
      return 'fullscreen'
    case '?':
      return 'help'
    default:
      return null
  }
}

/**
 * True for a target that owns the keystroke — an input, a textarea, a select, or anything
 * contenteditable. The check is on the element rather than on "is it inside the player", because
 * the search box lives on the same page as the player and keeps focus while a channel plays.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false
  const element = target as HTMLElement
  const tag = element.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  return element.isContentEditable === true
}

/**
 * Where a seek lands: clamped into the media, so ArrowRight at the end does not set a currentTime
 * past the duration (which some browsers accept and then stall on).
 */
export function seekTarget(currentSeconds: number, durationSeconds: number | null, deltaSeconds: number): number {
  const current = Number.isFinite(currentSeconds) ? currentSeconds : 0
  const target = current + deltaSeconds
  const upper = typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null
  if (target < 0) return 0
  return upper === null ? target : Math.min(target, upper)
}
