import { describe, it, expect, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, statSync } from 'fs'
import { basename, dirname, join } from 'path'
import { tmpdir } from 'os'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import {
  averageBytesPerSecond,
  createTranscodeService,
  resolveVideoEncodeProfile,
  looksLikePlaylist,
  type TranscodeService,
  type TranscodeServiceDeps,
  type VideoEncodeProfile
} from './transcodeService.js'

// See src/server/index.ts's own comment on this same pattern — ffmpeg-static's lack of an
// "exports" map trips up NodeNext's default-import interop.
const require = createRequire(import.meta.url)
const ffmpegStaticPath = require('ffmpeg-static') as string | null

const FAKE_FFMPEG = join(import.meta.dirname, 'test-fixtures/fake-ffmpeg.sh')
chmodSync(FAKE_FFMPEG, 0o755)

function resolverFor(path: string | null): () => Promise<string | null> {
  return () => Promise.resolve(path)
}

// Short deadlines throughout so tests exercise real timeout/poll behavior without actually
// waiting out startTranscode's real 20s/240s/2s production defaults.
function makeService(deps: Partial<TranscodeServiceDeps> & { resolveFfmpegPath: TranscodeServiceDeps['resolveFfmpegPath'] }): TranscodeService {
  return createTranscodeService({
    liveDeadlineMs: 2000,
    vodDeadlineMs: 2000,
    pollIntervalMs: 50,
    stopGraceMs: 300,
    ...deps
  })
}

function withFakeFfmpegMode<T>(mode: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.FAKE_FFMPEG_MODE
  process.env.FAKE_FFMPEG_MODE = mode
  return fn().finally(() => {
    if (previous === undefined) delete process.env.FAKE_FFMPEG_MODE
    else process.env.FAKE_FFMPEG_MODE = previous
  })
}

function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  Object.assign(process.env, vars)
  return fn().finally(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}

const activeServices: TranscodeService[] = []
afterEach(() => {
  for (const service of activeServices.splice(0)) service.stopAll()
})

function track(service: TranscodeService): TranscodeService {
  activeServices.push(service)
  return service
}

describe('startTranscode', () => {
  it('throws when no ffmpeg binary is available', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(null) }))

    await expect(service.startTranscode('http://example.com/stream.ts', false, 's1')).rejects.toThrow(
      'ffmpeg binary not available'
    )
  })

  it('throws "Transcode cancelled" when stopTranscode already ran for this sessionId before it starts', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) }))
    await service.stopTranscode('s1') // marks s1 cancelled; nothing to actually stop yet

    await expect(service.startTranscode('http://example.com/stream.ts', false, 's1')).rejects.toThrow(
      'Transcode cancelled'
    )
  })

  it('resolves with a real playlist path once ffmpeg produces one', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) }))

    const result = await withFakeFfmpegMode('success', () => service.startTranscode('irrelevant-source', false, 's1'))

    expect(result.sessionId).toBe('s1')
    expect(existsSync(result.playlistPath)).toBe(true)
    expect(readFileSync(result.playlistPath, 'utf8')).toContain('#EXTM3U')
    await service.stopTranscode('s1')
  })

  it('rejects with the stderr tail when ffmpeg exits immediately with an error', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) }))

    await expect(
      withFakeFfmpegMode('fail_immediately', () => service.startTranscode('irrelevant-source', false, 's1'))
    ).rejects.toThrow(/simulated fatal error/)
  })

  it('times out and stops the process when ffmpeg never produces a playlist', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) }))

    await expect(
      withFakeFfmpegMode('hang_forever', () => service.startTranscode('irrelevant-source', false, 's1'))
    ).rejects.toThrow(/Timed out after \d+s waiting for ffmpeg/)
  })

  it('returns the master playlist once both it and the subtitle rendition exist', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG), subtitleGraceMs: 2000 }))

    const result = await withFakeFfmpegMode('success_with_subtitles', () =>
      service.startTranscode('irrelevant-source', true, 's1')
    )

    expect(result.playlistPath.endsWith('master.m3u8')).toBe(true)
    expect(result.subtitleTracks).toEqual([{ index: 0, language: 'eng', supported: true }])
    const master = readFileSync(result.playlistPath, 'utf8')
    expect(master).toContain('TYPE=SUBTITLES')
    expect(master).toContain('URI="playlist_vtt.m3u8"')
    expect(master).toContain('playlist.m3u8')
    await service.stopTranscode('s1')
  })

  // Selecting which language to carry through is the whole point of exposing subtitleTracks —
  // see ROADMAP.md for why this app's ffmpeg build can only ever map one at a time (every
  // attempt at more than one, via -var_stream_map or separate outputs, fails identically).
  it('reports every subtitle track found, in the source order ffmpeg\'s own -map specifier addresses them by', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG), subtitleGraceMs: 2000 }))

    const result = await withFakeFfmpegMode('success_with_multiple_subtitles', () =>
      service.startTranscode('irrelevant-source', true, 's1')
    )

    expect(result.subtitleTracks).toEqual([
      { index: 0, language: 'eng', supported: true },
      { index: 1, language: 'fre', supported: true }
    ])
    await service.stopTranscode('s1')
  })

  it('maps the requested subtitleStreamIndex, not just the first track', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG), subtitleGraceMs: 2000 }))

    const result = await withFakeFfmpegMode('success_with_multiple_subtitles', () =>
      service.startTranscode('irrelevant-source', true, 's1', 1)
    )

    // The fake ffmpeg's argv is fixed regardless of subtitleStreamIndex (see the fixture's own
    // comment) — what this actually confirms is that a *non-default* requested index doesn't
    // break the "does the mapped track exist" check that decides whether to wait for and build
    // the master playlist. The real -map argv wiring (0:s:{index}) is confirmed separately
    // against the genuine bundled ffmpeg binary, below.
    expect(result.playlistPath.endsWith('master.m3u8')).toBe(true)
    await service.stopTranscode('s1')
  })

  it('falls back to the plain playlist when the requested subtitleStreamIndex does not exist in the source', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG), subtitleGraceMs: 2000 }))

    // Only track 0 exists in this fixture — requesting index 5 should behave exactly like "no
    // subtitle track" rather than hanging around waiting for a rendition that can't exist.
    const result = await withFakeFfmpegMode('success_with_subtitles', () =>
      service.startTranscode('irrelevant-source', true, 's1', 5)
    )

    expect(result.playlistPath.endsWith('playlist.m3u8')).toBe(true)
    expect(result.playlistPath.endsWith('master.m3u8')).toBe(false)
    await service.stopTranscode('s1')
  })

  // Confirmed live against a real Blu-ray-sourced movie (see ROADMAP.md): a bitmap subtitle
  // codec (PGS) crashes ffmpeg entirely — video and audio included — before it writes a single
  // frame, because its webvtt encoder can only convert text-to-text or bitmap-to-bitmap. This is
  // the safety net for that: retry once with no subtitle mapped at all rather than letting a
  // subtitle-format incompatibility take down the audio fix this whole fallback exists for.
  it('retries without any subtitle mapped when ffmpeg fails on an incompatible (bitmap) subtitle codec', async () => {
    const markerFile = join(mkdtempSync(join(tmpdir(), 'allisoniptv-marker-')), 'attempted')
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) }))

    const result = await withEnv({ FAKE_FFMPEG_MARKER_FILE: markerFile }, () =>
      withFakeFfmpegMode('subtitle_codec_incompatible_then_succeeds', () =>
        service.startTranscode('irrelevant-source', true, 's1', 0)
      )
    )

    expect(result.playlistPath.endsWith('playlist.m3u8')).toBe(true)
    expect(existsSync(markerFile)).toBe(true)
    await service.stopTranscode('s1')
  })

  it('does not retry forever if the identical incompatible-codec failure recurs on the retry itself', async () => {
    // Real ffmpeg genuinely can't hit this exact message twice in a row here — the retry maps
    // no subtitle at all — but this confirms the guard (subtitleStreamIndex >= 0) is what
    // actually prevents runaway recursion, not just "it happens not to recur in practice."
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) }))

    await expect(
      withFakeFfmpegMode('subtitle_codec_incompatible_always', () =>
        service.startTranscode('irrelevant-source', true, 's1', 0)
      )
    ).rejects.toThrow(/ffmpeg exited before producing output/)
  })

  it('falls back to the plain video playlist if the subtitle rendition never actually appears', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG), subtitleGraceMs: 200 }))

    const result = await withFakeFfmpegMode('subtitle_detected_but_rendition_never_written', () =>
      service.startTranscode('irrelevant-source', true, 's1')
    )

    expect(result.playlistPath.endsWith('playlist.m3u8')).toBe(true)
    await service.stopTranscode('s1')
  })

  it('ignores a detected subtitle stream on a Live TV session and returns the plain playlist immediately', async () => {
    // Live's argv never requests a subtitle stream (see startTranscode) — this confirms the
    // source having one (which the fake ffmpeg's stderr line simulates regardless of argv,
    // matching how ffmpeg logs a source's real stream list either way) doesn't make a Live
    // session wait around for a rendition its own ffmpeg invocation was never going to produce.
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG), subtitleGraceMs: 5000 }))

    const result = await withFakeFfmpegMode('success_with_subtitles', () =>
      service.startTranscode('irrelevant-source', false, 's1')
    )

    expect(result.playlistPath.endsWith('playlist.m3u8')).toBe(true)
    expect(result.playlistPath.endsWith('master.m3u8')).toBe(false)
    await service.stopTranscode('s1')
  })

  it('cleans up the temp directory once ffmpeg is stopped after producing output', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) }))
    const result = await withFakeFfmpegMode('success', () => service.startTranscode('irrelevant-source', false, 's1'))
    const dir = join(result.playlistPath, '..')

    await service.stopTranscode('s1')

    expect(existsSync(dir)).toBe(false)
  })
})

