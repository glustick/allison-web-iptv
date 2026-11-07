import { describe, expect, it } from 'vitest'
import { actionForKey, isTypingTarget, seekTarget, SEEK_STEP_SECONDS } from './playerKeys'

const live = { seekable: false }
const vod = { seekable: true }

describe('player keyboard shortcuts', () => {
  it('maps the playback keys', () => {
    expect(actionForKey({ key: ' ' }, vod)).toBe('toggle')
    expect(actionForKey({ key: 'k' }, vod)).toBe('toggle')
    expect(actionForKey({ key: 'm' }, vod)).toBe('mute')
    expect(actionForKey({ key: 'f' }, vod)).toBe('fullscreen')
    expect(actionForKey({ key: '?' }, vod)).toBe('help')
    expect(actionForKey({ key: 'ArrowUp' }, vod)).toBe('volume-up')
    expect(actionForKey({ key: 'ArrowDown' }, vod)).toBe('volume-down')
  })

  it('seeks on a film and refuses to on live, where there is no timeline', () => {
    expect(actionForKey({ key: 'ArrowLeft' }, vod)).toBe('seek-back')
    expect(actionForKey({ key: 'ArrowRight' }, vod)).toBe('seek-forward')
    expect(actionForKey({ key: 'ArrowLeft' }, live)).toBeNull()
    expect(actionForKey({ key: 'ArrowRight' }, live)).toBeNull()
  })

  it('never steals a modified keystroke', () => {
    // Cmd+ArrowLeft is a browser back gesture, and Ctrl+letter belongs to the OS or the browser.
    expect(actionForKey({ key: 'ArrowLeft', metaKey: true }, vod)).toBeNull()
    expect(actionForKey({ key: 'k', ctrlKey: true }, vod)).toBeNull()
    expect(actionForKey({ key: ' ', altKey: true }, vod)).toBeNull()
  })

  it('leaves every other key to the page', () => {
    expect(actionForKey({ key: 'a' }, vod)).toBeNull()
    expect(actionForKey({ key: 'Escape' }, vod)).toBeNull()
    expect(actionForKey({ key: 'Enter' }, vod)).toBeNull()
  })

  it('recognises the fields that own their keystrokes', () => {
    expect(isTypingTarget({ tagName: 'INPUT', isContentEditable: false } as unknown as HTMLElement)).toBe(true)
    expect(isTypingTarget({ tagName: 'TEXTAREA', isContentEditable: false } as unknown as HTMLElement)).toBe(true)
    expect(isTypingTarget({ tagName: 'SELECT', isContentEditable: false } as unknown as HTMLElement)).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as HTMLElement)).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: false } as unknown as HTMLElement)).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })

  it('clamps a seek into the media instead of running past either end', () => {
    expect(seekTarget(30, 100, SEEK_STEP_SECONDS)).toBe(40)
    expect(seekTarget(5, 100, -SEEK_STEP_SECONDS)).toBe(0)
    expect(seekTarget(96, 100, SEEK_STEP_SECONDS)).toBe(100)
    // An unknown duration (a live-ish source, or metadata not ready) still seeks forward sanely.
    expect(seekTarget(96, null, SEEK_STEP_SECONDS)).toBe(106)
  })
})
