import { describe, expect, it } from 'vitest'
import { CONNECTION_CEILING, connectionStatus, tileWouldExceed } from './connectionBudget'

describe('connectionStatus', () => {
  it('falls back to the standing hint while the live count is unknown', () => {
    const status = connectionStatus(null)
    expect(status.level).toBe('ok')
    expect(status.text).toContain('about 2')
    expect(status.text).toContain('may starve')
  })

  it('reports room below the ceiling', () => {
    const status = connectionStatus({ used: 1, streamCount: 1, transcodes: 0 })
    expect(status.level).toBe('ok')
    expect(status.text).toBe('1 live connection in use — room for another tile.')
  })

  it('pluralises', () => {
    const status = connectionStatus({ used: 0, streamCount: 0, transcodes: 0 })
    expect(status.text).toBe('0 live connections in use — room for another tile.')
  })

  it('names the ceiling exactly at it', () => {
    const status = connectionStatus({ used: 2, streamCount: 2, transcodes: 0 })
    expect(status.level).toBe('at')
    expect(status.text).toBe(
      "2 live connections in use — at the provider's limit of about 2; another tile may starve."
    )
  })

  it('warns over the ceiling, counting transcode sessions too', () => {
    const status = connectionStatus({ used: 3, streamCount: 1, transcodes: 2 })
    expect(status.level).toBe('over')
    expect(status.text).toContain("over the provider's limit of about 2")
    expect(status.text).toContain('starving now')
  })

  it('honours a different ceiling when passed', () => {
    expect(connectionStatus({ used: 2, streamCount: 2, transcodes: 0 }, 4).level).toBe('ok')
    expect(connectionStatus({ used: 4, streamCount: 4, transcodes: 0 }, 4).level).toBe('at')
  })
})

describe('tileWouldExceed', () => {
  it('is false while unknown or below the ceiling, true at and past it', () => {
    expect(tileWouldExceed(null)).toBe(false)
    expect(tileWouldExceed({ used: CONNECTION_CEILING - 1, streamCount: 1, transcodes: 0 })).toBe(false)
    expect(tileWouldExceed({ used: CONNECTION_CEILING, streamCount: 2, transcodes: 0 })).toBe(true)
    expect(tileWouldExceed({ used: CONNECTION_CEILING + 1, streamCount: 2, transcodes: 1 })).toBe(true)
  })
})