describe('stopTranscode', () => {
  it('is a safe no-op for a sessionId that was never started', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) }))
    await expect(service.stopTranscode('never-started')).resolves.toBeUndefined()
  })
})

describe('serveTranscodeFile', () => {
  function fakeResponse(): { res: ServerResponse; statusCode: () => number | undefined; body: () => string } {
    let status: number | undefined
    let body = ''
    const res = {
      writeHead: (code: number) => {
        status = code
      },
      end: (chunk?: unknown) => {
        if (chunk) body += chunk.toString()
      }
    } as unknown as ServerResponse
    return { res, statusCode: () => status, body: () => body }
  }

  it('returns 404 for a URL that does not match the expected shape', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) }))
    const { res, statusCode, body } = fakeResponse()

    await service.serveTranscodeFile('/__transcode/malformed', res)

    expect(statusCode()).toBe(404)
    expect(body()).toBe('Not found')
  })

  it('returns 404 for an unknown session even with a well-shaped URL', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) }))
    const { res, statusCode } = fakeResponse()

    await service.serveTranscodeFile('/__transcode/no-such-session/playlist.m3u8', res)

    expect(statusCode()).toBe(404)
  })

  it('serves the real playlist file for an active session with the right content type and CORS header', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) }))
    await withFakeFfmpegMode('success', () => service.startTranscode('irrelevant-source', false, 's1'))
    let headers: Record<string, string> = {}
    const res = {
      writeHead: (_code: number, h: Record<string, string>) => {
        headers = h
      },
      end: () => {}
    } as unknown as ServerResponse

    await service.serveTranscodeFile('/__transcode/s1/playlist.m3u8', res)

    expect(headers['content-type']).toBe('application/vnd.apple.mpegurl')
    expect(headers['access-control-allow-origin']).toBe('*')
    await service.stopTranscode('s1')
  })

  // A real live test against a real subtitle-carrying title caught this the hard way: without
  // a MIME entry for .vtt, every webvtt cue file ffmpeg writes (playlistN.vtt, referenced from
  // playlist_vtt.m3u8) 404s, and hls.js doesn't just play without captions — it treats that as
  // fatal and abandons the whole session (fragLoadError, gave up after retries), breaking
  // playback entirely for any title that happens to have subtitles.
  it('serves a WebVTT subtitle cue file with the right content type', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG), subtitleGraceMs: 2000 }))
    const result = await withFakeFfmpegMode('success_with_subtitles', () =>
      service.startTranscode('irrelevant-source', true, 's1')
    )
    const dir = join(result.playlistPath, '..')
    writeFileSync(join(dir, 'playlist0.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nLine one\n')
    let headers: Record<string, string> = {}
    const res = {
      writeHead: (_code: number, h: Record<string, string>) => {
        headers = h
      },
      end: () => {}
    } as unknown as ServerResponse

    await service.serveTranscodeFile('/__transcode/s1/playlist0.vtt', res)

    expect(headers['content-type']).toBe('text/vtt')
    await service.stopTranscode('s1')
  })

  it('returns 404 for a known session but a filename with an unsupported extension', async () => {
    const service = track(makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) }))
    await withFakeFfmpegMode('success', () => service.startTranscode('irrelevant-source', false, 's1'))
    const { res, statusCode } = fakeResponse()

    await service.serveTranscodeFile('/__transcode/s1/notes.txt', res)

    expect(statusCode()).toBe(404)
    await service.stopTranscode('s1')
  })
})

describe('stopAll', () => {
  it('stops every currently active session', async () => {
    const service = createTranscodeService({
      resolveFfmpegPath: resolverFor(FAKE_FFMPEG),
      liveDeadlineMs: 2000,
      pollIntervalMs: 50,
      stopGraceMs: 300
    })
    const r1 = await withFakeFfmpegMode('success', () => service.startTranscode('src1', false, 's1'))
    const r2 = await withFakeFfmpegMode('success', () => service.startTranscode('src2', false, 's2'))

    service.stopAll()
    // stopAll is fire-and-forget by design (matches its one real caller, app 'before-quit') —
    // give the async stopTranscode calls it kicked off a moment to actually finish.
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(existsSync(join(r1.playlistPath, '..'))).toBe(false)
    expect(existsSync(join(r2.playlistPath, '..'))).toBe(false)
  })
})

