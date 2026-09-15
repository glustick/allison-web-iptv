# Roadmap

Recommended enhancements for future development, refreshed **2026-09-15 against v0.10.5**.
Grouped by theme rather than a strict backlog — pick based on what matters most to whoever
picks this up next. See `README.md` for the full current state and `EFFORT-ASSESSMENT.md` for
the original scoping writeup this project started from.

## Current release

**v0.10.5 — "Stop losing the race against the provider's signed segment URLs."** The last of
five rapid hardening releases shipped on 2026-09-15 (v0.10.0–v0.10.5). The stretch opened with
container hardening — the server now runs **unprivileged (uid 1000)** with a dedicated,
fillable transcode disk (`TRANSCODE_TMP_DIR`) — and then closed a chain of operator-facing
failure modes found live on a real deployment: an **unwritable database** (now names the host
path to fix and says a restart is part of the fix), an **unusable deployment** that used to
hide behind an opaque HTML error (now visible from outside via `/api/health`), **disk headroom**
reported before it runs out (a full disk surfaces as SQLite's `disk I/O error`), and finally
the **signed-URL expiry race** that made live segments 400 out mid-stream.

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

**Where it stands:** ~86 source files, 27 test files (server + client lib), TypeScript
type-checks and ESLint clean, a SQLite-backed per-account library, encrypted credentials at
rest, Docker/GHCR packaging with a real `HEALTHCHECK`, and live verification against a real
provider (~6k channels / ~300k-programme guide). The pattern this project has earned: **find
failures live, name them plainly, and let the operator fix them from just the message.**

## Recently completed (previously on this roadmap)

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

- **Catch-up / timeshift playback.** *Open — highest-value gap.* The provider already exposes
  `tv_archive` / `tv_archive_duration` on each channel, the server already proxies `/timeshift/`,
  and the EPG grid already *renders* past programmes — but selecting one does nothing. Wire the
  grid's past programmes to the already-proxied timeshift URL, bounded by the server's ingest
  window (24h back / 72h forward — widen deliberately if a longer look-back is wanted). The
  deliberate omission is documented in `EpgGrid.tsx` and `xmltv.ts`.
- **EPG grid interactions.** *Open.* Drag-to-pan the timeline and keyboard navigation through
  the grid. Today only the ◀ / ▶ / Now buttons move the window. The grid is virtualized
  (react-window), so panning should move the window without re-rendering rows in JS.
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

- **Free-space guardrail.** *Open (partial — reporting shipped in v0.10.4/5).* v0.10.5 reports
  headroom at boot and over `/api/health`; the next step is to *act*: refuse or queue new
  transcode jobs below a configurable minimum-free threshold, and prune old transcode segments
  on a schedule so a finished film does not linger on the disk.
- **Update/upgrade tooling for image bloat.** *Open.* Every release adds a ~1 GB image to the
  host. Document/script a Watchtower sidecar or a scheduled `docker image prune`, since the
  in-app banner (v0.9.x) only *notifies* — it cannot replace a running container from inside
  itself.
- **Degraded-health alerting.** *Open.* Let `/api/health` push to a webhook (ntfy / Gotify /
  Discord) when it flips to `degraded`, so a full disk or an unwritable DB pings the operator
  instead of waiting to be discovered.

### 4. Deployment

- **Reverse-proxy / TLS docs for non-Synology hosts.** *Open.* Document a Caddy or nginx setup
  for self-hosters running anywhere other than a Synology box with its own reverse proxy.
- **Confirm a real Synology deployment.** *Open.* The Synology section is reasoning-based
  ("compatible, not yet confirmed deployed"); a real hardware walkthrough would catch anything
  the reasoning missed.
- **Decide the WAN-exposure posture.** *Open — a policy question, not just engineering.* The
  server relays the provider's stream and holds the Xtream credentials itself; document (and
  ideally enforce) whether it should ever be reachable off-LAN without a VPN in front.

### 5. Multi-user & security

- **Durable session service.** *Open.* Sessions expire after 24h of inactivity today; grow the
  browser session store into a service with explicit expiry and revocation so multiple tabs and
  restarts behave predictably.
- **Per-account scoping.** *Open (verify).* Favourites, history and custom categories are
  already per-account in SQLite; confirm the same for EPG sources and provider target selection
  as the household model grows toward a real user model.

### 6. Quality & testing

- **A repeatable live-verification checklist.** *Open.* A fixed script (login → saved
  credentials → reload → EPG → play a channel that hits the EC-3 fallback) so future changes get
  the same "verify live, don't just reason about it" confirmation this project's history relies
  on, without rediscovering the steps each time.
- **End-to-end coverage.** *Open.* A Playwright pass over login → EPG → play would lock in the
  flows most of this project's bugs have centred on.
- **Keep extending the real-server test pattern.** *Ongoing.* `proxyServer.test.ts` and
  `nodeUpstreamRequest.test.ts` spin up a real `http.Server`; extend that to the transcode and
  EPG fetch paths where live behaviour has diverged from reasoning before.
