# Roadmap

Recommended enhancements for future development, roughly ordered by priority within each
section. Grouped by theme rather than a strict backlog — pick based on what matters most to
whoever picks this up next. See `README.md` for current state and `EFFORT-ASSESSMENT.md` for
the original scoping writeup this project started from.

## Current release

- **v0.5.1 published:** drag-resizable panels — the EPG channel column, the category sidebar
  on all three tabs, and the Live TV player/guide seam — via one shared pointer-event hook
  with clamped, persisted sizes (see the EPG grid section below).
- **v0.5.0:** server-side EPG aggregation with additional user-configurable XMLTV
  sources (see the EPG grid section below for the full account), the wider channel→guide
  matching layer, `/api/epg` + `/api/epg/status`, and the Live TV backgrounding-recovery
  watchdog — on `main` and tagged as `v0.5.0`.
- **Validation:** 138 tests pass, both TypeScript projects type-check, ESLint passes, the
  server and client builds succeed, and both the EPG aggregation path and the panel-resizing
  drags were live-verified in a real browser. The backgrounding recovery is unit-tested
  (pure decision logic in `liveStreamRecovery.ts`) but its live end-to-end confirmation is
  still pending the user's own test — the wedge itself was reproduced live on 2026-09-12 as
  described in the Stability section.

## Stability