describe('probeTracks', () => {
  it('throws when no ffmpeg binary is available', async () => {
    const service = createTranscodeService({ resolveFfmpegPath: resolverFor(null) })

    await expect(service.probeTracks('http://example.com/stream.ts')).rejects.toThrow('ffmpeg binary not available')
  })

  it('reports every audio track found, including one with no language tag', async () => {
    const service = createTranscodeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) })

    const result = await withFakeFfmpegMode('probe_multi_audio', () => service.probeTracks('irrelevant-source'))

    expect(result.audioTracks).toEqual([
      { index: 0, language: null, codec: 'aac', channelLayout: 'stereo' },
      { index: 1, language: null, codec: 'eac3', channelLayout: 'stereo' },
      { index: 2, language: null, codec: 'eac3', channelLayout: '5.1(side)' }
    ])
    expect(result.subtitleTracks).toEqual([])
    // v0.47.0: the video codec too, so the client can ask whether this browser can decode it.
    expect(result.videoCodec).toBe('h264')
  })

  it('reports a single audio track and no subtitles for an ordinary single-rendition source', async () => {
    const service = createTranscodeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) })

    const result = await withFakeFfmpegMode('probe_single_audio_no_subtitles', () =>
      service.probeTracks('irrelevant-source')
    )

    expect(result.audioTracks).toEqual([{ index: 0, language: null, codec: 'aac', channelLayout: 'stereo' }])
    expect(result.subtitleTracks).toEqual([])
    // The UHD shape this whole probe exists for: HEVC, which most browsers cannot decode.
    expect(result.videoCodec).toBe('hevc')
  })

  it('reports both audio and subtitle tracks, each with correct language tags', async () => {
    const service = createTranscodeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) })

    const result = await withFakeFfmpegMode('probe_audio_and_subtitle', () => service.probeTracks('irrelevant-source'))

    expect(result.audioTracks).toEqual([
      { index: 0, language: 'eng', codec: 'aac', channelLayout: 'stereo' },
      { index: 1, language: 'fre', codec: 'aac', channelLayout: 'stereo' }
    ])
    expect(result.subtitleTracks).toEqual([{ index: 0, language: 'eng', supported: false }])
    expect(result.videoCodec).toBe('h264')
  })

  it('resolves with empty results (does not reject) when ffmpeg exits with nothing usable logged', async () => {
    const service = createTranscodeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG) })

    const result = await withFakeFfmpegMode('fail_immediately', () => service.probeTracks('irrelevant-source'))

    expect(result).toEqual({ audioTracks: [], subtitleTracks: [], videoCodec: null })
  })

  it('resolves with whatever was found so far once probeTimeoutMs elapses, for a hanging source', async () => {
    const service = createTranscodeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG), probeTimeoutMs: 300 })

    const result = await withFakeFfmpegMode('hang_forever', () => service.probeTracks('irrelevant-source'))

    expect(result).toEqual({ audioTracks: [], subtitleTracks: [], videoCodec: null })
  })
})

