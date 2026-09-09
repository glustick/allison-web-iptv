# Roadmap

Recommended enhancements for future development, roughly ordered by priority within each
section. Grouped by theme rather than a strict backlog — pick based on what matters most to
whoever picks this up next. See `README.md` for current state and `EFFORT-ASSESSMENT.md` for
the original scoping writeup this project started from.

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
- **Real encryption at rest for stored credentials.** `LoginScreen.tsx`'s auto-login currently
  saves the Xtream password to `localStorage` in plaintext — a reasonable placeholder for
  personal/self-hosted use, but worth replacing with actual server-side encryption (one key
  from an env var/secret file, per `EFFORT-ASSESSMENT.md`) before this is reachable outside a
  trusted LAN.

## Player & transcode fallback

- **Track-switching UI for the transcode fallback.** The EC-3/E-AC-3 audio transcode fallback
  works end-to-end, but there's no UI yet to pick between available audio/subtitle tracks once
  it kicks in — it just picks one and plays.

## EPG grid

The Gantt-chart EPG grid (channels × time, live "now" line, Now/◀/▶ nav) is ported and
live-verified, but the desktop app's own fuller version has a few things this pass deliberately
left out:

- Drag-to-pan the timeline (currently only the ◀/▶/Now buttons move the window).
- A resizable channel column.
- Keyboard navigation through the grid.
- Catch-up/timeshift playback for past programmes (the grid shows history, but there's no way
  to actually play it back yet).

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

## Quality

- Extend `proxyServer.test.ts`'s pattern (spin up a real `http.Server`, hit it with real
  requests) to cover `nodeUpstreamRequest.ts`, the Node `https`/`http` replacement for
  Electron's `net.request` — currently exercised live but not under the existing test suite.
- A repeatable live-verification checklist (login → saved credentials → reload → EPG → play a
  channel that hits the EC-3 fallback) so future changes get the same "verify live, don't just
  reason about it" confirmation this project's history has relied on so far, without having to
  rediscover the steps each time.
