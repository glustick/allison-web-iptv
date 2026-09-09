# Allison Web IPTV

A self-hosted web service for Xtream Codes/M3U IPTV providers — a browser-based sibling of the
[AllisonIPTV](https://github.com/glustick/iptv-app) desktop app, for personal/household use
(not a public multi-tenant service).

See `EFFORT-ASSESSMENT.md` for the full scoping writeup this project started from.

## Current state (v0.4.2 — fix for a silent, unrecoverable playback stall)

**v0.4.2** fixes a second, distinct freeze reported live after v0.4.1 shipped: Live TV playing
briefly, then a permanent buffering spinner, a stuck/bogus playback time, and — critically — no
error in the console at all, meaning the v0.4.1 hls.js-error-recovery fix could never have
engaged in the first place. Root cause: once `proxyServer.ts` receives upstream response
headers, it clears its own timeout and never watches the connection again — a live-playlist/
segment fetch whose connection goes completely silent mid-body (never closes, just stops
sending bytes) hung the piped response to the browser forever, with nothing to ever error or
close it. Confirmed via a byte-identical diff against the desktop app's own copy of
`proxyServer.ts` that the gap is specific to `src/server/lib/nodeUpstreamRequest.ts` (the
deliberate Node-vs-Electron swap point), not the shared proxy logic — Electron's net module
apparently already guards against this. Fixed there with a 20s inactivity watchdog on the
upstream response body that force-ends the client-facing response once a connection stalls,
giving hls.js a real failure to react to instead of hanging indefinitely with no signal.

**v0.4.1** ports the desktop app's own hls.js fatal-error recovery into the web Live TV player
(`src/client/src/components/LivePlayer.tsx`), fixing a reported web-only playback freeze that
required a full browser refresh to clear — the player previously stalled on any fatal hls.js
error instead of retrying. Also adds a real Docker `HEALTHCHECK` against the existing
`/api/health` endpoint (declared in both the `Dockerfile` and `docker-compose.yml`, for stack
UIs that read one or the other) and logs the running version on server startup so a deployed
container's release can be confirmed straight from its logs.

**v0.4.0** added Docker packaging, published to GHCR.

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

**Auto-login, at explicit request.** `LoginScreen.tsx` now saves the full login (access
password + Xtream server/username/password, not just server/username) to `localStorage` after
a successful connect, and auto-attempts it on every subsequent load — falling back to the
plain form (pre-filled) if that fails, e.g. a changed password or an unreachable provider,
rather than getting stuck silently retrying. A "Forget saved login" link clears it. Worth
knowing: this means the Xtream password sits in the browser's local storage in plaintext —
a reasonable tradeoff for this project's personal/self-hosted scope (see
`EFFORT-ASSESSMENT.md`), not something to carry forward if this ever became a real multi-user
service.