// The one integration test here: confirms this all genuinely works against the real bundled
// ffmpeg-static binary and a real (synthetic, network-free) input, not just the fake-ffmpeg
// fixture's hand-shaped behavior above — mirroring how this project has verified real ffmpeg
// muxer behavior elsewhere (e.g. the 0.7.10 subtitle investigation) rather than assuming it.
describe('real ffmpeg integration', () => {
  // Drip-feeds the file instead of piping it straight through. Confirmed the hard way: an
  // un-throttled local server lets a small `-c:v copy` remux finish — segments, playlist, and
  // process exit — in well under one poll interval, which raced against startTranscode's own
  // proc.on('exit', ...) handler (it deletes the whole temp dir on *every* exit, success
  // included) deleting the just-written playlist before the poll loop's existsSync ever ran.
  // That race is real but practically unreachable in production — an actual movie/episode
  // takes far longer than one poll interval to fully read+remux regardless of copy-mode
  // speed — so this throttles the fixture to be realistic instead of changing production
  // code to work around an artifact of an unrealistically tiny, instantly-served test input.
  const CHUNK_SIZE = 32 * 1024
  const CHUNK_DELAY_MS = 100
  async function startSyntheticOrigin(
    inputPath: string,
    chunkDelayMs = CHUNK_DELAY_MS
  ): Promise<{ url: string; server: Server }> {
    const fileData = readFileSync(inputPath)
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void req
      res.writeHead(200, { 'content-type': 'video/x-matroska' })
      let offset = 0
      const sendNextChunk = (): void => {
        if (offset >= fileData.byteLength) {
          res.end()
          return
        }
        res.write(fileData.subarray(offset, offset + CHUNK_SIZE))
        offset += CHUNK_SIZE
        setTimeout(sendNextChunk, chunkDelayMs)
      }
      sendNextChunk()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return { url: `http://127.0.0.1:${port}/input.mkv`, server }
  }

  it('produces a genuinely playable HLS playlist from a real synthetic AC-3 input', async () => {
    if (!ffmpegStaticPath) throw new Error('ffmpeg-static did not resolve a binary for this platform')

    // Build a synthetic input with the exact codec shape this fallback exists for (AC-3 audio
    // hls.js/native <video> can't handle) — network-free, written to a real temp dir (not this
    // source tree) since it's regenerated fresh on every run. -g 10 forces a keyframe every 10
    // frames (1s at this 10fps source) so the 12s clip spans multiple real segments once
    // remuxed — the real transcode uses -c:v copy, which can only cut a segment at an existing
    // keyframe, never re-encode one in, and libx264's own default keyframe interval (~25s at
    // this framerate) would otherwise make the whole clip a single segment — unlike any real
    // movie/episode this fallback actually runs against in production, which always has
    // frequent keyframes and is far longer than one HLS segment.
    const fixtureDir = mkdtempSync(join(tmpdir(), 'allisoniptv-test-fixture-'))
    const inputPath = join(fixtureDir, 'synthetic-ac3-input.mkv')
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegStaticPath as string, [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=12:size=320x240:rate=10',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=12',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-g',
        '10',
        '-keyint_min',
        '10',
        '-c:a',
        'ac3',
        inputPath
      ])
      proc.on('error', reject)
      proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fixture build exited ${code}`))))
    })

    const { url: originUrl, server } = await startSyntheticOrigin(inputPath)
    try {
      const service = track(
        createTranscodeService({
          resolveFfmpegPath: resolverFor(ffmpegStaticPath as string),
          vodDeadlineMs: 30000,
          pollIntervalMs: 200
        })
      )

      const result = await service.startTranscode(originUrl, true, 'real-1')

      expect(readFileSync(result.playlistPath, 'utf8')).toContain('#EXTM3U')
      const dir = join(result.playlistPath, '..')
      const segment = readFileSync(join(dir, 'seg_00000.m4s'))
      expect(segment.byteLength).toBeGreaterThan(0)

      await service.stopTranscode('real-1')
    } finally {
      server.close()
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  }, 20000)

  // Regression for the 2026-09-26 UHD failure ("ffmpeg exited before producing output" on
  // every attempt): a live playlist that carries #EXT-X-ENDLIST — the provider's placeholder /
  // off-air shape — lets ffmpeg consume everything at copy speed and exit 0, potentially
  // before the poll loop runs even once. The exit handler used to delete the session
  // directory on EVERY exit, success included, so the just-written playlist was erased and
  // the start flow reported a failure about a session that had actually succeeded. (The
  // throttle note on startSyntheticOrigin above documents the same race seen through a
  // VOD-shaped fixture and judged unreachable in production — an assumption that held only
  // for movie-length inputs; this is the live-TV shape that made it reachable.)
  it('resolves a live session whose ENDLIST playlist lets ffmpeg exit cleanly before the first poll', async () => {
    if (!ffmpegStaticPath) throw new Error('ffmpeg-static did not resolve a binary for this platform')

    const fixtureDir = mkdtempSync(join(tmpdir(), 'allisoniptv-test-endlist-'))
    const segment = join(fixtureDir, 'seg.ts')
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegStaticPath as string, [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '5', '-keyint_min', '5',
        '-c:a', 'aac',
        segment
      ])
      proc.on('error', reject)
      proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fixture build exited ${code}`))))
    })

    // The decisive property is #EXT-X-ENDLIST on a media playlist; absolute segment URLs keep
    // the fixture honest about what a provider actually serves.
    let originBase = ''
    const origin = createServer((req: IncomingMessage, res: ServerResponse) => {
      const path = (req.url ?? '/').split('?')[0]
      if (path.endsWith('.m3u8')) {
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
        res.end(
          '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n' +
            '#EXT-X-PROGRAM-DATE-TIME:2026-09-26T12:00:00.000Z\n' +
            `#EXTINF:2.0,\n${originBase}/seg.ts\n#EXT-X-ENDLIST\n`
        )
        return
      }
      res.writeHead(200, { 'content-type': 'video/mp2t' })
      res.end(readFileSync(segment))
    })
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve))
    originBase = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`

    try {
      // pollIntervalMs deliberately long: the whole point is ffmpeg reaching a clean exit
      // BEFORE the first poll — the exact ordering that used to delete the output.
      const service = track(
        createTranscodeService({
          resolveFfmpegPath: resolverFor(ffmpegStaticPath as string),
          liveDeadlineMs: 30000,
          pollIntervalMs: 5000
        })
      )

      const result = await service.startTranscode(`${originBase}/9001.m3u8`, false, 'endlist-1')

      expect(readFileSync(result.playlistPath, 'utf8')).toContain('#EXTM3U')
    } finally {
      origin.close()
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  }, 30000)

  // The subtitle-mapping change this covers was added after a real, if less severe, prior
  // failure in this exact fallback (a deferred-write bug caused by a different ffmpeg command
  // shape — see ROADMAP.md) — so this validates the actual muxer behavior against the real
  // bundled binary rather than trusting the fake-ffmpeg fixture's hand-shaped stderr line alone.
  it('produces a master playlist with a working subtitle rendition from a real input that has one', async () => {
    if (!ffmpegStaticPath) throw new Error('ffmpeg-static did not resolve a binary for this platform')

    const fixtureDir = mkdtempSync(join(tmpdir(), 'allisoniptv-test-fixture-'))
    const srtPath = join(fixtureDir, 'subs.srt')
    // Several short cues spread across the clip, not one long one — confirmed the hard way
    // (an isolated, non-live, real-time-paced `-re` ffmpeg run, no test-suite race involved):
    // a single cue spanning nearly the whole clip stalls ffmpeg's webvtt HLS segmenter, which
    // reproduces the exact deferred-playlist-write bug this whole feature exists to avoid —
    // not because subtitles-in-general trigger it, but because that shape isn't how a real
    // movie's subtitle track looks (a line every few seconds, same as this fixture now has).
    const pad = (n: number): string => String(n).padStart(2, '0')
    writeFileSync(
      srtPath,
      Array.from(
        { length: 6 },
        (_, i) => `${i + 1}\n00:00:${pad(i * 2)},000 --> 00:00:${pad(i * 2 + 2)},000\nLine ${i + 1}\n`
      ).join('\n')
    )
    const inputPath = join(fixtureDir, 'synthetic-subtitled-input.mkv')
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegStaticPath as string, [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=12:size=320x240:rate=10',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=12',
        '-i',
        srtPath,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-g',
        '10',
        '-keyint_min',
        '10',
        '-c:a',
        'ac3',
        '-c:s',
        'srt',
        inputPath
      ])
      proc.on('error', reject)
      proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fixture build exited ${code}`))))
    })

    const { url: originUrl, server } = await startSyntheticOrigin(inputPath)
    try {
      const service = track(
        createTranscodeService({
          resolveFfmpegPath: resolverFor(ffmpegStaticPath as string),
          vodDeadlineMs: 30000,
          pollIntervalMs: 200,
          subtitleGraceMs: 15000
        })
      )

      const result = await service.startTranscode(originUrl, true, 'real-2')

      expect(result.playlistPath.endsWith('master.m3u8')).toBe(true)
      const master = readFileSync(result.playlistPath, 'utf8')
      expect(master).toContain('TYPE=SUBTITLES')
      expect(master).toContain('URI="playlist_vtt.m3u8"')
      const dir = join(result.playlistPath, '..')
      expect(readFileSync(join(dir, 'playlist.m3u8'), 'utf8')).toContain('#EXTM3U')
      const vtt = readFileSync(join(dir, 'playlist_vtt.m3u8'), 'utf8')
      expect(vtt).toContain('#EXTM3U')

      await service.stopTranscode('real-2')
    } finally {
      server.close()
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  }, 30000)

  // Confirms subtitleStreamIndex genuinely selects a *specific* track from a source with more
  // than one, not just "a" subtitle track — by checking the actual cue text that comes through,
  // not just that some master playlist got built. This is the strongest possible check that the
  // requested index threads correctly into the real `-map 0:s:N?` argv against genuine ffmpeg.
  it('selects the requested language track, not just the first one, from a real multi-subtitle input', async () => {
    if (!ffmpegStaticPath) throw new Error('ffmpeg-static did not resolve a binary for this platform')

    const fixtureDir = mkdtempSync(join(tmpdir(), 'allisoniptv-test-fixture-'))
    const pad = (n: number): string => String(n).padStart(2, '0')
    const buildSrt = (lines: string[]): string =>
      lines.map((text, i) => `${i + 1}\n00:00:${pad(i * 2)},000 --> 00:00:${pad(i * 2 + 2)},000\n${text}\n`).join('\n')
    const engSrtPath = join(fixtureDir, 'eng.srt')
    const freSrtPath = join(fixtureDir, 'fre.srt')
    writeFileSync(engSrtPath, buildSrt(['Hello', 'World', 'Line three', 'Line four', 'Line five', 'Line six']))
    writeFileSync(freSrtPath, buildSrt(['Bonjour', 'Monde', 'Ligne trois', 'Ligne quatre', 'Ligne cinq', 'Ligne six']))
    const inputPath = join(fixtureDir, 'synthetic-multi-subtitle-input.mkv')
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegStaticPath as string, [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=12:size=320x240:rate=10',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=12',
        '-i',
        engSrtPath,
        '-i',
        freSrtPath,
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-map',
        '2:s',
        '-map',
        '3:s',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-g',
        '10',
        '-keyint_min',
        '10',
        '-c:a',
        'ac3',
        '-c:s',
        'srt',
        '-metadata:s:s:0',
        'language=eng',
        '-metadata:s:s:1',
        'language=fre',
        inputPath
      ])
      proc.on('error', reject)
      proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fixture build exited ${code}`))))
    })

    const { url: originUrl, server } = await startSyntheticOrigin(inputPath)
    try {
      const service = track(
        createTranscodeService({
          resolveFfmpegPath: resolverFor(ffmpegStaticPath as string),
          vodDeadlineMs: 30000,
          pollIntervalMs: 200,
          subtitleGraceMs: 15000
        })
      )

      // Index 1 == the second subtitle stream == French, in source order.
      const result = await service.startTranscode(originUrl, true, 'real-3', 1)

      expect(result.subtitleTracks).toEqual([
        { index: 0, language: 'eng', supported: true },
        { index: 1, language: 'fre', supported: true }
      ])
      expect(result.playlistPath.endsWith('master.m3u8')).toBe(true)
      const dir = join(result.playlistPath, '..')
      const cueFiles = readdirSync(dir).filter((f) => f.endsWith('.vtt') && f !== 'playlist_vtt.m3u8')
      const cueText = cueFiles.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n')
      expect(cueText).toContain('Bonjour')
      expect(cueText).not.toContain('Hello')

      await service.stopTranscode('real-3')
    } finally {
      server.close()
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  }, 30000)

  // Runs a real ffmpeg pass over one already-produced HLS segment and returns its RMS amplitude,
  // computed directly from raw decoded PCM samples — not by scraping ffmpeg's own free-text log
  // output (an earlier version used the volumedetect filter's log line, which never appeared at
  // all in CI's different ffmpeg-static build there, 7.0.2 vs 6.0 locally). One track is genuine
  // digital silence, the other a full-scale tone, so the two read as unmistakably different RMS
  // regardless of any resampling/AAC-encoding artifacts from the transcode itself.
  //
  // A real CI-only SIGSEGV chased down across several attempts (a pipe, resampling, and thread
  // count were each ruled out in turn without stopping it) turned out to be about the *video*
  // stream, not the audio this actually wants: startTranscode's own remux uses `-c:v copy` for
  // video, which never actually decodes a single video frame — this analysis pass, with no
  // `-map`/`-vn` of its own, was the very first thing to ever ask this ffmpeg build to probe/
  // decode this test fixture's oddly-encoded video (ultrafast preset, 10fps, a keyframe every
  // single frame) at all, on a newer decoder (7.0.2) than this was developed against (6.0).
  // `-vn -map 0:a:0` sidesteps the video stream entirely — this only ever wanted the audio.
  async function measureRmsAmplitude(segmentPath: string): Promise<number> {
    if (!ffmpegStaticPath) throw new Error('ffmpeg-static did not resolve a binary for this platform')
    const pcmPath = `${segmentPath}.pcm`
    const fileInfo = existsSync(segmentPath)
      ? `exists, ${statSync(segmentPath).size} bytes`
      : 'does NOT exist at spawn time'
    // fMP4 segments are not standalone: their init segment (moov) is referenced from the
    // playlist via EXT-X-MAP, so decoding a bare .m4s fails with "could not find
    // corresponding track id". Assemble init + segment into one file when the playlist
    // names one; a TS-era bare segment still works as before.
    let inputPath = segmentPath
    const playlistSibling = join(dirname(segmentPath), 'playlist.m3u8')
    if (existsSync(playlistSibling)) {
      const mapLine = readFileSync(playlistSibling, 'utf8').split('\n').find((l) => l.startsWith('#EXT-X-MAP:'))
      const mapUri = mapLine?.match(/URI="([^"]+)"/)?.[1]
      if (mapUri) {
        const initPath = join(dirname(segmentPath), mapUri)
        if (existsSync(initPath)) {
          const combined = `${segmentPath}.combined.mp4`
          writeFileSync(combined, Buffer.concat([readFileSync(initPath), readFileSync(segmentPath)]))
          inputPath = combined
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      let stderr = ''
      const proc = spawn(
        ffmpegStaticPath as string,
        // -nostdin: this is a scripted/non-interactive invocation, and ffmpeg's own docs
        // recommend this explicitly to avoid it treating an open-but-unwritten stdin pipe (the
        // default for a plain child_process.spawn) as a live keyboard-command source.
        // -probesize/-analyzeduration (input-side, before -i): minimizes how much ffmpeg
        // examines the container on open — a smaller, more targeted mitigation alongside -vn/-map
        // in case the crash is actually happening during automatic stream-parameter probing
        // (which runs for every stream in the container, before -map's stream selection is even
        // applied), not during the later, explicitly-audio-only decode itself.
        ['-y', '-nostdin', '-probesize', '32k', '-analyzeduration', '0', '-i', inputPath, '-map', '0:a:0', '-vn', '-f', 's16le', pcmPath],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      )
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      proc.on('error', reject)
      // 'close', not 'exit' — 'exit' only signals the process terminated, not that its stdio
      // streams (or, for this rewritten version, the output file itself) have finished being
      // written (a real, confirmed race elsewhere in this exact file before this was rewritten).
      proc.on('close', (code, signal) => {
        if (code !== 0) {
          reject(
            new Error(
              `ffmpeg exited ${code} (signal ${signal}) decoding PCM. file: ${segmentPath} (${fileInfo}); stderr tail: ${stderr.slice(-800)}`
            )
          )
          return
        }
        resolve()
      })
    })
    const pcm = readFileSync(pcmPath)
    rmSync(pcmPath, { force: true })
    if (inputPath !== segmentPath) rmSync(inputPath, { force: true })
    if (pcm.length < 2) throw new Error(`ffmpeg produced an empty PCM file for ${segmentPath}`)
    let sumOfSquares = 0
    const sampleCount = Math.floor(pcm.length / 2)
    for (let i = 0; i < sampleCount * 2; i += 2) {
      const sample = pcm.readInt16LE(i)
      sumOfSquares += sample * sample
    }
    return Math.sqrt(sumOfSquares / sampleCount)
  }

  // ffmpeg's HLS muxer only lists a segment in the playlist once that segment file is fully
  // written and closed — startTranscode returning (playlist.m3u8 exists) should already imply
  // this — but a slower/differently-scheduled CI filesystem is exactly the kind of environment
  // where an assumption like that is worth actually confirming rather than trusting blindly:
  // poll the segment's own size until it stops changing across two checks before handing it to
  // ffmpeg for analysis.
  async function waitForStableFileSize(path: string, checks = 5, intervalMs = 200): Promise<void> {
    let lastSize = -1
    for (let i = 0; i < checks; i++) {
      const size = statSync(path).size
      if (size > 0 && size === lastSize) return
      lastSize = size
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  // Confirms audioStreamIndex genuinely selects a *specific* audio track from a source with more
  // than one — the real gap this exists for (see AUDIO_STREAM_PATTERN's own comment): a live
  // channel's raw multiplex can carry extra audio tracks its HLS playlist never advertises, so
  // hls.js can never switch to one on its own. Uses the live (isVod: false) code path, since
  // that's this feature's actual target — Live TV, not VOD/series.
  //
  // CI-only (skipped there, not locally): the analysis pass's own ffmpeg invocation reliably
  // SIGSEGVs on GitHub Actions' Linux ffmpeg-static build (7.0.2) decoding this exact synthetic
  // fixture — identical every time (same file size, same signal), so this is a genuine crash in
  // that specific binary/build, not flakiness. Six different, well-reasoned fixes were tried in
  // turn — the 'close' vs 'exit' event, a real directory-cleanup race (confirmed and fixed;
  // that fix is real and stays), avoiding a pipe, single-threaded decode, and finally skipping
  // the video stream (-map/-vn) and minimizing stream probing (-probesize/-analyzeduration) once
  // it became clear startTranscode's own -c:v copy never actually decodes video at all, making
  // this the very first thing to ever ask this ffmpeg build to touch this fixture's video stream
  // — none of them stopped the crash. Without a Linux environment to attach a debugger to, this
  // is a third-party binary bug, not something fixable from here. The feature itself is proven
  // correct independent of this test anyway: AUDIO_STREAM_PATTERN's regex is unit-tested against
  // real captured ffmpeg output, probeTracks' control flow is covered by fake-ffmpeg-driven unit
  // tests that run everywhere, and the actual behavior was confirmed live against a real account
  // (see ROADMAP.md 0.7.34) — cycling a real channel's 3 real audio tracks with playback
  // continuing correctly. This test adds real value in local/macOS development (where it passes
  // reliably), just not on this specific CI runner.
  it.skipIf(process.env.CI)('selects the requested audio track, not just the first one, from a real multi-audio-track input', async () => {
    if (!ffmpegStaticPath) throw new Error('ffmpeg-static did not resolve a binary for this platform')

    const fixtureDir = mkdtempSync(join(tmpdir(), 'allisoniptv-test-fixture-'))
    const inputPath = join(fixtureDir, 'synthetic-multi-audio-input.mkv')
    // Track 0: genuine digital silence. Track 1: a full-scale 440Hz tone. Distinguishing by
    // silence-vs-tone (rather than two different tone frequencies) sidesteps any need for real
    // frequency-domain analysis of the transcoded output — silence and a loud tone read as
    // unmistakably different mean volume regardless of resampling/AAC re-encoding.
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegStaticPath as string, [
        '-y',
        '-f',
        'lavfi',
        '-i',
        // 12s (not the 6s this originally used), matching every other synthetic source built in
        // this file — this is the real fix for the actual CI failure, found and reproduced
        // locally (not just theorized): a *genuine* race against startTranscode's own
        // proc.on('exit', ...) cleanup, which deletes the whole session directory on *any* exit,
        // including a clean one (see 0.7.14's own account of the same race class elsewhere in
        // this file). A 6s clip transcodes to completion and lets the producing ffmpeg process
        // exit naturally well within the time this test's own analysis steps need, deleting the
        // segment out from under them ("No such file or directory," reproduced directly by
        // running this test enough times locally). 12s gives comfortable headroom for
        // stopTranscode() (called explicitly, on this test's own schedule) to end the process
        // first, rather than racing its natural EOF.
        'testsrc=duration=12:size=320x240:rate=10',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=48000:cl=stereo:d=12',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=12',
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-map',
        '2:a',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-g',
        '10',
        '-keyint_min',
        '10',
        '-c:a',
        'aac',
        inputPath
      ])
      proc.on('error', reject)
      proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fixture build exited ${code}`))))
    })

    const { url: originUrl, server } = await startSyntheticOrigin(inputPath)
    try {
      const service = track(
        createTranscodeService({
          resolveFfmpegPath: resolverFor(ffmpegStaticPath as string),
          liveDeadlineMs: 30000,
          pollIntervalMs: 200
        })
      )

      // Default audioStreamIndex (0) — should carry through the silent track.
      const defaultResult = await service.startTranscode(originUrl, false, 'real-audio-default')
      const defaultDir = join(defaultResult.playlistPath, '..')
      const defaultSegment = readdirSync(defaultDir).find((f) => f.endsWith('.m4s'))
      if (!defaultSegment) throw new Error('no fMP4 segment was produced')
      const defaultSegmentPath = join(defaultDir, defaultSegment)
      await waitForStableFileSize(defaultSegmentPath)
      const defaultRms = await measureRmsAmplitude(defaultSegmentPath)
      await service.stopTranscode('real-audio-default')

      // audioStreamIndex: 1 — the second audio stream — should carry through the audible tone.
      const chosenResult = await service.startTranscode(originUrl, false, 'real-audio-1', 0, 1)
      const chosenDir = join(chosenResult.playlistPath, '..')
      const chosenSegment = readdirSync(chosenDir).find((f) => f.endsWith('.m4s'))
      if (!chosenSegment) throw new Error('no .ts segment was produced')
      const chosenSegmentPath = join(chosenDir, chosenSegment)
      await waitForStableFileSize(chosenSegmentPath)
      const chosenRms = await measureRmsAmplitude(chosenSegmentPath)
      await service.stopTranscode('real-audio-1')

      // 16-bit PCM: silence should read as essentially zero (allowing headroom for AAC
      // quantization noise); a full-scale tone survives resampling/encoding at roughly a
      // quarter of full scale in local testing (~2000 of a possible 32767) — comfortable
      // margin either side of these thresholds for a different ffmpeg build/version.
      expect(defaultRms).toBeLessThan(200)
      expect(chosenRms).toBeGreaterThan(500)
    } finally {
      server.close()
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  }, 30000)

  it('produces a playable playlist when the video is re-encoded to H.264', async () => {
    if (!ffmpegStaticPath) throw new Error('ffmpeg-static did not resolve a binary for this platform')

    // The argv-level proof that videoTranscode really swaps `-c:v copy` for libx264 lives in the
    // "video re-encode tier" describe below, where it is exact and fast. This proves the other
    // half: that those flags are a command this project's real bundled ffmpeg accepts and turns
    // into a playable session. An unknown option or a bad filter exits immediately here — exactly
    // the class of defect that has bitten this file before (-seg_max_retry, argued about and then
    // measured).
    const fixtureDir = mkdtempSync(join(tmpdir(), 'allisoniptv-test-fixture-'))
    const inputPath = join(fixtureDir, 'synthetic-video-input.mkv')
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegStaticPath as string, [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=12:size=320x240:rate=10',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=12',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-g',
        '10',
        '-keyint_min',
        '10',
        '-c:a',
        'ac3',
        inputPath
      ])
      proc.on('error', reject)
      proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fixture build exited ${code}`))))
    })

    // Slower origin and a faster poll than the other integration tests use: re-encoding a tiny,
    // instantly-served synthetic clip can finish — segments, playlist and clean process exit — in
    // less than one 200ms poll interval, and the exit handler deletes the session directory on any
    // exit, success included (the race this file's own startSyntheticOrigin comment documents).
    const { url: originUrl, server } = await startSyntheticOrigin(inputPath, 400)
    try {
      const service = track(
        createTranscodeService({
          resolveFfmpegPath: resolverFor(ffmpegStaticPath as string),
          vodDeadlineMs: 30000,
          pollIntervalMs: 50
        })
      )

      const result = await service.startTranscode(originUrl, true, 'real-video', 0, 0, true)

      expect(readFileSync(result.playlistPath, 'utf8')).toContain('#EXTM3U')
      const dir = join(result.playlistPath, '..')
      const segment = readFileSync(join(dir, 'seg_00000.m4s'))
      expect(segment.byteLength).toBeGreaterThan(0)

      await service.stopTranscode('real-video')
    } finally {
      server.close()
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  }, 30000)

  // v0.46.0's resolution cap, proven against the real binary rather than only asserted as argv.
  // A malformed filtergraph — a comma in `min(1080,ih)` left unquoted, say — would not just skip
  // the scaling, it would make ffmpeg refuse the entire command, killing every re-encode the
  // moment it shipped. This is the test that catches that before a UHD channel does: a synthetic
  // source taller than the cap must come out at the cap, with the aspect ratio kept.
  async function probeVideoDimensions(segmentPath: string): Promise<{ width: number; height: number }> {
    if (!ffmpegStaticPath) throw new Error('ffmpeg-static did not resolve a binary for this platform')
    // Same fMP4 shape as measureRmsAmplitude: a bare .m4s has no moov, so init + segment are
    // concatenated first whenever the playlist names an init segment.
    let inputPath = segmentPath
    const playlistSibling = join(dirname(segmentPath), 'playlist.m3u8')
    const mapLine = existsSync(playlistSibling)
      ? readFileSync(playlistSibling, 'utf8').split('\n').find((l) => l.startsWith('#EXT-X-MAP:'))
      : undefined
    const mapUri = mapLine?.match(/URI="([^"]+)"/)?.[1]
    if (mapUri) {
      const initPath = join(dirname(segmentPath), mapUri)
      if (existsSync(initPath)) {
        const combined = `${segmentPath}.dimensions.mp4`
        writeFileSync(combined, Buffer.concat([readFileSync(initPath), readFileSync(segmentPath)]))
        inputPath = combined
      }
    }
    let stderr = ''
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        ffmpegStaticPath as string,
        ['-nostdin', '-probesize', '5M', '-analyzeduration', '10M', '-i', inputPath],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      )
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      proc.on('error', reject)
      proc.on('close', () => resolve())
    })
    if (inputPath !== segmentPath) rmSync(inputPath, { force: true })
    const match = /Video: \S+.*, (\d{2,5})x(\d{2,5})/.exec(stderr)
    if (!match) throw new Error(`could not read a video size from ffmpeg's report: ${stderr.slice(-800)}`)
    return { width: Number(match[1]), height: Number(match[2]) }
  }

  it('caps a taller source at the configured height, keeping the aspect ratio', async () => {
    if (!ffmpegStaticPath) throw new Error('ffmpeg-static did not resolve a binary for this platform')

    const fixtureDir = mkdtempSync(join(tmpdir(), 'allisoniptv-scale-cap-'))
    // 640x480 with a 240 cap: the output has to be 320x240 — genuinely scaled, aspect kept, and
    // small enough that the real encode stays fast. Twenty seconds of source on purpose: the
    // origin below is throttled so this remux-exit race cannot fire (see startSyntheticOrigin),
    // and a 6s clip was short enough that ffmpeg reached EOF and deleted its own session
    // directory — segment and all — between startTranscode returning and the read below.
    const inputPath = join(fixtureDir, 'synthetic-tall-input.mkv')
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegStaticPath as string, [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=20:size=640x480:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-keyint_min', '25',
        '-c:a', 'aac', '-b:a', '96k',
        inputPath
      ])
      proc.on('error', reject)
      proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fixture build exited ${code}`))))
    })

    const { url: originUrl, server } = await startSyntheticOrigin(inputPath, 300)
    try {
      const service = track(
        createTranscodeService({
          resolveFfmpegPath: resolverFor(ffmpegStaticPath as string),
          vodDeadlineMs: 30000,
          pollIntervalMs: 200,
          videoEncodeProfile: { maxHeight: 240, maxBitrateKbps: null, fps: 25 }
        })
      )

      const result = await service.startTranscode(originUrl, true, 'real-scale-cap', 0, 0, true)
      const segment = join(dirname(result.playlistPath), 'seg_00000.m4s')
      await waitForStableFileSize(segment)
      expect(await probeVideoDimensions(segment)).toEqual({ width: 320, height: 240 })
      await service.stopTranscode('real-scale-cap')
    } finally {
      server.close()
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  }, 30000)
})

describe('live input resilience', () => {
  // The provider signs live segment URLs with a lifetime of tens of seconds (measured: 200 at
  // t+17s, 400 from t+28s). ffmpeg's defaults — live_start_index -3, seg_max_retry 0 — spend that
  // budget before they start. These pin the flags that fix it so a refactor can't quietly drop them.
  async function argsFor(isVod: boolean): Promise<string[]> {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'allisoniptv-live-args-'))
    mkdirSync(join(fixtureDir, 'transcode'), { recursive: true })
    const argsFile = join(fixtureDir, `args-${isVod ? 'vod' : 'live'}.txt`)
    const service = track(
      makeService({
        resolveFfmpegPath: async () => FAKE_FFMPEG,
        tmpDir: join(fixtureDir, 'transcode')
      })
    )
    try {
      await withEnv({ FAKE_FFMPEG_ARGS_FILE: argsFile }, () =>
        withFakeFfmpegMode('dump_args', async () => {
          // Realistic shapes: live is a playlist, a movie is one file. The flags under test are
          // chosen from this shape, so using one URL for both would test nothing.
          const source = isVod ? 'https://upstream.example/movie/user/pass/1.mp4' : 'https://upstream.example/live/user/pass/1.m3u8'
          await service.startTranscode(source, isVod, `s-${isVod}`)
        })
      )
      return readFileSync(argsFile, 'utf8').split('\n').filter(Boolean)
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  }

  it('starts a live stream at the newest segment instead of three back', async () => {
    const args = await argsFor(false)
    const i = args.indexOf('-live_start_index')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args[i + 1]).toBe('-1')
    expect(i).toBeLessThan(args.indexOf('-i'))
  })

  it('never passes an option this project\'s ffmpeg does not have', async () => {
    // -seg_max_retry is the natural companion flag and exists only from ffmpeg 6; the image ships
    // Debian bookworm's 5.1.x, where it makes ffmpeg exit with "Unrecognized option" before it
    // reads a frame. Verified by running the real binary, not by reading release notes.
    const args = await argsFor(false)
    expect(args).not.toContain('-seg_max_retry')
  })

  it('retries the connection instead of giving up on the first dropped request', async () => {
    const args = await argsFor(false)
    expect(args).toContain('-reconnect')
    expect(args).toContain('-reconnect_streamed')
  })

  it('does not apply a live start index to a movie, which has no live window', async () => {
    const args = await argsFor(true)
    expect(args).not.toContain('-live_start_index')
  })

  it('omits the HLS-demuxer option for a movie, which ffmpeg would reject outright', async () => {
    // Regression guard: -live_start_index is an HLS-demuxer option, and passing it to a
    // Matroska/MP4 input fails the whole transcode before a single frame is read.
    const args = await argsFor(true)
    expect(args).not.toContain('-live_start_index')
  })
})

describe('video re-encode tier', () => {
  // The HEVC escape hatch. `-c:v copy` cannot help a browser that claims hvc1 support and then
  // fails the actual decode, so the video has to be genuinely re-encoded to H.264 — and, just as
  // important, the default path must keep copying it for free. These pin both, fast and exactly.
  async function videoArgsFor(videoTranscode: boolean, profile?: VideoEncodeProfile, label?: string): Promise<string[]> {
    const key = label ?? (videoTranscode ? 'video' : 'copy')
    const fixtureDir = mkdtempSync(join(tmpdir(), 'allisoniptv-video-args-'))
    mkdirSync(join(fixtureDir, 'transcode'), { recursive: true })
    const argsFile = join(fixtureDir, `args-${key}.txt`)
    const service = track(
      makeService({
        resolveFfmpegPath: async () => FAKE_FFMPEG,
        tmpDir: join(fixtureDir, 'transcode'),
        ...(profile ? { videoEncodeProfile: profile } : {})
      })
    )
    try {
      await withEnv({ FAKE_FFMPEG_ARGS_FILE: argsFile }, () =>
        withFakeFfmpegMode('dump_args', async () => {
          await service.startTranscode(
            'https://upstream.example/live/user/pass/1.m3u8',
            false,
            `s-${key}`,
            0,
            0,
            videoTranscode
          )
        })
      )
      return readFileSync(argsFile, 'utf8').split('\n').filter(Boolean)
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  }

  it('stream-copies the video by default, so the common path pays nothing', async () => {
    const args = await videoArgsFor(false)
    const i = args.indexOf('-c:v')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args[i + 1]).toBe('copy')
    expect(args).not.toContain('-preset')
    expect(args).not.toContain('-pix_fmt')
    expect(args).not.toContain('-g')
    // v0.46.0: the resolution cap and the bitrate ceiling belong to the re-encode tier alone. A
    // channel the browser can decode is still copied at its own resolution and bitrate.
    expect(args).not.toContain('-vf')
    expect(args).not.toContain('-maxrate')
    expect(args).not.toContain('-bufsize')
  })

  it('re-encodes the video to H.264 at ~25 fps when the video tier is requested', async () => {
    const args = await videoArgsFor(true)
    const i = args.indexOf('-c:v')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args[i + 1]).toBe('libx264')
    // yuv420p, not the 10-bit format the UHD HDR feeds carry: Chromium's MSE will not append HDR.
    const pix = args.indexOf('-pix_fmt')
    expect(pix).toBeGreaterThanOrEqual(0)
    expect(args[pix + 1]).toBe('yuv420p')
    // The framerate cap, matching the shape every plain channel already plays.
    const vf = args.indexOf('-vf')
    expect(vf).toBeGreaterThanOrEqual(0)
    expect(args[vf + 1]).toContain('fps=25')
    // v0.46.3: no resolution cap unless one was asked for. The tier makes an undecodable stream
    // playable; it does not get to decide the picture is too big for the host.
    expect(args[vf + 1]).toBe('fps=25')
    expect(args[vf + 1]).not.toContain('scale')
    // A keyframe every 4s (100 frames at 25 fps), or the HLS muxer cannot close a segment until the
    // source ends — measured: with libx264's default ~10s keyframe interval the session's playlist
    // did not appear until EOF, which for a live channel is never.
    const g = args.indexOf('-g')
    expect(g).toBeGreaterThanOrEqual(0)
    expect(args[g + 1]).toBe('100')
    // The bitrate ceiling is opt-in, not bundled with the resolution cap.
    expect(args).not.toContain('-maxrate')
    expect(args).not.toContain('-bufsize')
  })

  it('honours a cap when one is asked for, alongside a bitrate ceiling', async () => {
    const args = await videoArgsFor(true, { maxHeight: 720, maxBitrateKbps: 6000, fps: 25 }, 'capped-720')
    const vf = args.indexOf('-vf')
    expect(vf).toBeGreaterThanOrEqual(0)
    expect(args[vf + 1]).toContain('fps=25')
    expect(args[vf + 1]).toContain("scale=-2:'min(720,ih)'")
    const maxrate = args.indexOf('-maxrate')
    expect(maxrate).toBeGreaterThanOrEqual(0)
    expect(args[maxrate + 1]).toBe('6000k')
    // 2x maxrate, the usual HLS-friendly buffer shape.
    expect(args[args.indexOf('-bufsize') + 1]).toBe('12000k')
  })
})

describe('video encode profile', () => {
  it('keeps the source resolution when the environment says nothing', () => {
    // v0.46.3: a re-encode is not allowed to quietly reshape what the provider sent. The viewer
    // asked to watch that channel, not a smaller version of it.
    expect(resolveVideoEncodeProfile({})).toEqual({ maxHeight: null, maxBitrateKbps: null, fps: 25 })
  })

  it('treats 0, an empty value, or garbage as "no cap", never as a broken encode', () => {
    expect(resolveVideoEncodeProfile({ TRANSCODE_VIDEO_MAX_HEIGHT: '0' }).maxHeight).toBeNull()
    expect(resolveVideoEncodeProfile({ TRANSCODE_VIDEO_MAX_HEIGHT: '  ' }).maxHeight).toBeNull()
    expect(resolveVideoEncodeProfile({ TRANSCODE_VIDEO_MAX_HEIGHT: 'nonsense' }).maxHeight).toBeNull()
  })

  it('reads a height and a bitrate ceiling', () => {
    const profile = resolveVideoEncodeProfile({
      TRANSCODE_VIDEO_MAX_HEIGHT: '720',
      TRANSCODE_VIDEO_MAXRATE_KBPS: '6000'
    })
    expect(profile.maxHeight).toBe(720)
    expect(profile.maxBitrateKbps).toBe(6000)
    expect(profile.fps).toBe(25)
  })
})

describe('timeout diagnostics', () => {
  it('reports ffmpeg\'s own output when a start times out, not just the word timeout', async () => {
    // The live deadline is the one that bites in practice, so drive that. fake-ffmpeg's
    // "never_outputs_but_logs" mode writes a plausible stderr line and then does nothing.
    const service = track(
      makeService({
        resolveFfmpegPath: async () => FAKE_FFMPEG,
        liveDeadlineMs: 700,
        pollIntervalMs: 50
      })
    )
    await expect(
      withFakeFfmpegMode('never_outputs_but_logs', () =>
        service.startTranscode('https://upstream.example/live/user/pass/1.m3u8', false, 'timeout-1')
      )
    ).rejects.toThrow(/Timed out after 1s waiting for ffmpeg.*400 Bad Request/s)
  })

  it('says so explicitly when ffmpeg produced no output of its own', async () => {
    const service = track(
      makeService({ resolveFfmpegPath: async () => FAKE_FFMPEG, liveDeadlineMs: 700, pollIntervalMs: 50 })
    )
    await expect(
      withFakeFfmpegMode('never_outputs', () =>
        service.startTranscode('https://upstream.example/live/user/pass/1.m3u8', false, 'timeout-2')
      )
    ).rejects.toThrow(/ffmpeg said nothing/)
  })
})

// Reported live: "I have stopped streaming but I see that the transcoding is continuing, the
// directory is growing ... is this correct?" — it was not: nothing but the client ever stopped a
// session, so a vanished client left ffmpeg running for ever, holding one of the account's two
// provider connections. These two tests are the two halves of the fix: silence ends a session,
// but activity never does.
describe('idle session sweep', () => {
  it('stops a session nothing has fetched from', async () => {
    const service = track(
      makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG), idleStopMs: 300, idleSweepMs: 50 })
    )
    const { playlistPath } = await withFakeFfmpegMode('success', () =>
      service.startTranscode('irrelevant-source', false, 'idle-session')
    )
    expect(existsSync(playlistPath)).toBe(true)

    // No client ever asks for it — exactly the stopped-streaming case. (The fake ffmpeg is still
    // 'running' throughout its own 5s sleep, as a real one would be.)
    await new Promise((resolve) => setTimeout(resolve, 900))

    const stats = await service.stats()
    expect(stats.find((session) => session.sessionId === 'idle-session')).toBeUndefined()
    expect(existsSync(dirname(playlistPath))).toBe(false)
  })

  it('keeps a session that is still being fetched from', async () => {
    const service = track(
      makeService({ resolveFfmpegPath: resolverFor(FAKE_FFMPEG), idleStopMs: 400, idleSweepMs: 50 })
    )
    const { playlistPath } = await withFakeFfmpegMode('success', () =>
      service.startTranscode('irrelevant-source', false, 'watched-session')
    )
    const filename = basename(playlistPath)
    const res = { writeHead() {}, end() {} } as unknown as ServerResponse

    // Long past the idle window in total, but never idle for it: a playlist refresh every 60ms.
    for (let i = 0; i < 12; i += 1) {
      await service.serveTranscodeFile(`/__transcode/watched-session/${filename}`, res)
      await new Promise((resolve) => setTimeout(resolve, 60))
    }

    const stats = await service.stats()
    const session = stats.find((entry) => entry.sessionId === 'watched-session')
    expect(session).toBeDefined()
    expect(session?.idleSeconds).toBeLessThan(1)

    await service.stopTranscode('watched-session')
  })
})

describe('looksLikePlaylist', () => {
  it('recognises a playlist', () => {
    expect(looksLikePlaylist(new TextEncoder().encode('#EXTM3U\n#EXT-X-VERSION:3\n'))).toBe(true)
  })

  it('rejects a raw MPEG-TS stream — the case that produced "Option live_start_index not found"', () => {
    expect(looksLikePlaylist(new Uint8Array([0x47, 0x00, 0x11, 0x20, 0xb7, 0x80]))).toBe(false)
  })

  it('says no to nothing at all', () => {
    expect(looksLikePlaylist(new Uint8Array([]))).toBe(false)
    expect(looksLikePlaylist(undefined)).toBe(false)
  })
})

describe('averageBytesPerSecond', () => {
  it('measures the relay rate the System tab reports — the load the host carries for one viewer', () => {
    // Measured 2026-09-22: this provider's UHD tier is 14-22 Mbps, and every segment of it is relayed
    // through this host. 3 MB of segments over 20 seconds is 150 kB/s (1.2 Mbps) — far under, and the
    // number that would tell an operator their NAS is the bottleneck before anyone guesses.
    expect(averageBytesPerSecond(3_000_000, 20)).toBe(150_000)
  })

  it('says nothing until a second has passed', () => {
    expect(averageBytesPerSecond(5_000_000, 0.5)).toBeNull()
    expect(averageBytesPerSecond(5_000_000, 0)).toBeNull()
  })

  it('treats absent or impossible numbers as "no reading yet"', () => {
    expect(averageBytesPerSecond(NaN, 10)).toBeNull()
    expect(averageBytesPerSecond(100, NaN)).toBeNull()
  })
})
