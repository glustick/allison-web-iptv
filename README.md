# Allison Web IPTV

A self-hosted web service for Xtream Codes/M3U IPTV providers — a browser-based sibling of the
[AllisonIPTV](https://github.com/glustick/iptv-app) desktop app, for personal/household use
(not a public multi-tenant service).

See `EFFORT-ASSESSMENT.md` for the full scoping writeup this project started from.

## Current state (v0.1.0 — server skeleton only)

The two most technically risky pieces of the desktop app were already Electron-free and
dependency-injected, so they're ported here essentially unchanged:

- `src/server/lib/proxyServer.ts` — the local HTTP proxy (CORS/relay/`.m3u8` rewriting), copied
  verbatim from the desktop app. Its only Electron-specific dependency (`net.request`, for
  OS-trust-store TLS validation) is swapped for `src/server/lib/nodeUpstreamRequest.ts`, a real
  Node `https`/`http`-backed replacement.
- `src/server/lib/transcodeService.ts` / `ffmpegResolver.ts` — the ffmpeg audio-transcode
  fallback, copied verbatim (no Electron dependency existed here at all).

`src/server/index.ts` wires these into a real running server: the ported proxy listens on an
internal-only port, and a public Express app (serving a static client and a small new API)
relays proxy-shaped requests into it, so the whole thing is reachable through one public port.

**Not yet built** (see `EFFORT-ASSESSMENT.md`'s "Real work"/"New work" sections): the actual
browser client (porting the desktop app's React UI and its ~48 `window.api` call sites onto
this API instead), per-session (rather than single-global) connection state, real encryption
at rest for stored credentials, and a real login system beyond the single shared
`ACCESS_PASSWORD` placeholder in `/api/login`.

**Deliberately cut, not ported** — see the effort assessment for why: the VPN split-tunnel
feature (doesn't fit a shared-server model at all) and the auto-updater (meaningless for a web
app; redeploy instead).

## Running it

```bash
npm install
npm run dev      # tsx watch, for local development
# or
npm run build && npm start
```

Environment variables:

- `PORT` (default `8080`) — the public port.
- `PROXY_INTERNAL_PORT` (default `4001`) — internal-only, do not expose this one.
- `ACCESS_PASSWORD` — required for `/api/login` to accept anything.
- `NODE_EXTRA_CA_CERTS` — only needed on a network with a TLS-inspecting corporate proxy
  (confirmed live during this project's own setup: `npm install` failed with
  `SELF_SIGNED_CERT_IN_CHAIN` fetching `ffmpeg-static`'s binary, because Node uses its own
  bundled CA list rather than the OS trust store the way Electron's net module did in the
  desktop app — see `nodeUpstreamRequest.ts`'s own doc comment for the same caveat applied to
  every proxied request at runtime, not just this one install-time download). Point it at a PEM
  bundle containing that network's root CA if you hit the same error.

## Testing

```bash
npm run typecheck
npm run lint
npm test
```
