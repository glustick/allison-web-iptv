# Roadmap

Recommended enhancements for future development, refreshed **2026-09-17 against v0.34.1**.
Grouped by theme rather than a strict backlog — pick based on what matters most to whoever
picks this up next. See `README.md` for the full current state and `EFFORT-ASSESSMENT.md` for
the original scoping writeup this project started from.

## Current release

**v0.34.1 — "Every channel type plays."** Fourteen releases (v0.24.0–v0.34.1) that began with a report of
*"the catchup is not playing"* and ended with every playback route confirmed on a real deployment:

- **v0.24.0/v0.25.0** — the `randomUUID` crash (a secure-context-only API, so any transcode over the
  plain-HTTP LAN address replaced the whole app with "Something went wrong"), and catch-up's rolling
  playlist window, which deleted segments before the player could ask for them.
- **v0.26.0** — tell a fronting nginx not to buffer relayed media.
- **v0.27.0** — **the CSP `worker-src` fix.** hls.js runs its demuxer in a `blob:` worker; with no
  directive for it the browser refused the worker, hls.js never started, and every stream it handled
  hung with one console line and no other symptom. This was the root cause of the evening's failures.
- **v0.28.0–v0.30.0** — catch-up could never play: the transcode effect's cleanup stopped the session
  it had just started, its dependencies were objects plus the session client (so any re-render restarted
  it — measured at a new session every 12 seconds), and the fallback hook then "converted" the
  transcoder's own output in a second loop.
- **v0.31.0/v0.31.1** — a silent provider now answers 504 with a sentence, and the deploy's image prune
  can no longer hold the script open for ~42 minutes after a successful deploy.
- **v0.32.0/v0.34.1** — **channels served as raw MPEG-TS play.** The client sniffs the first bytes
  (`0x47`) and routes TS through the transcoder; the transcode hint then must *play* the result rather
  than re-entering the branch that started it.
- **v0.33.0/v0.33.1** — live segments come **through the app**: no provider credentials in the browser,
  no dependence on the CDN accepting the viewer's address, no racing a ~25-second signed URL. A raw-TS
  response is piped through rather than buffered into silence.
- **v0.34.0** — **E-AC-3-first channels play on Safari.** The silent-audio fallback only ever worked in
  Chromium; the client now probes the stream's tracks and decides before playing.

### The stretch before it (v0.23.0 and back)

**v0.23.0 — "Catch-up you can actually watch, and watchdogs that speak up."** Ten releases
(v0.14.0–v0.23.0) that turned the guide into the app's primary surface and gave the deployment a
voice when things break:

- **v0.14.0/v0.14.1** — a Favourites-only Guide/List toggle, and a notice when a deploy ended your
  session.
- **v0.15.0** — the **provider watchdog**: a signed-streak state machine (two agreeing checks before
  it calls an outage) posting to a **Discord webhook** on down and up, naming the host and the
  provider's own error but never the account. The webhook is stored encrypted with the provider
  credentials and never reaches the browser.
- **v0.16.0** — **EPG, Admin and System open in their own tab** as real links (`?tab=admin` deep
  links work), because configuring the app in the same tab unmounts the player and stops playback.
- **v0.17.0** — **catch-up playback**, the roadmap's highest-value gap. Selecting a finished
  programme replays it from the provider's archive, through `/api/timeshift/<id>.ts?start=&duration=`,
  with the credentials still server-side. It also exposed a real bug: the guide had captured the
  pointer on every press since v0.12.0, and pointer capture retargets compatibility mouse events — so
  **every click on a programme had silently done nothing for two releases**.
- **v0.18.0** — **catch-up works in Safari**. A timeshift stream is raw MPEG-TS: hls.js cannot parse
  it and Safari cannot decode it, so the bar showed catch-up while nothing played. The browser is now
  handed the transcoder's own HLS output, the same machinery the E-AC-3 fallback uses.
- **v0.19.0 / v0.20.0** — **keyboard navigation** for the guide (arrows pan a quarter hour and scroll
  a row, Home returns to now, ↑/↓ walks focus to the same column in the adjacent row), **series
  favourites**, and a sign-in **audit trail** (ok / failed / locked / logout / setup, with IP and
  user-agent) that survives a restart because it lives in SQLite.
- **v0.21.0** — watchdog alerts can go to **several Discord channels**, with strict parsing so a
  mistyped destination fails at save time rather than during an outage.