- **Playback intermittently freezes with an on-screen error during Live TV, web-only —
  confirmed not to happen in the desktop (Electron) app on the same account/provider.**
  Root cause confirmed by direct comparison against the desktop app's `Player.tsx`:
  `src/client/src/components/LivePlayer.tsx`'s hls.js `ERROR` handler previously just set an
  error message and stopped on any fatal event, with no retry — unlike the desktop app, which
  self-heals fatal `NETWORK_ERROR`/`MEDIA_ERROR` events via `hls.startLoad()`/
  `hls.recoverMediaError()`/`hls.swapAudioCodec()`. That gap is why only a full browser refresh
  (which rebuilds the player from scratch) ever recovered playback here.
  - **Fixed**: ported the desktop app's retry/recovery logic into `LivePlayer.tsx` — up to 4
    network retries (2s apart) via `hls.startLoad()`, up to 3 media-error recoveries via
    `hls.recoverMediaError()` (swapping the audio codec on the 2nd attempt, matching the
    desktop app's own tuning), and a 15s post-recovery window of uninterrupted playback before
    resetting both counts, so an unrelated later blip gets its own full set of retries. Only a
    genuinely exhausted or unrecognized fatal error still shows the on-screen error and gives
  up. Typecheck/lint/test suite all pass; not yet confirmed live against the real
  account/provider that originally reported the freeze — that's still the real bar per this
  project's own "verify live, don't just reason about it" history, so treat this as fixed-in-
  code, pending live confirmation the actual freeze is gone.
  - **Live check (2026-09-12):** healthy foreground playback confirmed against the real
    account — two different live channels each played minutes of 1080p at exactly 1:1
    wall-clock progress with continuous segment fetches, zero console errors, no on-screen
    error, and instant recovery on channel switch. The recovery paths themselves never had to
    fire during healthy playback, so they remain fixed-in-code rather than proven-live; what
    *was* proven is that v0.4.4 doesn't regress normal viewing. See the new backgrounding
    finding below — the one freeze-shaped behavior observed live traced to the test
    environment's suspended webview, not to either fix failing.
- **Second, distinct freeze reported live after the above fix shipped: Live TV plays briefly,
  then a permanent buffering spinner, playback time stuck on a bogus value, no error in the
  console at all, and no recovery.** "No console error" ruled out the fatal-hls.js-error path
  above entirely — that fix only ever engages once hls.js actually emits an `ERROR` event, and
  this wasn't emitting one. Root-caused by direct code reading against
  `src/server/lib/nodeUpstreamRequest.ts` and `proxyServer.ts`: once upstream response *headers*
  arrive, `proxyServer.ts` clears its own timeout and never watches the connection again — a
  live-playlist/segment fetch whose connection goes completely silent mid-body (never closes,
  just stops sending bytes) hangs the piped response to the browser forever, with nothing to
  ever error or close it. Confirmed via a byte-identical diff against the desktop app's own copy
  of `proxyServer.ts` that this file itself is unmodified — the gap is specific to
  `nodeUpstreamRequest.ts`, the deliberate Node-vs-Electron swap point, meaning Electron's net
  module (Chromium's own network stack) evidently already guards against this in a way plain
  Node http/https does not.
  - **Fixed**: `nodeUpstreamRequest.ts`'s response-piping now watches for 20s of inactivity on
    the upstream body specifically (not just the initial wait for headers) and force-destroys
    the connection if it stalls, which in turn force-ends the client-facing response so the
    browser's fetch/XHR actually completes (with a failure) instead of hanging indefinitely with
    no signal — giving hls.js something concrete to react to, and `proxyServer.ts`'s own
    upstream-request error handling a real event to see. Fixed entirely inside
    `nodeUpstreamRequest.ts` rather than touching `proxyServer.ts`, to keep that file's parity
    with the desktop app intact. Covered by two new tests exercising a real local HTTP server
    (one that stalls mid-body, one that keeps streaming normally) — both pass consistently.
    Same caveat as above: fixed-in-code, not yet confirmed live against the real freeze.
- **New, found live during the 2026-09-12 verification pass: backgrounding the app
  permanently wedges Live TV with no self-recovery.** When the page's rendering/timers get
  suspended (browser tab backgrounded, or an embedded-webview host window losing OS focus),
  playback freezes as expected — but on returning to the foreground, hls.js never resumes:
  zero new playlist/segment requests after the page is visible again, buffer exhausted at its
  live edge, `readyState` misleadingly 4, no error anywhere, and the only recovery is a
  channel switch or full reload. Verified directly in-page (rAF resumed, request log empty for
  minutes after). This is *not* the v0.4.2 watchdog's domain — nothing is in-flight to stall;
  the suspension wedges hls.js's own live-refresh timer chain.
  - **Fixed in v0.5.0:** `LivePlayer.tsx` now runs a backgrounding-recovery watchdog (pure
    decision logic extracted to `lib/liveStreamRecovery.ts`, covered by unit tests): a stream
    that has received no fragments for 60s while its playhead sits starved at the buffer end
    gets resumed if the browser auto-paused it, kicked via `hls.startLoad()`, and — after two
    fruitless kicks — fully reloaded via the player's own reload path. Deliberately tolerant
    of slow-but-alive providers (the 60s threshold and buffer-ahead check keep healthy streams
    and user-paused streams out of its way). Fixed-in-code plus unit tests; the live
    end-to-end confirmation is pending (provider outage interrupted the smoke test — see
    Current release).

## Security & multi-user

- **Real login system beyond the single shared `ACCESS_PASSWORD`.** Right now `/api/login`
  accepts one password for everyone; there's no concept of separate accounts. Even for a
  household of two or three, named logins (rather than one shared secret) would let each
  person have their own saved Xtream credentials and EPG/favorites state instead of clobbering
  a shared one.
- **Per-session (not single-global) connection state.** The desktop app assumed one profile
  active at a time; this port still carries that assumption in places. Two people opening the
  app from different devices at once should get independent sessions, not a shared/overwritten
  connection.
  - **Implemented in part:** the server now resolves per-request / per-session proxy targets via
    a session cookie plus a request-level override, and the logic is extracted into a dedicated
    helper with regression tests. This is still a stepping stone toward real multi-user auth,
    not a complete account system yet.
  - **Implemented in part:** per-browser session profile state is now encrypted and kept as a
    small list of named saved Xtream profiles with an active selection, so we can move from
    a single shared login toward a household profile model without storing credentials in the
    browser. The stored state is covered by regression tests and the server exposes it via the
    session endpoints.

### Future enhancements

- Add a distinct session-scoped credential store so multiple browser tabs can share one session
  without reauthenticating on every tab load.
- Expose session status in a `/api/session` endpoint so the UI can explicitly show which server
  and user profile are active.
- **Credential encryption at rest:** implemented. The server encrypts the browser-session
  credentials payload using `SESSION_SECRET`, and the app no longer stores the login in browser
  `localStorage`.
- Expand the current browser session store into a durable session service with expiry and
  revocation, so multiple tabs and restarts have predictable behavior.
- Move from named household profiles to a real user model that anchors favorites, EPG state, and
  provider target selection to an authenticated user.

## Player & transcode fallback

- **Track-switching UI for the transcode fallback.** The EC-3/E-AC-3 audio transcode fallback
  works end-to-end, but there's no UI yet to pick between available audio/subtitle tracks once
  it kicks in — it just picks one and plays.
  - **Implemented:** Live TV and VOD/series HLS playback now expose available audio and subtitle
    tracks through compact selectors. Audio changes use hls.js's active track, while subtitles
    include an explicit Off option; controls stay hidden when the provider exposes no choices.

### Future enhancements

- Persist the selected audio and subtitle tracks per saved profile.
- Add a compact player settings surface for playback quality, subtitle styling, and fallback
  status once the track controls have been exercised against more providers.

## EPG grid

The Gantt-chart EPG grid (channels × time, live "now" line, Now/◀/▶ nav) is ported and
live-verified, but the desktop app's own fuller version has a few things this pass deliberately
left out:

- **Additional EPG sources + server-side aggregation — implemented and live-verified
  (2026-09-12).** EPG assembly moved out of the browser entirely: the server now fetches,
  caches (6h TTL, stale-while-revalidate, pruned to a rolling 24h-back/72h-forward window),
  and merges the provider's `xmltv.php` guide with any extra XMLTV URLs configured on the
  login form ("Additional EPG guide URLs", stored with the encrypted session profile), then
  serves windowed listings via `/api/epg` keyed by stream_id — so the old ~98MB-per-tab XML
  download became a ~4MB JSON per visible window. A matching layer (`epgMatching.ts`: exact
  `epg_channel_id` → normalized id → normalized display-name, unambiguous-only) recovers
  channels the old exact-string join silently missed, `/api/epg/status` reports per-source
  health, and channels every source has nothing for show a "No guide data" label instead of an
  ambiguous blank row. Confirmed live: 5,963 provider channels / 314,895 programmes parsed,
  4,458 streams populated in the current window, 22 previously-empty streams gained data from
  a real external XMLTV source with zero regressions. Still open within this theme:
  - The matching layer is deliberately conservative (no fuzzy/substring joins); a channel
    whose name genuinely differs from every guide entry (e.g. "BBC One HD London" vs
    "BBC One HD") still needs either a provider id or a closer external source name to join.
  - Built-in public-guide presets (the login form takes raw URLs today — the user finds and
    pastes their own XMLTV sources).

- **Drag-resizable panels — implemented (2026-09-12), live-verified in-browser.** Three
  dividers now share one mechanism (`lib/useResizableDimension.ts`, a pointer-event port of
  the desktop app's own v0.7.9 `useResizableWidth` hook, clamped and persisted to
  `localStorage` per panel — the client's first localStorage use, mirroring the desktop
  app's own fallback path): the EPG grid's channel column (90–320px, one full-height handle;
  rows never read the width in JS so react-window re-renders nothing mid-drag), the category
  sidebar on all three tabs (160–360px), and a row-resize seam between the Live TV player and
  the guide that adjusts the video's height cap (120px–80vh, default = the old fixed 45vh).
  Verified live: drags apply in real time, clamp at both bounds, persist, and survive a full
  reload + auto-reconnect.

- Drag-to-pan the timeline (currently only the ◀/▶/Now buttons move the window).
- Keyboard navigation through the grid.
- Catch-up/timeshift playback for past programmes (the grid shows history, but there's no way
  to actually play it back yet; note the server's ingest prune window is 24h back / 72h
  forward, which bounds how far back any future catch-up UI could look without widening it).

## Deployment & ops

- **Confirm an actual Synology deployment**, not just compatibility. The README's Synology
  section is based on `ffmpeg-static`'s shipped binaries and `ffmpegResolver.ts`'s
  prefer-system-ffmpeg logic lining up correctly — worth a real walkthrough on real NAS hardware
  to catch anything the reasoning missed.
- **Document a reverse-proxy/TLS setup for non-Synology hosts** (Caddy or nginx), for anyone
  self-hosting this somewhere other than a Synology box with its own built-in reverse proxy.
- Revisit whether the server should be reachable outside the LAN at all without a VPN in front
  of it — flagged in `EFFORT-ASSESSMENT.md` as a real posture question, not just an engineering
  one, since the server now relays the provider's stream and holds the Xtream credentials
  itself.
- **Check for a new release and surface it in the UI.** `EFFORT-ASSESSMENT.md` cut the desktop
  app's `electron-updater` entirely as "meaningless for a web app; redeploy instead" — that
  still holds for *actually* replacing the running container from inside itself, which isn't
  really feasible (a container can't cleanly swap out its own image while it's the thing
  running). What is feasible and worth adding: a periodic check against the GitHub Releases API
  for `glustick/allison-web-iptv`, compared to the running build's own version, surfaced as a
  simple "update available" banner — same idea as Sonarr/Radarr-style self-hosted apps, just
  notification-only, no auto-restart. For the actual update step, point people at existing
  Docker-layer tooling instead of reinventing it in-app: either a **Watchtower** sidecar
  (auto-pulls a new GHCR image and restarts the container) or Synology Container Manager's own
  built-in "auto-update on new image" toggle, since Synology is already a documented deployment
  target here. Giving the app itself Docker-socket access to redeploy itself would work too, but
  is a real security tradeoff (broad host access from a personal media app) for what a sidecar
  container already solves cleanly.
  - **Implemented:** the app now checks the GitHub Releases API via `/api/version-check` and
    displays a simple update banner when a newer release is available, without trying to self-
    update from inside the running web container.

## Quality

- Extend `proxyServer.test.ts`'s pattern (spin up a real `http.Server`, hit it with real
  requests) to cover `nodeUpstreamRequest.ts`, the Node `https`/`http` replacement for
  Electron's `net.request` — currently exercised live but not under the existing test suite.
- A repeatable live-verification checklist (login → saved credentials → reload → EPG → play a
  channel that hits the EC-3 fallback) so future changes get the same "verify live, don't just
  reason about it" confirmation this project's history has relied on so far, without having to
  rediscover the steps each time.
