# Allison Web IPTV

A self-hosted web service for Xtream Codes/M3U IPTV providers — a browser-based sibling of the
[AllisonIPTV](https://github.com/glustick/iptv-app) desktop app, for personal/household use
(not a public multi-tenant service).

See `EFFORT-ASSESSMENT.md` for the full scoping writeup this project started from.

## Current state (v0.1.0 — first working end-to-end slice)

The two most technically risky pieces of the desktop app were already Electron-free and
dependency-injected, so they're ported here essentially unchanged:

- `src/server/lib/proxyServer.ts` — the local HTTP proxy (CORS/relay/`.m3u8` rewriting), copied
  verbatim from the desktop app. Its only Electron-specific dependency (`net.request`, for
  OS-trust-store TLS validation) is swapped for `src/server/lib/nodeUpstreamRequest.ts`, a real
  Node `https`/`http`-backed replacement.
- `src/server/lib/transcodeService.ts` / `ffmpegResolver.ts` — the ffmpeg audio-transcode
  fallback, copied verbatim (no Electron dependency existed here at all).

`src/server/index.ts` wires these into a real running server: the ported proxy listens on an
internal-only port, and a public Express app (serving the built client and a small new API)
relays proxy-shaped requests into it, so the whole thing is reachable through one public port.

`src/client/` is a small React + Vite app: a login screen (access password + Xtream
credentials), a category/channel list, and an hls.js-backed `<video>` player. Its
`getStreamUrl()` (`src/client/src/lib/xtreamClient.ts`) deliberately returns a same-origin
*relative* path rather than the raw upstream URL the desktop app's own `xtream.ts` returns —
that's the fix for the CORS risk flagged in `EFFORT-ASSESSMENT.md`, and it means hls.js's
segment/playlist fetches never actually leave the browser's own origin.

**Live-verified in a real Chrome browser (not Electron)** against the real account this project
started from: logged in, browsed real categories (228 of them) and channels, and played a real
channel end-to-end (`currentTime` advancing, `readyState: 4`). One channel hit the desktop
app's own long-documented EC-3/E-AC-3 unsupported-audio-codec issue (`fragParsingError`) —
expected, since the transcode-fallback service was ported server-side but the client doesn't
wire up `/__transcode/` yet to use it.

**Not yet built** (see `EFFORT-ASSESSMENT.md`'s "Real work"/"New work" sections): the
transcode-fallback client wiring just mentioned, per-session (rather than single-global)
connection state, real encryption at rest for stored credentials, and a real login system
beyond the single shared `ACCESS_PASSWORD` placeholder in `/api/login`. The client itself is
also intentionally minimal (a plain list, not the desktop app's full Gantt-chart EPG grid).

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

- `PORT` (default `8080`) — the public port.
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
