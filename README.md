# Allison Web IPTV

A self-hosted web service for Xtream Codes/M3U IPTV providers — a browser-based sibling of the
[AllisonIPTV](https://github.com/glustick/iptv-app) desktop app, for personal/household use
(not a public multi-tenant service).

See `EFFORT-ASSESSMENT.md` for the full scoping writeup this project started from.

## Current state (v0.7.0 — SQLite storage, favourites, history, custom categories)

**v0.7.0** moves everything the app persists into a single **SQLite database** (`allison.db`)
and builds a proper per-user library on top of it: **★ Favourites** and **🕘 History** in the
sidebar, plus **custom categories** you can fill with channels picked from any provider category
(and which live alongside the provider's own categories). All of it is stored server-side under
`/appdata`, so it survives image updates and follows the account rather than the browser. An
existing `users.json` is imported automatically on first start, keeping the original as
`users.json.imported`. **v0.6.6** adds an **EPG section** (view every guide in use — the provider's own plus each
external XMLTV source — with status, channel/programme counts and coverage stats; add/remove
sources; force a refresh) and a **fuzzy matching layer** for the channel→guide join, backed by
caches that keep tens of thousands of channels fast: guide indexes and programme counts are
built once per fetch, the stream→guide mapping is memoised per (account, sources, guide
version), and window lookups binary-search the sorted programme lists. Measured live: 27,807
channels matched in ~610ms (5,076 exact + 145 fuzzy) against a 5,929-channel / 298k-programme
guide. **v0.6.4** fixes transcoding in the Docker image: the bundled ffmpeg-static Linux
binary is a static-glibc build that cannot resolve *any* hostname, so the transcode fallback
(used for E-AC-3/AC-3 audio and HEVC video a browser can't play directly) silently never worked
— playback would start, hit the fallback, and hang. The image now installs Debian's ffmpeg.
**v0.6.3** finishes the hardening started in v0.6.1: `/api/session/save`, `/api/session/clear`,
`/api/session` (load), `/api/connect` and the transcode routes now return readable JSON errors
(they were the last paths that could answer with an opaque HTML 500 — badly timed, since
`/api/session/save` runs the moment you submit IPTV credentials), the transcode routes report
"No IPTV server configured" instead of throwing, and boot warns loudly when `SESSION_SECRET` is
missing or under 16 characters. **v0.6.2** made the first-run admin setup route report the real
cause too. Found live against a real provider (27,807 channels + a 304k-programme guide through
the app's own proxy).

**v0.6.1** hardens the account store's failure paths found during real deployments: a broken
or unreadable `users.json` no longer crashes the server at boot (it now starts, logs the exact
problem, and every auth route answers with a readable JSON error the UI displays verbatim),
login failures on read-only/full data volumes return the real cause instead of an opaque HTML
500, the app shows an explicit error screen with retry when account storage can't be reached,
and the sample `SESSION_SECRET` placeholder was replaced (the old one was, embarrassingly,
shorter than the 16-character minimum the server enforces). Same deployment shape as v0.6.0 —
pull the new image and recreate the stack.

**v0.6.0 — real accounts, roles, and an admin console**

**v0.6.0** replaces the old single shared `ACCESS_PASSWORD` gate with a real account system.
The login screen now asks only for an app username and password; the IPTV provider details
moved to their own step *after* that security check, stored encrypted per account (so each
user keeps their own provider line and extra EPG sources). Two roles — `admin` and `user` —
and a first-run setup screen that creates the initial admin the first time the server starts
with zero accounts. Admins get an in-app console with two panels: **active sessions** (who is
logged in, what they're streaming, login time, session duration, last activity, with a
one-click force sign-out) and **user management** (add/remove users, assign roles). Accounts
persist to a single SQLite database (`allison.db`) under the data directory — `./data/` for a bare
`npm start`, `/appdata/` in Docker (passwords scrypt-hashed, provider credentials AES-256-GCM
encrypted under `SESSION_SECRET`); an existing `users.json` is imported automatically on first
start and kept as `users.json.imported`; sessions expire after 24h of inactivity, kept alive by the player's
activity heartbeat. The old browser-side "saved profiles" system is gone — accounts
replaced it.

**v0.5.1** adds select-and-drag panel resizing, sharing one mechanism across three dividers

**v0.5.1** adds select-and-drag panel resizing, sharing one mechanism across three dividers
(`lib/useResizableDimension.ts`, a pointer-event port of the desktop app's own v0.7.9 hook, so
touch works too): the EPG grid's channel column (90–320px, one full-height handle — rows never
read the width in JS, so react-window re-renders nothing mid-drag), the category sidebar on
all three tabs (160–360px), and a row-resize seam between the Live TV player and the guide
(120px–80vh, default = the old fixed 45vh). Sizes clamp at their bounds and persist to
`localStorage` (the client's first use of it, mirroring the desktop app's own fallback path),
restored on reload. Verified live with synthetic drags: real-time application, clamping at
both bounds, persistence, and restore across a reload + auto-reconnect.

**v0.5.0** moves EPG assembly out of the browser entirely: the server fetches, caches (6h TTL,
stale-while-revalidate, pruned to a rolling 24h-back/72h-forward window), and merges the
provider's `xmltv.php` guide with any extra XMLTV URLs configured on the login form's
"Additional EPG guide URLs" field, joins channels through a wider exact-id → normalized-id →
normalized-name matching layer (`epgMatching.ts`), and serves windowed listings via `/api/epg`
(~4MB JSON per visible 3-hour window instead of ~98MB of XML per browser tab — confirmed live
against the real provider: 5,963 channels / 314,895 programmes parsed, 4,458 streams populated,
22 previously-empty streams gained data from a real external XMLTV source with zero
regressions). `/api/epg/status` reports per-source health, and channels every source has
nothing for show a "No guide data" label instead of an ambiguous blank row. Also in this
release: `LivePlayer.tsx` gained a backgrounding-recovery watchdog (`lib/liveStreamRecovery.ts`)
— a page suspended by backgrounding permanently wedged hls.js's live-refresh chain with no
error and no self-recovery (found live on 2026-09-12); the watchdog now notices a stream that
stopped receiving fragments while starved at its buffer end and restarts it, escalating from
`hls.startLoad()` to a full source reload if needed.

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

**EPG aggregation now happens server-side, with additional sources.** The original design —
every browser tab downloading the provider's ~98MB `xmltv.php` and joining it to channels by
exact `epg_channel_id` string — left real gaps: channels whose id was null or formatted
differently never matched, the guide covered only part of the catalog, and one download per
tab mount was wasteful. The server now assembles the guide instead (`src/server/lib/epgService.ts`
behind `/api/epg`): it fetches and caches the provider guide (6h TTL, stale-while-revalidate,
pruned to a rolling 24h-back/72h-forward window to keep memory sane on a NAS), merges in any
extra XMLTV sources configured on the login form's "Additional EPG guide URLs" field (stored
with the encrypted session profile, max 8), and joins channels to guide entries through a
wider matching layer (`epgMatching.ts`: exact id → normalized id → normalized display-name,
unambiguous matches only). The grid fetches only the programmes overlapping its current 3-hour
window (confirmed live: ~4MB JSON instead of 98MB of XML) and refetches as the window moves;
`/api/epg/status` reports per-source health. Confirmed live against the real provider plus a
real external XMLTV source: 5,963 provider channels / 314,895 programmes parsed, 4,458 streams
populated in the current window, and 22 previously-empty streams gained data from the external
source with zero regressions. Channels every source has nothing for now show a faint "No guide
data" label instead of an ambiguous blank row.

**Live-verified in a real Chrome browser (not Electron)**: manual login → saved credentials →
full page reload → automatic reconnect with zero interaction; the EPG grid rendering real
channel icons, real programme titles ("Countdown", "Billions", "Will & Grace", ...), and a
correctly-positioned "now" line, within ~10 seconds of opening Live TV.

**Not yet built** (see `EFFORT-ASSESSMENT.md`'s "Real work"/"New work" sections): no
track-switching UI yet for the transcode fallback's own audio/subtitle options. (The per-session
connection state, encrypted credentials at rest, and the multi-user login system listed here in
earlier versions have all shipped — v0.5.0's encrypted per-session store and v0.6.0's account
system cover them.)

**Deliberately cut, not ported** — see the effort assessment for why: the VPN split-tunnel
feature (doesn't fit a shared-server model at all) and the auto-updater (meaningless for a web
app; redeploy instead).

## User accounts & admin console

Authentication now happens in two stages:

1. **App login** — a username and password checked against the server's own accounts. First
   launch (zero accounts on file) shows a setup screen that creates the initial **admin**;
   every account after that is created from the admin panel.
2. **IPTV config** — right after login, the app checks the account's saved provider config
   (server URL, IPTV username/password, extra EPG URLs) and auto-connects; accounts without
   one get a short form instead. Provider credentials are stored AES-256-GCM encrypted per
   account, never in plaintext. All of this variable state (accounts, passwords, IPTV data)
   lives in one file — `users.json` under `DATA_DIR` — which the Docker image expects at
   `/appdata` and the provided compose file maps to `./appdata` on the host, read-write, so
   container/image updates keep it.

Roles are `admin` and `user`. Admins get an extra **Admin** tab with:

- **Active sessions** — every logged-in user, their role, login time, live session duration,
  what they're currently streaming (title + live/movie/series tag), and last activity — with a
  per-session force sign-out. Data comes from the client's activity heartbeat (~15s while
  something is playing).
- **User management** — add users (username, password, role) and remove them. The last
  remaining admin can't be deleted, and you can't delete the account you're logged in with.

Logins expire after 24 hours without any request (`AUTH_IDLE_TTL_HOURS`); actively watching
keeps the session alive automatically. Removing a user immediately terminates their sessions.

## Your library: favourites, history and custom categories

All three live in the sidebar and are stored per account in the database:

- **★ Favourites** — the star in the now-playing bar toggles the channel you're watching; the
  entry shows up instantly at the top of the sidebar.
- **🕘 History** — every channel you start watching is recorded (name and category are stored
  with it, so history still makes sense if the provider renumbers). Bounded at 500 entries per
  account, with a Clear button.
- **Custom categories** — **＋ New category** creates one, then **Add channels** opens a picker
  where you filter by any provider category and tick the channels you want. Channels can sit in
  as many custom categories as you like; **Rename**/**Delete** are in the same toolbar, and
  deleting a category never removes the underlying channel.

Everything here is per user: two accounts on the same server keep separate favourites, history
and categories.

## EPG & guide matching

The **EPG** tab shows every guide an account uses and how well they cover its channel list:

- the provider's own guide (built in, from the IPTV provider) and each external XMLTV source,
  with `ready` / `loading` / `error` status, guide-channel and programme counts, and last fetch
- add or remove external sources (validated, de-duplicated, up to 8) — saved to the account
  without touching the provider credentials; **Refresh guides** forces a re-fetch
- coverage stats: channels with guide data, and how many matched exactly versus fuzzily

Matching runs in widening steps, each strictly weaker than the last:

| Step | Example |
| --- | --- |
| exact `epg_channel_id` | guide id equals the stream's id |
| normalized id | differs by case/whitespace/formatting |
| exact display name | `Sky News HD` → `Sky News` |
| fuzzy name (scored) | `Sky Sports 1` → `Sky Sports One`; `BBC ONE Lon` → `BBC One London` |

Fuzzy matches are scored with token-set similarity (number words folded, packaging noise like
`HD`/`TV`/`Channel` dropped, prefix abbreviations credited — never for digit tokens) and are
accepted only above a threshold **and** by a margin over the runner-up, so an ambiguous name
yields no match rather than a coin flip. Provider data always wins; external sources fill
channels the provider has nothing for, in the order configured.

Performance, for accounts with tens of thousands of streams: indexes are built once per fetched
guide, programme counts computed once, the stream→guide mapping is memoised per (account,
sources, guide version), and window lookups binary-search the parser's sorted programme lists —
a full build of 27,807 channels takes ~0.6s, and grid navigation afterwards only re-runs the
cheap window filter.

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
- `SESSION_SECRET` — required; encrypts the per-account IPTV credentials at rest. Use a 16+ character random secret, ideally from a secret manager or `.env` file.
- `DATA_DIR` (default `./data`; `/appdata` in the Docker image) — where `allison.db` lives:
  accounts, the per-user library (favourites, watch history, custom categories), and encrypted
  per-user IPTV credentials. In Docker this must sit on the persistent `./appdata:/appdata:rw`
  volume so image updates don't wipe it.
- `AUTH_IDLE_TTL_HOURS` (default `24`) — how long a login survives with no requests; active streaming keeps it alive via the client's activity heartbeat.
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

The image also installs Debian's own `ffmpeg` (~400MB): the bundled `ffmpeg-static` Linux binary
is a *static glibc* build, and static glibc binaries cannot use NSS — so it fails to resolve
**any** hostname at runtime (`Failed to resolve hostname … System error`) and transcoding (the
automatic fallback for E-AC-3/AC-3 audio or HEVC video) never worked without it. The server's
`ffmpegResolver` already prefers a working system ffmpeg, and logs which one it picked at boot
(`[transcode] using system ffmpeg: /usr/bin/ffmpeg`).

```bash
docker pull ghcr.io/glustick/allison-web-iptv:latest
docker run -d --name allison-web-iptv \
  -p 8085:8085 \
  -e SESSION_SECRET=<16+ character random secret> \
  -v ./appdata:/appdata:rw \
  ghcr.io/glustick/allison-web-iptv:latest
```

Or with the provided `docker-compose.yml` (set a real `SESSION_SECRET` first — it already maps
`./appdata:/appdata:rw`, which is what keeps accounts and IPTV config across image updates):

```bash
docker compose up -d
```

### Stack deployment (Dockhand, Portainer, Synology Container Manager, …)

The complete stack, copy-paste ready. **The only line that must be edited is `SESSION_SECRET`:**

```yaml
services:
  allison-web-iptv:
    image: ghcr.io/glustick/allison-web-iptv:v0.6.3
    restart: unless-stopped
    ports:
      - "8085:8085"
    environment:
      - PORT=8085
      # REQUIRED. Must be 16+ characters. Generate one:  openssl rand -hex 24
      # Replace the value below with that output. It encrypts your stored IPTV credentials —
      # set it once and keep it stable across updates.
      - SESSION_SECRET=REPLACE_WITH_YOUR_OWN_SECRET
      # All variable/persistent state (accounts, hashed passwords, encrypted IPTV config)
      # lives under /appdata in the container.
      - DATA_DIR=/appdata
    volumes:
      # Persistent, read-write — keeps accounts and IPTV config across image/stack updates.
      - ./appdata:/appdata:rw
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8085)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      start_period: 15s
      retries: 3
```

Apply it by pasting the above into your stack manager and deploying, or from a CLI:

```bash
docker compose up -d --force-recreate
```

Notes on the three environment variables and the parts that matter:

- **`SESSION_SECRET`** — required, 16+ characters, generate with `openssl rand -hex 24`.
  It encrypts every account's stored IPTV provider credentials (AES-256-GCM) and **must stay
  the same across updates**; if it changes, the app treats the stored IPTV config as unset and
  you re-enter it (account logins are unaffected — those are scrypt-hashed, not key-dependent).
  A missing or too-short value is reported at startup and whenever IPTV config is saved.
- **`DATA_DIR=/appdata`** — where `users.json` (accounts, hashed passwords, encrypted IPTV
  config) lives inside the container.
- **`./appdata:/appdata:rw`** — the persistent volume mapping. This is what makes a Docker or
  stack update keep your accounts and IPTV config; without it, every update would land you back
  on the first-run admin setup screen. Keep it read-write.
- **`healthcheck`** — polls the app's own `/api/health`; stack UIs (Dockhand included) surface
  this as the container's health status.
- **`image:`** — pinned to `v0.6.3` here for reproducibility; use
  `ghcr.io/glustick/allison-web-iptv:latest` if you'd rather your update flow track new releases.

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
   with your own fork's path if you're building from a fork, and set a real `SESSION_SECRET`. Keep the
   `./appdata:/appdata:rw` volume mapping — accounts and IPTV config live there, so a Container
   Manager update/rebuild won't wipe them.
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
