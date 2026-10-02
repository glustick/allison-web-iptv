import { describe, it, expect } from 'vitest'
import { stripHopByHopHeaders } from './relayHeaders.js'

describe('stripHopByHopHeaders', () => {
  it('strips every hop-by-hop header, case-insensitively', () => {
    const out = stripHopByHopHeaders({
      connection: 'keep-alive',
      'Keep-Alive': 'timeout=5',
      TE: 'trailers',
      'TRANSFER-ENCODING': 'chunked',
      host: '127.0.0.1:8988',
      upgrade: 'websocket',
      cookie: 'allison_web_iptv_auth=x'
    })
    expect(out).toEqual({ cookie: 'allison_web_iptv_auth=x' })
  })

  it('keeps end-to-end headers — the stream headers the proxy needs', () => {
    const out = stripHopByHopHeaders({
      range: 'bytes=0-',
      'user-agent': 'Lavf/60.3.100',
      'icy-metadata': '1',
      accept: '*/*',
      cookie: 'a=b'
    })
    expect(out).toEqual({ range: 'bytes=0-', 'user-agent': 'Lavf/60.3.100', 'icy-metadata': '1', accept: '*/*', cookie: 'a=b' })
  })

  it('answers an empty object for empty headers', () => {
    expect(stripHopByHopHeaders({})).toEqual({})
  })
})
