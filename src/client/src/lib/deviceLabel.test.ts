import { describe, expect, it } from 'vitest'
import { describeAddress, describeAge, describeUserAgent } from './deviceLabel'

describe('device labels', () => {
  it('names the everyday browsers on the everyday platforms', () => {
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      )
    ).toBe('Chrome on macOS')
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'
      )
    ).toBe('Safari on macOS')
    expect(
      describeUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
      )
    ).toBe('Safari on iPhone')
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'
      )
    ).toBe('Edge on Windows')
  })

  it('does not call every Chrome a Safari, or an iOS Chrome a desktop one', () => {
    // Every Chrome UA contains "Safari/537.36"; reading that as Safari is the classic bug.
    expect(
      describeUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')
    ).toBe('Chrome on Linux')
    expect(
      describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1')
    ).toBe('Chrome on iPhone')
  })

  it('tells a phone from a tablet', () => {
    expect(describeUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36')).toBe(
      'Chrome on Android phone'
    )
    expect(describeUserAgent('Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36')).toBe(
      'Chrome on Android tablet'
    )
  })

  it('degrades to "Unknown device" rather than guessing', () => {
    expect(describeUserAgent(null)).toBe('Unknown device')
    expect(describeUserAgent('   ')).toBe('Unknown device')
    expect(describeUserAgent('curl/8.4.0')).toBe('Unknown device')
    expect(describeUserAgent('SomeWidget/1.0').includes('Unknown')).toBe(true)
  })

  it('shows an address a person can read', () => {
    // Node reports IPv4 clients on a dual-stack socket with this prefix; nobody recognises it.
    expect(describeAddress('::ffff:192.168.0.9')).toBe('192.168.0.9')
    expect(describeAddress('2001:db8::1')).toBe('2001:db8::1')
    expect(describeAddress(null)).toBe('address unknown')
    expect(describeAddress('  ')).toBe('address unknown')
  })

  it('describes age in the coarsest useful unit', () => {
    const now = Date.UTC(2026, 10, 7, 12, 0, 0)
    expect(describeAge(now - 30_000, now)).toBe('just now')
    expect(describeAge(now - 5 * 60_000, now)).toBe('5 minutes ago')
    expect(describeAge(now - 61 * 60_000, now)).toBe('1 hour ago')
    expect(describeAge(now - 3 * 24 * 60 * 60_000, now)).toBe('3 days ago')
    // A clock that disagrees with the server's must not produce a negative age.
    expect(describeAge(now + 60_000, now)).toBe('just now')
  })
})
