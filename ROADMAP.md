# Roadmap

Trimmed 2026-11-14: the full per-release journal that used to live here is gone by the operator's
call — GitHub carries only the last three releases, and this file now matches that. What stays:
the current releases in full, a one-line index of everything that shipped before them, the open
work, the "decided against" list (so settled questions are not re-proposed), and the next three
enhancements, ranked.

## Current release

**v0.107.0 — auto-release at the ceiling: the grid stops its own idlest tile.**

At an account's provider-stated limit the picker's answer used to be a disabled row and an
instruction to hunt for the holding tab. Now, when auto-release is on (per-device toggle in the
toolbar, default on), a blocked account's rows stay clickable with an "auto-stops idlest" badge,
and the click stops that account's idlest tile so the newcomer can play — the toolbar says which
tile went and why, fading after eight seconds.

`lib/connectionRelease.ts` (pure, tested) owns the decision, with the budget's honesty rules
baked in: only a KNOWN ceiling ever acts (v0.86.0's rule — an invented number never does), only
the same account's tiles are candidates, the audible tile is never stopped (sound is the
strongest watching-signal there is), and a tile with no ledger presence is not worth stopping —
it holds nothing to free. The idle ranking comes from the ledger the connection count already
polls (`/api/iptv/connections` now feeds its per-stream idle readings to the client). Also fixed
in passing: the grid's prefs updaters rebuilt `{ layout, slots }` literals, which would have
dropped the new flag on every tile change — they spread `...prev` now.

Tests: 1119 (12 new: the planner's shapes and key derivation; prefs round-trip gained
autoRelease). Typecheck, lint and both builds clean.

**v0.106.0 — the gate the browser can actually fail: audio beyond Dolby, and a UI check CI runs.**

**The undecodable-audio check knew exactly one family.** It asked the browser about Dolby (`ac-3`/
`ec-3`) because that was the reported silent-drop; everything else — Sunderland's **HE-AACv2**
(`mp4a.40.29`) included — passed unasked, so a browser that genuinely could not decode it had no path
to the conversion tier. `probeableAudioCodec` now whitelists the codecs an fMP4 probe can ask about
honestly: the Dolby spellings (unchanged), the `mp4a.40.x` ISO audio object types (AAC-LC `.2`,
HE-AAC `.5`, HE-AACv2 `.29`), and the registered names `opus`/`flac`/`mp3`/`vorbis`/`alac`. Anything
unmapped stays permissive — a made-up codec string makes a browser answer "no" for reasons of syntax,
and a false "can't decode" spends a provider connection on a guess.

**The scripted browser pass now runs by default.** The `ui` CI job builds the app, starts the fixture
provider and the server exactly the way the local rig does (fixture addressed by the runner's LAN IP —
the app refuses loopback providers by design), sets up the account, and runs `verify-ui.mjs` in real
Chrome; the image build waits on it. The check that found the v0.100.0 `logEvent` recursion is now the
one a future regression cannot ship past.

Also corrected this round: the "provider isn't responding in the live player" entry was stale (the
live ladder has carried the 502/504 sentence for a while), and the **Safari HEVC question was
re-attempted and blocked by the provider itself** — every HEVC candidate channel is currently serving
the byte-identical H.264 placeholder (same md5), so there is no real HEVC segment to measure until the
provider recovers; the v0.105.0 probe stands ready.

Tests: 1107 (5 new on the widened gate). Typecheck, lint and both builds clean.

**v0.105.0 — the verification round: a scripted browser pass, and the bug it found on its first run.**

The ROADMAP has asked since September for "a single scripted login → guide → play check that a
future change runs by default." `verify-ui.mjs` became that this round, extended past its
v0.95.0 shape (login → play → watched toggle) with the v0.102 surfaces — the connections
endpoint's account buckets (asserted live, mid-playback: buckets sum to the total, count ≥ 1)
and the Auth log's outcome filter (rows narrow, every remaining row outcome=ok) — plus presence
of this release's Safari HEVC probe. Admin/System are reached through their `?tab=` deep links
(they open in their own tab by design), with a content-first wait because the deep link's first
render can flash the login screen while the session is confirmed. **Full PASS twice in a row**
against the fixture rig (fixture-provider :8091 + a local-disk app copy — the SMB share's stale
reads make running the built app from the repo itself untrustworthy).

**And it found a real bug on its first run: the app crashed on render.** v0.100.0's
`logEvent` in LivePlayer called *itself* where `console.warn(message)` belonged — infinite
recursion, stack overflow, the error boundary's "[app] uncaught render error" — meaning **the
first recovery decision any live stream hit would have crashed the whole app since v0.100.0**
(shipped, deployed, and unverified: five releases carried it). The film player (v0.101.0) got
the same wiring right; only LivePlayer's copy recursed. One line, now with a comment that names
the failure so it is not reintroduced by a well-meaning "simplify".

Two more pieces:

- **The scoping audit's one real finding, fixed.** A fresh login's first proxy request rode
  `defaultProxyTargetBase` — simply *whichever account saved or connected last* — because that
  default outranked the account's-own-provider fallback, which was unreachable in exactly the
  multi-account case it was written for. `resolveTargetBase` (sessionState.ts, pure + tested)
  now owns the precedence: override header → session's target → the caller's OWN saved provider
  → legacy default. EPG sources were audited too: a deliberate system setting, admin-written,
  documented as such — no change.