**A real Gantt-chart EPG grid, ported from the desktop app's own `EpgGrid.tsx`** — channels
down the vertical axis (virtualized via `react-window`, so it stays workable against a
catalog with thousands of channels), programme blocks positioned by actual start/end time
across a scrollable 3-hour window, a live "now" indicator line, and Now/◀/▶ navigation.
Deliberately left out of this pass (see the desktop app's own fuller version for comparison):
drag-to-pan the timeline, a resizable channel column, keyboard navigation, and catch-up/
timeshift playback for past programmes.

Getting real programme data working took two real fixes, both found live against the actual
account, not by review:
  - `get_short_epg` (the per-channel action the desktop app's own `xtream.ts` uses) turned out
    to return an empty `epg_listings` array for *every* channel tried on this provider,
    including ones with a real `epg_channel_id` mapping — while the *full* `xmltv.php` guide,
    fetched once (confirmed live: ~98MB of real XML), had genuine data throughout. `lib/epg.ts`
    ports the desktop app's own XMLTV parser as the primary source, with the per-channel queue
    kept as a fallback for a channel the full guide has nothing for (or if the full guide
    itself fails to load — some providers block *that* instead, per the desktop app's own
    history) — so this now tolerates either kind of provider limitation.
  - The real API also wraps `get_short_epg`'s response as `{ epg_listings: [...] }`, not a bare
    array, and encodes titles/descriptions in base64 — neither was handled in this client's own
    `xtreamClient.ts` (the desktop app's `xtream.ts` already does both), which crashed the
    entire React tree the first time real EPG data was involved at all
    (`(d ?? []).filter is not a function`) with nothing but a blank page to show for it. Fixed,
    and a top-level `ErrorBoundary` was added afterward so the *next* uncaught bug shows a real
    error instead of a silent blank page.

**Live-verified in a real Chrome browser (not Electron)**: manual login → saved credentials →
full page reload → automatic reconnect with zero interaction; the EPG grid rendering real
channel icons, real programme titles ("Countdown", "Billions", "Will & Grace", ...), and a
correctly-positioned "now" line, within ~10 seconds of opening Live TV.

**Not yet built** (see `EFFORT-ASSESSMENT.md`'s "Real work"/"New work" sections): per-session
(rather than single-global) connection state, real encryption at rest for stored credentials
beyond the browser-local auto-login above, and a real multi-user login system beyond the
single shared `ACCESS_PASSWORD` placeholder in `/api/login`. No track-switching UI yet for the
transcode fallback's own audio/subtitle options.

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

## Running it via Docker

A multi-arch image (`linux/amd64` + `linux/arm64`) is built and published to GitHub Container
Registry automatically by `.github/workflows/docker.yml` on every push to `main` and on version
tags — `linux/arm64` specifically because a NAS (see the Synology section below) is very often
ARM-based, not Intel/AMD. The `Dockerfile` deliberately uses a Debian ("bookworm-slim"), not
Alpine, base image: `ffmpeg-static`'s prebuilt binaries are linked against glibc, and running
them on Alpine's musl libc is a common, easy-to-hit way for the bundled ffmpeg to silently fail
to execute at all.

```bash
docker pull ghcr.io/glustick/allison-web-iptv:latest
docker run -d --name allison-web-iptv \
  -p 8085:8085 \
  -e ACCESS_PASSWORD=changeme \
  ghcr.io/glustick/allison-web-iptv:latest
```

Or with the provided `docker-compose.yml` (edit `ACCESS_PASSWORD` first):

```bash
docker compose up -d
```

If your network does TLS inspection (see `NODE_EXTRA_CA_CERTS` above), mount your CA bundle
into the container and set that same environment variable to point at it — `docker-compose.yml`
has the relevant lines commented out, ready to uncomment.

Building the image yourself instead of pulling: `docker build -t allison-web-iptv .` (single-
platform, whatever `docker build` is running on) or `docker buildx build --platform
linux/amd64,linux/arm64 -t allison-web-iptv .` for both, same as CI does.

## Deploying on a Synology NAS

Confirmed compatible (not yet confirmed *deployed* — see the effort assessment for the caveats
this carries as a genuinely personal/self-hosted project): `ffmpeg-static` ships binaries for
Linux `x64`, `arm64`, and `arm`, covering both Intel/AMD and ARM-based Synology models, and
`ffmpegResolver.ts` already prefers a system-installed ffmpeg first — many Synology models
already have one bundled for Video Station/Surveillance Station transcoding, so the container
may not even need its own bundled copy at runtime.

**Requires DSM 7.2+ with Container Manager** (the renamed, current version of the older Docker
package — the same steps apply there under the name "Docker" instead).

1. Open **Container Manager → Registry**, search for `glustick/allison-web-iptv`, or skip
   straight to step 2 and let Container Manager pull it by full name.
2. Open **Container Manager → Project → Create**.
3. Give it a name, pick a shared folder for it (any empty one is fine — this app doesn't need
   persistent storage), and choose **Create docker-compose.yml**.
4. Paste in this repo's `docker-compose.yml` content, replacing `image: ghcr.io/glustick/...`
   with your own fork's path if you're building from a fork, and set a real `ACCESS_PASSWORD`.
5. Build and run the project. Container Manager will pull the correct architecture's image
   automatically — that's the whole point of the multi-arch build above.
6. Visit `http://<your-nas-ip>:8085` once it's up.

For a cleaner URL and HTTPS instead of a bare IP:port, Synology's own **Control Panel → Login
Portal → Advanced → Reverse Proxy** can front this on a real hostname (e.g.
`iptv.your-nas.local`) with a Let's Encrypt certificate — point it at `localhost:8085` (or
whatever port you mapped) the same way you would for any other self-hosted service on the NAS.

## Testing

```bash
npm run typecheck
npm run lint
npm test
```
