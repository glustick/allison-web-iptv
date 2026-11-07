#!/usr/bin/env node
// A fake Xtream panel, so the app's UI can be exercised without a real account.
//
// The gap this closes: every UI feature in this repo has been checked against a running app with
// *no provider*, which means the channel list, the guide, reminders, favourites and search have
// only ever been verified by typecheck and unit tests. This serves the handful of endpoints the
// app actually calls — player_api.php plus HLS media — with a real, playable stream, so a browser
// can be driven through the real screens.
//
// It is a fixture, not an emulator: channels, categories and a two-hour schedule are fixed, and any
// username/password is accepted. Never point it at a real deployment.
//
//   node scripts/fixture-provider.mjs            # http://127.0.0.1:8091, user/pass demo/demo
//   PORT=9001 node scripts/fixture-provider.mjs
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.PORT ?? 8091)
const HERE = dirname(fileURLToPath(import.meta.url))
const FFMPEG = process.env.FFMPEG ?? join(HERE, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg')

const USER = process.env.FIXTURE_USER ?? 'demo'
const PASS = process.env.FIXTURE_PASS ?? 'demo'

// ---- media: one 12s HLS stream, generated once, served for every channel ----------------
const mediaDir = mkdtempSync(join(tmpdir(), 'fixture-hls-'))
if (!existsSync(FFMPEG)) {
  console.error(`fixture-provider: no ffmpeg at ${FFMPEG} — set FFMPEG or run npm install`)
  process.exit(1)
}
execFileSync(FFMPEG, [
  '-y', '-f', 'lavfi', '-i', 'color=c=0x1b2b44:s=640x360:d=12',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '48', '-keyint_min', '48',
  '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '96k',
  '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
  '-hls_segment_filename', join(mediaDir, 'seg%03d.ts'), join(mediaDir, 'index.m3u8'),
  '-loglevel', 'error'
])

// A single 60s MP4, served for every film and episode: the VOD player takes a direct file.
const vodFile = join(mediaDir, 'vod.mp4')
execFileSync(FFMPEG, [
  '-y', '-f', 'lavfi', '-i', 'color=c=0x2a1b44:s=640x360:d=60',
  '-f', 'lavfi', '-i', 'sine=frequency=330:duration=60',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k',
  vodFile, '-loglevel', 'error'
])

// ---- catalogue --------------------------------------------------------------------------
const now = Date.now()
const HALF_HOUR = 30 * 60_000
const slot = Math.floor(now / HALF_HOUR) * HALF_HOUR

const categories = [
  { category_id: '1', category_name: 'News', parent_id: 0 },
  { category_id: '2', category_name: 'Sport', parent_id: 0 }
]

const channels = [
  { stream_id: 101, name: 'Fixture News One', category_id: '1', num: 1 },
  { stream_id: 102, name: 'Fixture News Two', category_id: '1', num: 2 },
  { stream_id: 201, name: 'Fixture Sports One', category_id: '2', num: 3 },
  { stream_id: 202, name: 'Fixture Sports Two', category_id: '2', num: 4 }
].map((channel) => ({
  ...channel,
  stream_type: 'live',
  stream_icon: '',
  epg_channel_id: `fixture-${channel.stream_id}`,
  added: '1700000000',
  is_adult: '0'
}))

const films = [
  { stream_id: 301, name: 'Fixture Film Alpha', category_id: '10', added: '1794000000', year: '2024' },
  { stream_id: 302, name: 'Fixture Film bravo', category_id: '10', added: '1791000000', year: '2022' },
  { stream_id: 303, name: 'Fixture Film Charlie', category_id: '10', added: '1780000000', year: '2019' }
].map((film, index) => ({
  num: index + 1,
  name: film.name,
  stream_type: 'movie',
  stream_id: film.stream_id,
  stream_icon: '',
  rating: '7.5',
  rating_5based: 3.8,
  added: film.added,
  category_id: film.category_id,
  container_extension: 'mp4',
  direct_source: ''
}))

const seriesCatalogue = [
  {
    num: 1,
    name: 'Fixture Series One',
    series_id: 401,
    cover: '',
    plot: 'A fixture series.',
    cast: '',
    director: '',
    genre: 'Drama',
    releaseDate: '2023-04-01',
    rating: '8.0',
    category_id: '20'
  }
]

const seriesEpisodes = {
  '1': [
    { id: '4011', episode_num: 1, title: 'Fixture S01E01', container_extension: 'mp4', season: 1, info: {} },
    { id: '4012', episode_num: 2, title: 'Fixture S01E02', container_extension: 'mp4', season: 1, info: {} }
  ],
  '2': [
    { id: '4021', episode_num: 1, title: 'Fixture S02E01', container_extension: 'mp4', season: 2, info: {} },
    { id: '4022', episode_num: 2, title: 'Fixture S02E02', container_extension: 'mp4', season: 2, info: {} }
  ]
}

const titles = {
  101: ['Morning Briefing', 'World at Noon', 'The Long Read', 'Evening Bulletin'],
  102: ['Headlines', 'Market Watch', 'Interview Hour', 'Late Desk'],
  201: ['Matchday Build-up', 'Live: Fixture United', 'Post-match', 'Classic Rewind'],
  202: ['Training Day', 'Live: Fixture Rovers', 'The Analysis', 'Overtime']
}

function epgFor(streamId) {
  const list = titles[streamId] ?? titles[101]
  return list.map((title, index) => {
    const start = slot + (index - 1) * HALF_HOUR
    return {
      id: String(streamId * 100 + index),
      epg_id: `fixture-${streamId}`,
      title,
      lang: 'en',
      start: new Date(start).toISOString().slice(0, 19).replace('T', ' '),
      end: new Date(start + HALF_HOUR).toISOString().slice(0, 19).replace('T', ' '),
      description: `Fixture programme: ${title}`,
      channel_id: `fixture-${streamId}`,
      start_timestamp: String(Math.floor(start / 1000)),
      stop_timestamp: String(Math.floor((start + HALF_HOUR) / 1000)),
      now_playing: start <= now && now < start + HALF_HOUR ? 1 : 0,
      has_archive: 1
    }
  })
}

function playerApi(action, params) {
  switch (action) {
    case 'get_live_categories':
      return categories
    case 'get_live_streams':
      return params.category_id ? channels.filter((c) => c.category_id === params.category_id) : channels
    case 'get_short_epg':
      return { epg_listings: epgFor(Number(params.stream_id ?? 101)) }
    case 'get_vod_categories':
      return [{ category_id: '10', category_name: 'Films', parent_id: 0 }]
    case 'get_series_categories':
      return [{ category_id: '20', category_name: 'Drama', parent_id: 0 }]
    case 'get_vod_streams':
      return params.category_id ? films.filter((film) => film.category_id === params.category_id) : films
    case 'get_series':
      return seriesCatalogue
    case 'get_series_info':
      return {
        seasons: [
          { season_number: 1, name: 'Season 1', cover: '' },
          { season_number: 2, name: 'Season 2', cover: '' }
        ],
        episodes: seriesEpisodes,
        info: { name: 'Fixture Series One', plot: 'A fixture series.' }
      }
    case 'get_vod_info':
      return { info: { name: 'Fixture Film', plot: 'A fixture film.' }, movie_data: films[0] }
    default:
      return {}
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const action = url.searchParams.get('action') ?? ''

  if (url.pathname === '/player_api.php') {
    const body = action
      ? playerApi(action, Object.fromEntries(url.searchParams))
      : {
          user_info: { username: url.searchParams.get('username'), auth: 1, status: 'Active', max_connections: '2', exp_date: null },
          server_info: { url: `127.0.0.1:${PORT}`, port: String(PORT), https_port: '', server_protocol: 'http' }
        }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }

  if (url.pathname.startsWith('/movie/') || url.pathname.startsWith('/series/')) {
    // Films and episodes are one direct file, whatever id was asked for — served with **byte
    // ranges**, because a browser cannot seek a progressive MP4 without them: without a 206 the
    // playhead snaps back to zero on every seek, which looks exactly like a player bug.
    const body = readFileSync(vodFile)
    const range = req.headers.range
    const match = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
    if (match) {
      const start = match[1] ? Number(match[1]) : 0
      const end = match[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1
      if (start >= body.length || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${body.length}` })
        res.end()
        return
      }
      const slice = body.subarray(start, end + 1)
      res.writeHead(206, {
        'content-type': 'video/mp4',
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${body.length}`,
        'content-length': String(slice.length)
      })
      res.end(slice)
      return
    }
    res.writeHead(200, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': String(body.length) })
    res.end(body)
    return
  }

  if (url.pathname.startsWith('/live/')) {
    const file = url.pathname.split('/').pop() ?? ''
    // Every channel answers with the same playlist; the segments it names are served by basename.
    const local = file.endsWith('.m3u8') ? join(mediaDir, 'index.m3u8') : join(mediaDir, file)
    if (!existsSync(local)) {
      res.writeHead(404).end()
      return
    }
    const type = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t'
    res.writeHead(200, { 'content-type': type })
    res.end(readFileSync(local))
    return
  }

  if (url.pathname === '/xmltv.php') {
    // Two hours of guide for every channel, so the aggregate path has something to show.
    const programmes = channels
      .flatMap((channel) =>
        epgFor(channel.stream_id).map(
          (entry) =>
            `<programme start="${entry.start.replace(/[-: ]/g, '').replace(' ', '')} +0000" stop="${entry.end
              .replace(/[-: ]/g, '')
              .replace(' ', '')} +0000" channel="fixture-${channel.stream_id}"><title>${entry.title}</title><desc>${entry.description}</desc></programme>`
        )
      )
      .join('\n')
    const xml = `<?xml version="1.0" encoding="UTF-8"?><tv>${channels
      .map((channel) => `<channel id="fixture-${channel.stream_id}"><display-name>${channel.name}</display-name></channel>`)
      .join('')}${programmes}</tv>`
    res.writeHead(200, { 'content-type': 'application/xml' })
    res.end(xml)
    return
  }

  res.writeHead(404).end()
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `fixture-provider: http://127.0.0.1:${PORT} — ${channels.length} channels, ${films.length} films, ${seriesCatalogue.length} series (user ${USER}, pass ${PASS})`
  )
})