- **The Safari HEVC probe** (admin → System): plays one real provider playlist through the app's
  own relay in the browser's native HLS pipeline — no ffmpeg, no hls.js — and reports metadata /
  video-track / playhead / the browser's own refusal as copyable lines. This is the measurement
  that settles whether Safari plays the provider's own HEVC packaging (open since 2026-09-21);
  run it in Safari on a UHD channel and read the verdict.

Also this round, outside any release: **the release journal was backfilled** — tags existed but
GitHub Releases stopped at v0.88.0; v0.89.0 through v0.104.0 now have releases with notes taken
from this file, and the app's own version-check reads a real "latest" again.

Tests: 1102 (4 new, on resolveTargetBase). Typecheck, lint and both builds clean. Browser-verified
— that is the whole point of this round.

**v0.104.0 — a login ends by TIME too, not only by silence.**

The "durable session service" item's last honest gap: the idle TTL ends sessions that go quiet,
and a tab left on a playing channel heartbeats every ~15 seconds — which IS activity — so an
always-on viewer's login lived for ever. That was an accident of what counts as activity, not a
security property. Sessions now also end an absolute time after they BEGAN (default 30 days,
however active), the viewer signs in again, and that is the whole ceremony.

`lib/sessionLifetime.ts` (pure): `resolveMaxSessionAgeMs` reads `AUTH_MAX_SESSION_AGE_HOURS`
(garbage/zero/negative → the 30-day default — a typo must shorten nobody's sessions to nothing
and lengthen nobody's to forever); `sessionIsExpired` judges the login clock only, so it composes
with the idle rule without either knowing the other; `expiredRestoredSessions` picks the rows a
restart must not revive — and the boot removes those rows, so the cap survives restarts by
construction rather than re-firing every boot. Enforced at the lazy lookup (checked first and
quietly — a month-old login expiring is routine, not the event a failed guess is), the periodic
sweep, and the restore.

Tests: 1098 (7 new). Typecheck, lint and both builds clean.

## Release index (everything older, one line each)

The code and its tests carry the details; this is only what each version WAS, for archaeology.

- **v0.89–v0.101** — the household-watching stretch: subtitle appearance (89), sleep timer /
  keyboard control / recent searches / account activity (90), programme reminders + now/next (91),
  continue-watching shelf (92), ten remote-sized courtesies (93) + a fixture provider that found a
  real short-EPG bug (93.1), list filters + series ordering (94), next-episode + the first scripted
  UI check (95), the watched state (96) + controls behind one button (96.1), watched-on-finish +
  hide-watched (97), bulk season watched (98), Continue bar + Next up (99), the live player's
  in-UI recovery log (100) — whose `logEvent` self-recursion shipped broken and was only found by
  the v0.105 verification round — and the film player's matching diagnostics (101).
- **v0.102.0** — attribution: per-account connection ledger + accounts breakdown, Auth log filters.
- **v0.103.0** — the VOD disk bound: total retained film output capped, most-idle evicted first.
  (Indexed here because its GitHub release was removed in the same trim as everything pre-v0.104.)
- Earlier history (v0.11–v0.88): multi-playlist, EPG streaming parser, connection budget, guide
  suggestions, session hardening, the WebCodecs engine, self-service password change — the releases
  that built the app; removed from GitHub by the same trim, still visible in git history.

## Open work

- **The Safari HEVC question** — open since 2026-09-21, and currently blocked by the PROVIDER:
  every channel (the "HEVC" ids included) is serving a byte-identical H.264 1080p placeholder
  (measured 2026-11-14, same md5 on 668/41627/41666/41672/41729/684). The v0.105.0 probe
  (admin → System) is the tool: run it in Safari on a UHD channel once real HEVC returns.
- **Extend the real-server test pattern** — proxyServer/nodeUpstreamRequest already test against a
  real `http.Server`; transcode and EPG fetch paths deserve the same, where live behaviour has
  diverged from reasoning before.

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

## The next three enhancements (ranked, 2026-11-14)

**1. Connection auto-release at the ceiling.** The budget knows the number and now knows WHO holds
each connection (v0.85/v0.86/v0.102), but when the ceiling is hit the surfaces only warn and block.
The next step is the honest one for a household: at the account's known limit, offer (or by setting,
perform) stopping the most-idle stream automatically — the ledger already ranks them — instead of
making someone hunt for the tab that is holding the connection. Same eviction logic the VOD disk
bound (v0.103.0) proved, applied to the live budget.

**2. Programme search in the guide.** Channel search exists; the EPG grid cannot be searched by
programme. A "what's on" search over the aggregated guide (already loaded server-side for the grid)
with jump-to-channel-and-time, remembering recent programme searches the way channel search does.

**3. The VOD disk bound, visible.** v0.103.0 enforces TRANSCODE_VOD_MAX_TOTAL_BYTES silently — a
refusal message at start and container-log lines at eviction, nothing in the UI until something
won't play. The System tab should show retained film output against the bound (per session, with
the most-idle-first order the eviction would take), so the operator sees the pressure before a
refusal explains it.
