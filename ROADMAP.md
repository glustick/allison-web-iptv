# Roadmap

Trimmed 2026-11-14: the full per-release journal that used to live here is gone by the operator's
call — GitHub carries only the last three releases, and this file now matches that. What stays:
the current releases in full, a one-line index of everything that shipped before them, the open
work, the "decided against" list (so settled questions are not re-proposed), and the next three
enhancements, ranked.

## Current release

**v0.114.0 — ten more.**

The house's second ten-in-one round, each piece verified as a real gap before building (the
sleep timer's remaining countdown, the movies progress badge, history clear, and the reminder
banner's Watch button all already existed and were left alone):

1. **Guide day-jump** — ◀◀ / ▶▶ move a whole day, beside the hour buttons; weekend planning
   stopped meaning forty clicks.
2. **Programme search matches descriptions too** — "what's it about" queries find programmes
   whose titles do not carry the words.
3. **Catch-up from search results** — an in-progress result carries ▶ from start, straight to
   the catch-up path, without the detour through its grid row.
4. **Reminder dates** — the reminders list shows the weekday and date on anything not today;
   "18:00" alone was ambiguous the moment a reminder was set for Sunday.
5. **Auth log exports CSV** — the filtered rows on screen, escaped properly, named by date.
6. **End every other session** — the devices panel gains the one-click cleanup, riding the same
   per-session endpoint so each row's outcome is visible as it happens.
7. **Swap two tiles** — ⇋ on one tile, ⇋ on another; sound stays with the slot.
8. **Auto-play next episode** — per device, OFF by default, a ten-second countdown with Play
   now / Cancel, wired through the player's ended event and the same playEpisode path the Next
   button uses. Starting the next episode costs a provider connection — that is the viewer's
   call, not the app's.
9. **Per-playlist connection test** — the Playlists panel gains Test: an honest probe of the
   provider's player_api (saved rows resolve credentials server-side; typed rows use what you
   typed; the server URL passes the same loopback/metadata refusal as every server-side fetch),
   reporting reachability, sign-in, and the provider's CURRENT stream limit beside the stored one.
10. **Mark previous episodes watched** — per episode row, using the existing bulk endpoint over
    everything before it; the catch-up case ("I watched 1–7 out of order") stopped being seven
    clicks.

Tests: 1128 (unchanged — all ten are wiring over tested primitives and one pure probe reusing
the providerWatch shape). Typecheck, lint and both builds clean.

**v0.113.0 — see the walls: a guide you can filter, failovers you can see, filters that stay.**

- **The guide gained a channel filter.** Favourites-only existed; against the full catalogue
  ('All'), twelve thousand rows were still a haystack. A name filter composes with the
  favourites toggle — three typed characters now find the channel.
- **Backup-portal failovers are visible.** The failover has logged to the container since
  v0.72.0 and answered nothing in the UI; a bounded in-memory ring (last 20 events, pure module,
  recorded at both failover sites in the proxy) now reaches System → **Backup-portal failovers**:
  when, which direction, and why. Empty means the primary has carried everything; the container
  log stays the durable record.
- **The Auth log's filters survive a reload** — per device in localStorage, the same pattern as
  every other convenience here. An admin who always watches one account's failures stops
  re-selecting them every visit.

Tests: 1128 (unchanged — the ring rides the tested failover module; the rest is display and
persistence over typed fields). Typecheck, lint and both builds clean.

**v0.112.0 — the ops round: what is transcoding and for whom, what the provider allows, and what a channel is numbered.**

Three gaps, each verified absent before building (several candidates — the reminders panel, the
shortcuts help — already existed and were left alone):

- **Active transcodes answers "whose, and what".** The System tab's table gained **Account** and
  **Source** columns: the session's owner (v0.102.0's attribution, finally surfaced) and the
  app-side stream path it reads — recorded on the session itself, derived from the relay URL,
  with a direct provider input recorded only as "provider stream (direct)" because its path
  carries credentials that must never reach an admin surface. A film row says "(film)".
- **The playlists panel states the provider's own limit.** `maxConnections` was captured per
  playlist at credential-save (v0.86.0) and shown only in the multi-view surfaces; the
  management panel now says "Provider limit: N concurrent streams" (or "not reported") under
  each saved row. Read-only — it is the provider's number, not ours.
