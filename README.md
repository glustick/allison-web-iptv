# Allison Web IPTV

A self-hosted web service for Xtream Codes/M3U IPTV providers — a browser-based sibling of the
[AllisonIPTV](https://github.com/glustick/iptv-app) desktop app, for personal/household use
(not a public multi-tenant service).

See `EFFORT-ASSESSMENT.md` for the full scoping writeup this project started from.

## Current state (v0.2.0 — Live TV, Movies, and Series all live-verified)

The two most technically risky pieces of the desktop app were already Electron-free and
dependency-injected, so they're ported here essentially unchanged:

- `src/server/lib/proxyServer.ts` — the local HTTP proxy (CORS/relay/`.m3u8` rewriting), copied
  verbatim from the desktop app. Its only Electron-specific dependency (`net.request`, for
  OS-trust-store TLS validation) is swapped for `src/server/lib/nodeUpstreamRequest.ts`, a real
  Node `https`/`http`-backed replacement.
- `src/server/lib/transcodeService.ts` / `ffmpegResolver.ts` — the ffmpeg audio-transcode
  fallback, copied verbatim (no Electron dependency existed here at all), now wired up end to
  end via `/api/transcode/start|stop|probeTracks`.

`src/server/index.ts` wires these into a real running server: the ported proxy listens on an
internal-only port, and a public Express app (serving the built client and a small new API)
relays proxy-shaped requests into it, so the whole thing is reachable through one public port.

`src/client/` is a React + Vite app: a login screen, Live TV/Movies/Series tabs (each a
category sidebar + list), an hls.js-backed player for Live TV, and a native-`<video>` player
for Movies/Series that upgrades to hls.js itself once the audio-codec fallback below kicks in.
`getStreamUrl()` (`src/client/src/lib/xtreamClient.ts`) deliberately returns a same-origin
*relative* path rather than the raw upstream URL the desktop app's own `xtream.ts` returns —
the fix for the CORS risk flagged in `EFFORT-ASSESSMENT.md`, so hls.js's segment/playlist
fetches never leave the browser's own origin.

**The EC-3/E-AC-3 unsupported-audio-codec transcode fallback is ported and confirmed working
live**, not just wired: `src/client/src/lib/transcodeFallback.ts` ports the desktop app's own
detection logic (`isUnsupportedAudioCodecError` for Live TV's hls.js errors, decoded-byte-count
polling for Movies/Series' native `<video>`). Two real bugs were caught fixing this, both found
by actually watching it run against the real account, not just by review:
  1. A real Live TV `levelParsingError` (the same live-playlist-reconciliation bug already
     documented and fixed in the desktop app's own ROADMAP) — fixed the same way, via hls.js's
     `ignorePlaylistParsingErrors`.
  2. A real Movies/Series bug specific to this port: once the fallback swaps in its own HLS
     output, a bare `<video src>` can't parse it at all outside Safari
     (`PipelineStatus::DEMUXER_ERROR_COULD_NOT_PARSE`) — fixed by checking for a `.m3u8` source
     and attaching hls.js in that case, exactly like the desktop app's own `Player.tsx` already
     does for the identical reason.

Also found live: this provider returns an empty `seasons` array from `get_series_info` for at
least one real title while still populating `episodes` by season key — `Series.tsx` now derives
the season list from `episodes`' own keys instead of trusting `seasons` to be populated.

**Live-verified in a real Chrome browser (not Electron) against the real account this project
started from**: logged in; played several real Live TV channels end-to-end, including the
provider's historically EC-3-affected "BBC One HD London"; browsed real Movies and Series
categories (one series category alone had 9,067 titles, which just takes a bit to render, not a
bug); watched a real movie hit the EC-3 issue, fall back, and finish playing through the fixed
hls.js path; and watched a real series episode play through to genuine audio decoding.

**Not yet built** (see `EFFORT-ASSESSMENT.md`'s "Real work"/"New work" sections): per-session
(rather than single-global) connection state, real encryption at rest for stored credentials,
and a real login system beyond the single shared `ACCESS_PASSWORD` placeholder in `/api/login`.
The client is also still intentionally minimal (plain lists, not the desktop app's full
Gantt-chart EPG grid; no track-switching UI for the transcode fallback's own audio/subtitle
options).

**Deliberately cut, not ported** — see the effort assessment for why: the VPN split-tunnel
feature (doesn't fit a shared-server model at all) and the auto-updater (meaningless for a web
app; redeploy instead).

## Running it

```bash
npm install
npm run build:client   # builds src/client into public/ — needed at least once
npm run dev             # tsx watch, for local development
# or
npm run build && npm start
```

For client-only iteration with hot reload, `npm run dev:client` runs Vite's own dev server
separately (proxying API/stream calls to `npm run dev`'s server — see `vite.config.ts`), but
`npm run build:client` is what actually populates `public/` for the plain `npm run dev`/`start`
path above to serve.

Environment variables:

- `PORT` (default `8085`) — the public port.
- `PROXY_INTERNAL_PORT` (default `4001`) — internal-only, do not expose this one.
- `ACCESS_PASSWORD` — required for `/api/login` to accept anything.
- `NODE_EXTRA_CA_CERTS` — only needed on a network with a TLS-inspecting corporate proxy, but
  confirmed live to matter in exactly two separate places on one such network during this
  project's own setup: `npm install` failed fetching `ffmpeg-static`'s binary, and — separately
  — every actual Xtream request at runtime failed with `SELF_SIGNED_CERT_IN_CHAIN` until this
  was set, because Node uses its own bundled CA list rather than the OS trust store the way
  Electron's net module did in the desktop app (see `nodeUpstreamRequest.ts`'s own doc comment).
  Point it at a PEM bundle containing that network's root CA if you hit either error — e.g. on
  macOS: `security find-certificate -a -c "<your CA issuer's name>" -p > ca-bundle.pem`.

## Testing

```bash
npm run typecheck
npm run lint
npm test
```