- **v0.22.0** — the fallback **remembers which streams need converting** (measured: Sky News FHD's
  E-AC-3, *Batman Begins*' E-AC-3 5.1 in Matroska), so the second play skips the ten-to-thirty-second
  dead start. Per-device on purpose, bounded, expiring.
- **v0.23.0** — **app-health alerts** on the same webhook (a full disk or an unwritable database, the
  app's own two real failure modes, previously visible only on the System tab), and **restart a
  programme that is still on air** by double-clicking it.
- Also today: the env timezone moved to Asia/Singapore so the container-update schedules fire at
  03:00 local rather than 03:00 UTC, and the deploy script (`scripts/dockhand-update.sh`) became
  step 6 of the release recipe — plus a repair to its streaming guard, which secret-redaction had
  silently broken into always reporting "unknown".

**The lesson this stretch earned, again:** the catch-up click bug was invisible to code reading and
obvious the moment a real click was measured. So was a disk threshold wired to nothing. Both are
arguments for the CDP harness over reasoning.

### The stretch before it (v0.13.0 and back)

**v0.13.0 — "The provider password never reaches the browser."** The day's nine releases
(v0.11.0–v0.13.0) began with the last big security item and then worked through what live use
exposed, in the order it surfaced:

- **v0.11.0** — the browser no longer sees the provider password at all. Playback goes through
  session-authenticated `/api/stream/<kind>/<id>.<ext>` and `/api/xtream` routes; the server
  injects the account's stored credentials. The password used to be in `/api/session`'s payload
  *and* in every `/live/<user>/<pass>/…` URL, which meant it landed in browser history and the
  reverse proxy's access log.
- **v0.11.1** — that change **broke the live transcoding fallback**, and nothing caught it:
  the client started handing the transcode entry points its own `/api/stream/…` path, which
  ffmpeg then resolved against the *provider* base, so the session produced no output at all
  while the player sat on an undecodable stream reporting `fragParsingError`. Also fixed: live
  was being transcoded as if it were a VOD file.
- **v0.12.0** — drag-to-pan the timeline; the channel panel names the category it shows.
- **v0.12.1** — a transcode now stops when its viewer goes away (reported as *"the transcoding
  is continuing, the directory is growing, but I am not streaming anything"*). The player says
  goodbye; the server stops any session nobody has fetched from for two minutes.
- **v0.12.2** — a transcode can no longer fill the disk. The 8 GB threshold had existed since
  v0.10.4 but was wired to nothing.
- **v0.13.0** — the guide drags in both directions, and the category panel actually resizes
  (its handle had been trapped inside the panel's own scroll container).

**The lesson this stretch earned:** three of those six were surfaced by *using* the thing, not
by reading it — an orphaned transcode, a disk threshold that protected nothing, and a resize
handle that hit-tested to a scrollbar. Reasoning about code was not enough; measuring it (or
watching it run) was.

The honest arc from the original port to today:

| Version | Headline |
|---|---|
| **v0.5.x** | Server-side EPG aggregation + drag-resizable panels (the pre-accounts baseline) |
| **v0.6.0** | **Real accounts, roles, and an admin console** — replaced the single shared `ACCESS_PASSWORD` |
| v0.6.1–v0.6.6 | Account-store hardening, real ffmpeg in the image, EPG section, fuzzy matching + caches |
| v0.6.7–v0.6.17 | Guide-parsing resilience (gzip, nested HTML), source retry/backoff, audio-drop → transcode |
| **v0.7.0** | **SQLite storage** + persistent favourites, history, and custom categories |
| v0.7.1–v0.7.2 | Resume playback (movies/series), land on Favourites |
| **v0.8.0** | Drag-and-drop ordering for favourites and custom categories |
| v0.8.1 | Channel artwork stored with entries |
| **v0.9.0** | **Global search, backup/restore, and a system health page** |
| v0.9.1–v0.9.2 | SSRF guard, sign-in throttling, Secure cookies; faster transcode start |
| **v0.10.0** | Unprivileged server + dedicated transcode disk |
| v0.10.1–v0.10.5 | Operator-visible failures: DB-unwritable, degraded health, disk headroom, signed-URL race |
| **v0.11.0** | **Provider password out of the browser** (session-authenticated stream/API routes) |
| v0.11.1 | Fixed the live transcode fallback that v0.11.0 broke (path mapping; live vs VOD) |
| **v0.12.0** | Drag-to-pan the guide; panel title names its category |
| v0.12.1–v0.12.2 | A transcode stops when its viewer goes, and cannot fill the disk |
| **v0.13.0** | Guide drags in both directions; the category panel really resizes |
| **v0.14.0–v0.14.1** | Favourites-only guide toggle; a notice when a deploy ended your session |
| **v0.15.0** | **Provider watchdog** — Discord alerts on outage and recovery |
| **v0.16.0** | EPG / Admin / System open in their own tab so playback survives |
| **v0.17.0–v0.18.0** | **Catch-up playback**, then made to work in Safari via the transcoder |
| **v0.19.0–v0.20.0** | Guide keyboard navigation, series favourites, durable sign-in audit |
| **v0.21.0** | Alerts to several Discord channels |
| **v0.22.0** | Remembering which streams need converting |
| **v0.23.0** | App-health alerts; restart a programme that is still on air |

**Where it stands (v0.23.0):** 72 source files plus 41 test files (**395 tests**), TypeScript
type-checks and ESLint clean, a SQLite-backed per-account library, encrypted credentials at
rest, no provider credential in the browser at all, Docker/GHCR packaging with a real
`HEALTHCHECK`, and live verification against a real provider (~6k channels / ~300k-programme
guide). UI behaviour is now verified with **real mouse and keyboard input** against a real
browser (Chrome over the DevTools Protocol — see the harness note under Quality). The pattern this project has earned: **find
failures live, name them plainly, and let the operator fix them from just the message.**

## Recently completed (previously on this roadmap)

- **Catch-up / timeshift playback** — v0.17.0/v0.18.0. Finished programmes replay from the
  provider's archive, bounded by `TIMESHIFT_MAX_MINUTES`, credentials still server-side, and routed
  through the transcoder because a timeshift stream is raw MPEG-TS that hls.js and Safari cannot
  decode.
- **Restart a programme that is still on air** — v0.23.0. Double-click (or Shift+Enter), for any
  channel with `tv_archive`; the archive serves from the programme's start up to now.
- **Guide keyboard navigation** — v0.19.0/v0.20.0. Arrows pan a quarter hour (15-minute steps),
  ↑/↓ scroll a row, Home returns to now, and ↑/↓ on a programme moves focus to the same column in
  the adjacent row, falling through to a scroll when there is no row.
- **Provider watchdog and alerting** — v0.15.0/v0.21.0. Two agreeing checks before calling an outage,
  a single good one breaking the streak, down/up messages that name the host and the provider's error
  but never the account, and several Discord destinations with strict save-time parsing.
- **App-health alerts** — v0.23.0. The app's own two real failure modes (full disk, unwritable
  database) on the same webhook, one watch for the whole app, every distinct destination told once.
- **Tabs that do not stop playback** — v0.16.0. EPG, Admin and System are real links in their own
  tab, with `?tab=` deep links.
- **Sign-in audit trail** — v0.19.0/v0.20.0. Who signed in, from which address and user-agent, and
  every failure, in SQLite so it survives a restart.
- **Series favourites** — v0.19.0, completing the VOD library alongside the existing favourites.
- **Remembering streams that need converting** — v0.22.0. A per-device, bounded, expiring memory of
  the streams the fallback had to rescue, so the second play is immediate.

- **Provider credentials never reach the browser** — v0.11.0. The last big security item from
  the original queue: stream and API traffic is addressed by the server, not by URLs carrying
  `<user>/<pass>`.
- **A transcode's lifecycle matches its viewer** — v0.12.1/v0.12.2. Stops when the viewer goes
  away (client goodbye + a two-minute idle sweep), deletes its directory, and refuses or stops
  before it can fill the disk.
- **Drag-to-pan the EPG in both directions** — v0.12.0/v0.13.0. Left/right through time
  (quarter-hour snapping), up/down through channels, one axis per gesture, and a drag never
  selects the channel it passed.
- **The category sidebar really resizes** — v0.13.0. The handle straddles the divider from the
  content column instead of living inside the panel's scroll container.
- **Track-switching UI for the transcode fallback** — `TrackControls.tsx` exposes audio and
  subtitle selectors (with an explicit Off for subtitles); hidden when the provider offers no
  choices.
- **Drag-resizable panels** — channel column, category sidebar, and the player/guide seam via
  one shared pointer-event hook with clamped, persisted sizes.
- **Additional EPG sources + server-side aggregation** — implemented and live-verified.
- **Per-session connection state** — request/session-scoped proxy targets extracted with tests.
- **Credential encryption at rest** — AES-256-GCM under `SESSION_SECRET`; the old browser
  `localStorage` login is gone.
- **Multi-user login system** — v0.6.0 accounts, roles and admin console.
- **`nodeUpstreamRequest.ts` under test** — the real-`http.Server` pattern from
  `proxyServer.test.ts` now covers the Node-vs-Electron swap point too.
- **Check for a new release and surface it** — `/api/version-check` plus an "update available"
  banner against the GitHub Releases API.
- **Global search, backup/restore, health page, disk-space reporting** — shipped across
  v0.9.0–v0.10.4.

## Open work

### 1. Live TV & playback

- **Player settings that persist.** *Open (partial).* `TrackControls` lets you switch audio /
  subtitle tracks live, but the choice resets per session and there is no quality or
  subtitle-styling surface. Persist the selected tracks per saved profile and add a compact
  player-settings panel (playback quality, subtitle styling, visible fallback status).

### 2. EPG & guide quality

- **Built-in public XMLTV presets.** *Open.* The login form takes raw URLs today; ship a picker
  of common public guides so users do not have to hunt for sources.
- **Manual channel→guide mapping + optional fuzzy joins.** *Open (partial).* Matching is
  deliberately conservative (exact id → normalized id → normalized display-name, unambiguous
  only), so a channel whose name genuinely differs from every guide entry (e.g. "BBC One HD
  London" vs "BBC One HD") still misses. Add a one-click "map this channel to a guide id"
  override, and optionally a fuzzy/substring pass offered as a suggestion rather than applied
  silently.

### 3. Reliability & operations

*(This theme is informed directly by the 2026-09-15 disk-full outage: a 100%-full root
filesystem surfaced only as SQLite `disk I/O error`, and the space had gone to Docker image
bloat — 89 images / 55 GB, 40 GB reclaimable.)*

- **Free-space guardrail.** *Shipped in v0.12.2.* Headroom is reported at boot and over
  `/api/health`, a transcode is refused below a threshold that depends on its kind (8 GB for a
  film, 256 MB for a live channel), and every session is stopped if free space falls below
  256 MB. What remains is a **design question rather than a guard**: a film deliberately keeps
  every segment while it plays (that is what makes it scrubbable), so a 2h20 feature holds 10 GB+
  for its runtime. Decide whether to bound that — cap the retained window and give up far-back
  scrubbing, or accept it now that the disk cannot actually fill.
- **Image bloat, still.** *Partly handled.* Dockhand already runs a scheduled container update
(03:00 Asia/Singapore, after the environment timezone was moved off UTC), so the app itself stays
current. What is left is the *images*: every release adds roughly 1 GB to the host, and the in-app
banner can only notify — it cannot replace a running container from inside itself. A scheduled
`docker image prune` on the NAS is the missing half.
- **Skip the multi-arch build for docs-only commits.** *Open.* Every push to `main` builds a full
multi-arch image (~13–20 min, arm64 `better-sqlite3` under emulation). `[skip ci]` in the commit
message is used by hand for documentation commits; a `paths-ignore: ['**.md']` on the workflow would
make that automatic and stop it depending on remembering.

### 4. Deployment

- **Reverse-proxy / TLS docs for non-Synology hosts.** *Open.* Document a Caddy or nginx setup
  for self-hosters running anywhere other than a Synology box with its own reverse proxy.
- **Confirm a real Synology deployment.** *Open.* The Synology section is reasoning-based
  ("compatible, not yet confirmed deployed"); a real hardware walkthrough would catch anything
  the reasoning missed.

### 5. Multi-user & security

- **Durable session service.** *Open.* Sessions expire after 24h of inactivity today; grow the
  browser session store into a service with explicit expiry and revocation so multiple tabs and
  restarts behave predictably.
- **Per-account scoping.** *Open (verify).* Favourites, history and custom categories are
  already per-account in SQLite; confirm the same for EPG sources and provider target selection
  as the household model grows toward a real user model.

### 6. Quality & testing

- **Fold the ad-hoc checks into one script.** *Partly done.* The pieces exist and get used:
`scripts/cdp-drive.mjs` and `scripts/cdp-verify-live.mjs` drive a real Chrome over the DevTools
Protocol with genuine mouse/keyboard input, `scripts/verify-catchup.mjs` walks one feature end to end
(channel → finished programme → preparing → player advancing → now-playing bar → return to live), and
`scripts/dockhand-update.sh` deploys and reports. What is missing is a single scripted
login → guide → drag → play check that a future change runs *by default* rather than assembling each
time. The harness has already earned its keep: it is what proved the v0.13.0 divider fix
(the pixel at the divider hit-tests to the handle; a 120 px drag scrolls the list exactly 120 px) and
what exposed the guide's pointer-capture bug that had silently eaten every programme click since
v0.12.0.
- **Keep extending the real-server test pattern.** *Ongoing.* `proxyServer.test.ts` and
  `nodeUpstreamRequest.test.ts` spin up a real `http.Server`; extend that to the transcode and
  EPG fetch paths where live behaviour has diverged from reasoning before.


## Decided against

- **Custom categories for films and series.** The user's call (2026-09-16): the provider's own
  categories plus favourites are enough for VOD. Recorded here so it is not proposed again.


- **Network hardening beyond what is already there.** The user's call (2026-09-16): the app keeps
  running on the public internet as it is — *"i dont need so many restrictions for a small app."*
  Tailscale, a source-IP allowlist at the reverse proxy, an authenticating layer in front, and an
  OpenVPN client around the app were all discussed and all declined; the VPN, when wanted, runs on
  the **client machine**. Recorded because it keeps surfacing as "the biggest remaining win", and
  because the technical case is genuinely weaker than it looks: the app's own egress (API, EPG, VOD,
  the transcoder's source) is the only traffic a server-side tunnel could carry, while **live
  segments are fetched by the browser straight from the provider's CDN** and never enter the app at
  all. Recorded here so it is not proposed again.