- **Channel numbers in the list view.** The provider's own `num` — what a TV remote or the
  provider's EPG addresses the channel by — was carried by every channel object and shown
  nowhere. List rows now show it, muted and tabular, before the name.

Tests: 1128 (unchanged — the source derivation rides the relay-path rule the ledger already
tests; the rest is display over typed fields). Typecheck, lint and both builds clean.

**v0.111.0 — the multi-view round: tiles you can re-point, search that reaches the weekend, and a way back.**

Three gaps verified against the code before building (the reminders panel and the shortcuts help
both already existed — checked, not rebuilt):

- **Change a playing tile's channel in place.** A filled tile had only ⤢ and ✕ — changing its
  channel meant remove-then-re-add, losing the slot's place. Each tile now carries ⇄, which opens
  the picker for that slot; assigning over a filled slot replaces the channel and the tile keeps
  its position (and its audio state).
- **Programme search reaches the weekend, and shows what it found.** The route has accepted
  start/end since v0.108; the UI was pinned to its 24h default, which hid Sunday's fixtures found
  on Friday. A range select (24 hours / 3 days / 7 days) feeds the same endpoint, and each result
  now shows the first line of its description — often the only thing distinguishing two
  same-titled episodes.
- **Undo for auto-release.** v0.107.0 stops an account's idlest tile in one click; now the
  toolbar's note carries an **Undo** for as long as the slot is still empty — stopping a tile is
  fearless when bringing it back is one click too.

Tests: 1128 (unchanged — all three are wiring over tested primitives). Typecheck, lint and both
builds clean.

**v0.110.0 — the off-air channel comes back by itself, and search gets a memory and a bell.**

Three small honest pieces:

- **Off-air auto-resume** (ported from the desktop's 0.31.0): the not-broadcasting declaration
  (v0.74.0) was terminal until a human pressed Retry. `lib/offAirProbe.ts` (pure, tested) now
  re-fetches the playlist alone every 30s after the declaration — one request per interval, a
  rounding error next to the ladder the declaration paused — and the moment the window moves,
  playback resumes on its own, logged in the Diagnostics panel. Bounded at an hour so an
  abandoned tab does not probe a dead channel for ever.
- **Reminders from search results** (v0.111 work): a future programme found by the guide search
  carries the grid's own 🔔 — set or remove without first jumping to its row.
- **Recent programme searches** (v0.112 work): the last five programme searches per device,
  recorded only when a result is acted on (the channel search's own discipline — intent, not
  keystrokes), offered as one-click chips when the field is empty.

Tests: 1128 (7 new, on the probe's pure verdicts). Typecheck, lint and both builds clean.

**v0.109.0 — the VOD disk bound, visible.**

v0.103.0 enforced `TRANSCODE_VOD_MAX_TOTAL_BYTES` silently: a refusal message at start and
container-log lines at eviction, nothing in the UI until something would not play. The System
tab's Active transcodes section now leads with the pressure gauge: **retained film output N of
the bound (P%)**, each open film listed most-idle-first — the exact order the bound's sweep
would evict — with its bytes and idle reading, and a plain sentence at 90%+ ("near the bound:
the next film may be refused or the idlest evicted"). A disabled bound (0) shows nothing,
because there is nothing to be pressured about. `storage()` answers the two numbers beside its
free-space reading.

Tests: 1125 (unchanged — the gauge is prose over numbers stats() already tests). Typecheck,
lint and both builds clean.

**v0.108.0 — programme search in the guide.**

The channel list has had search since the beginning; "what's on" had none. The EPG grid's
header now carries a programme search: two characters or more, debounced 350ms, answered by a
new `GET /api/epg/search` that filters the SAME aggregated window `/api/epg` builds (starting
an hour in the past, so an in-progress programme is findable by its own title) by substring on
the title, bounded at 200, sorted by start. A result click pans the grid to the programme
(`jumpOffsetFor` places it half an hour inside the window — the grid snaps, so approximate is
fine) and scrolls its channel's row into view via the row's composite-key data attribute.

`lib/epgSearch.ts` (pure, tested) owns the jump arithmetic, the one-phrase time description
("20:00 – 21:00", weekday named when it is not today), and resolving a result key back to an
on-screen channel row.

Tests: 1125 (6 new). Typecheck, lint and both builds clean.

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
