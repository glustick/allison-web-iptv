# Roadmap

**Correction, 2026-09-21 (after v0.46.1).** Two entries below said live verification was pending
because "the provider has been down since 2026-09-20". That came from the 2026-09-20 session's own
notes and was carried forward without re-checking — the provider was back. What actually blocks the
live proof is deployment: the running deployment was still on v0.44.1, so no real channel had been
exercised against the v0.45.0 tier or the v0.46.x resolution cap. Those entries now say that instead.
Worth recording as a habit: a note inherited from an earlier session is a hypothesis, not a fact —
check it before repeating it into a release note.

Recommended enhancements for future development, refreshed **2026-09-21 against v0.46.3**.
Grouped by theme rather than a strict backlog — pick based on what matters most to whoever
picks this up next. See `README.md` for the full current state and `EFFORT-ASSESSMENT.md` for
the original scoping writeup this project started from.

## Current release

**v0.46.3 — native playback first, and no silent quality trade.** A correction of direction, not just
of code. v0.46.0 made the re-encode tier downscale by default and v0.46.1 let a stall reach that tier;
both bought smoothness with the viewer's picture, which is not this player's decision to make — the
user's own words were *"I don't want to transcode the video and lose quality, I want the native video
to play correctly"*, and they were right.

- **Live TV now prefers the browser's own HLS pipeline** (`lib/nativePlayback.ts` — pure, injected
  `canPlayType`, unit-tested). Safari has had that pipeline all along behind the same MIME type HLS
  has always used; it is the route a native player like TiviMate takes, and the reason these channels
  play untouched there. Live TV was previously sent through hls.js wherever MediaSource existed — even
  in Safari — which is what forced every HEVC / 10-bit HDR / Dolby stream through a JavaScript demux
  into MSE, and therefore what made transcoding look necessary in the first place. Chromium answers
  `''` to the native-HLS question, so nothing changes for it, and a native failure re-attaches with
  hls.js once: worst case is the old behaviour, one retry later.
- **Resolution is no longer capped by default** — `TRANSCODE_VIDEO_MAX_HEIGHT` is opt-in. The tier's
  job is to make an undecodable stream playable at the quality the provider sent.
- **A stall never escalates to a re-encode.** v0.46.1's rung is removed; a stalled session is replaced
  in the shape it has. The tier remains the media-error ladder's last resort (v0.45.0), where the
  alternative is nothing on screen.
- Deliberately *not* done, and worth recording: the per-device hint that remembers a channel "needs
  the video tier" was learned through MSE, so under native playback it is honoured only on the hls.js
  path — otherwise a browser that can play a channel perfectly would still be handed a re-encode
  because hls.js once struggled with it.

472 tests; typecheck, lint and both builds green. *Not verified live:* the provider has been answering
every channel with a repeating placeholder (see the measurement note below), so there is nothing real
to play.

**v0.46.2 — the stall ladder is complete.** v0.46.1 gave a stalled *session* an escape; a stalled
**direct** stream — the provider's feed, relayed — still ended in the terminal error, the one place a
heavy channel could die without the transcoder ever being offered, while every other reload path in
the app converts. `stallRecoveryShape` now returns the whole rung set (`reload`, `convert`,
`video-transcode`, `session`, `give-up`), and a direct stream converts once its reloads are spent —
deliberately to the cheap copy tier, because nothing there says the video is undecodable; a session
that then stalls escalates by itself. 473 tests; typecheck, lint and both builds green. *Not proven
against a real stream:* see the measurement note at the end of this section — the provider has been
serving a repeating placeholder on every channel, so there is nothing real to exercise it against yet.

**v0.46.1 — the stall ladder reaches the re-encode tier.** hls.js's own reload paths already end in
the transcoder — a refused segment (400/403) converts the channel, two `BUFFER_STALLED` errors
convert it, and v0.45.0 taught the media-error ladder to escalate to the video tier — but the
backgrounding watchdog's stall branch did not. It rebuilt the source, or replaced a dead session with
*the same shape*, so a heavy channel whose stream-copied session kept starving itself got another
stream-copy, and another, until the ladder gave up: measurably the shape behind "the UHD channels
don't play well", with the tier that fixes it never reached. `stallRecoveryShape` (pure, exported,
unit-tested in `transcodeFallback.test.ts`) now decides the shape — a repeatedly-stalling *copy*
session escalates to the video re-encode tier once, which v0.46.0's cap makes a genuinely cheaper
target than the 4K relay it replaces, after which that rung retires and the session is replaced in
place exactly as before. A run that is not on a transcode session is unchanged. 470 tests; typecheck,
lint and test all green. *Not proven live:* as with v0.46.0, this needs a deployment running this
build. **Reversed in v0.46.3, two hours later:** escalating a stutter into a downscale traded the
viewer's picture for smoothness without being asked, which is not the stall ladder's call to make — a
stalled session is now replaced in the shape it already has. Left in the record for the reasoning, not
because it is current.

**v0.46.0 — the re-encode tier caps resolution: UHD channels are no longer re-encoded at 4K.**
The open question v0.45.0 named, closed. That tier capped the framerate (25 fps) but left the
resolution alone, so a UHD (3840x2160 HEVC) channel was re-encoded *at 4K* — work no NAS CPU does in
real time, which is precisely why the UHD channels "don't play well" while TiviMate plays them
(native players decode HEVC in hardware and never re-encode at all). The tier now scales to 1080p by
default, through a filter that is a *cap* rather than a resize — `scale=-2:'min(1080,ih)'`: a 720p or
1080p channel passes through untouched, only a taller source is scaled down, and nothing is ever
upscaled. `TRANSCODE_VIDEO_MAX_HEIGHT` overrides it (0 or empty = no cap at all) and
`TRANSCODE_VIDEO_MAXRATE_KBPS` adds an optional capped-CRF bitrate ceiling for a network-limited
host. Pinned three ways: argv-level tests for the default cap, for a lower cap with a ceiling, and
for the copy path emitting none of it; pure tests for the env parsing (0, empty and garbage all mean
"no cap" rather than a broken encode); and a real-ffmpeg integration test that runs a taller
synthetic source through the tier and reads the output's real dimensions back. 466 tests; typecheck,
lint and test all green. *Not yet proven live:* the tier's real-time headroom on the actual NAS, and
the escalation firing against a real HEVC channel — both need a deployment running this build.

**v0.45.0 — the video re-encode tier: HEVC channels play on browsers that cannot decode HEVC.**
The last wall from v0.44.1, closed. Some Chromium builds answer `isTypeSupported(hvc1)` → true and
then fail the actual append (`mediaSourceRequiresReset`); the session's video is a stream-copy of
source HEVC, so nothing about the session is wrong and no amount of recovery helps. `videoTranscode:
true` on `/api/transcode/start` re-encodes with libx264 — ~25 fps, CRF 23, 8-bit yuv420p (the UHD
feeds are Main 10 HDR, and Chromium's MSE will not append that) — and the player's `MEDIA_ERROR`
ladder escalates to it **once**, when a session exhausts its recoveries, before giving up as it
always did. The requirement is remembered per device (`transcodeHints`' optional `video` flag), so
the next play starts at that tier rather than paying for a copy session it will discard.

Two measurements worth keeping, both now pinned by tests. First, the encoder flags are only half the
fix: the HLS muxer splits a segment at a keyframe, and libx264's default keyframe interval is ~10s at
25 fps — so the first 4s segment could not close until the input was nearly over. Measured against a
throttled source (a 12s clip delivered over 4.8s): the session's playlist did not appear until EOF
instead of ~2.5s, and a live channel never reaches EOF, so it would never have appeared at all. An
explicit `-g 100 -keyint_min 100 -sc_threshold 0` (100 frames at fps=25 is exactly the 4s segment)
fixes it. Second, the default path is untouched: none of these flags are emitted when the video is
merely copied — a test pins that too. 460 tests; typecheck, lint and test all green. *Not yet proven
live:* the tier's encode throughput on a NAS CPU, and the escalation firing against a real HEVC
channel — both need a deployment running this build (see the correction note at the top).

**v0.44.1 — fMP4 transcode segments: HEVC channels can finally play through the fallback.**
Found live on the Sky Sports channels (UHD and FHD alike — the whole family is HEVC video +
E-AC-3 audio, which is exactly why TiviMate plays them natively while browsers cannot): the
transcode's output was MPEG-TS, and a stream-copied HEVC stream is undecodable by Chromium's
MSE in a TS container while being decodable in fMP4 (measured in the player browser:
isTypeSupport hvc1-in-mp2t → false, hvc1-in-mp4 → true). Even after switching ffmpeg to
`-hls_segment_type fmp4`, the sessions still churned — the file server's MIME allowlist
(`TRANSCODE_MIME_TYPES`) 404'd the `init.mp4` the playlist's EXT-X-MAP references, so the very
first player fetch died and every subsequent fragLoadError was the session-replacement cycle
chasing that 404. Both fixed, plus: audio now keeps its source channel layout (a 5.1 feed
stays 5.1 AAC at 384k instead of being folded to stereo — browsers downmix themselves), and
the relay's refused-segment window cache keeps a one-deep history so a burst of refusals
straddling a refresh still maps correctly. Verified live: sessions produce 4K fMP4 at ~1x
realtime and survive (no churn, single start), segments fetch 200 through the app. **The
remaining wall is per-browser: the test machine's embedded Chromium claims
isTypeSupported(hvc1) → true but fails the actual decode (mediaSourceRequiresReset on
append) — on browsers with genuine HEVC support (Safari; Chrome with working hardware
decode) these channels now play via the audio-only path. See the new open item below for
the HEVC-incapable-browser tier.**


**v0.44.0 — refused segments retry with a fresh playlist instead of converting.** The thorough
fix for expired signatures (see Live TV & playback below for the full account): the relay
remembers each served playlist's segment window, and when a segment is refused (400/403 — the
provider's ~25s signed URLs expiring mid-playlist), it refreshes the playlist once, remaps the
segment by absolute sequence number, and retries it — so heavy channels relay directly like
light ones instead of paying for a transcode. Five new unit tests against a signing-URL origin;
453 total, all gates green. *Live note: during verification the provider went down entirely
(measured: auth and playlists hanging with no response), so the live proof of the retry
engaging against real 400s is pending its return — the one healthy window tested (a 4K EPL
feed) relayed directly with zero refusals and zero transcodes.*


**v0.43.4 — the gate is a gate: lint, typecheck and tests now run before a release is published.**
The v0.43.2 handoff turned up a defect class worth more than the fix it came with. A duplicated `case`
label placed below the live one is **unreachable code that type-checks, lints and passes every test** —
measured, because it happened here. Two gates were missing; both are now closed:

- **`no-duplicate-case` and `no-unreachable` are enforced** in `eslint.config.mjs`. That config is
  deliberately minimal (two promise rules), which is precisely why a duplicate switch case passed lint —
  the tool never had an opinion on it. Verified zero-violation across `src/` before enabling, so this adds
  no cleanup debt.
- **CI runs `lint`, `typecheck` and `test` in a `check` job, and the image build needs it.** Until now the
  workflow only built and pushed, so a release with failing tests or a lint error published regardless —
  the v0.31.0 failure mode, and the reason the duplicate case reached a tag at all. The gate is now the
  same gate locally and in CI.

The lesson below stands, one class sharper: **a test that does not exercise the path proves nothing about
it, and an automated gate that is not wired to the build is not a gate.**

**v0.43.3 — a dead transcode session no longer freezes the channel.** Found live the same
morning, by the user, as "Newcastle and Sunderland both still not working": the v0.43.2
conversion worked, but the converted session could die quietly (the provider's intermittent
30-second no-response windows expire ffmpeg's signed segment URLs; killing ffmpeg reproduces
it exactly), and every layer of recovery had a hole. Three fixes, all verified live by killing
ffmpeg under a playing session:

- **The network ladder now replaces a dead session at the moment of failure.** A session
  playlist that exhausts its network retries *is* a dead session (measured: exactly five
  `levelLoadError`s, then a terminal state), so the terminal branch calls `restartFallback`
  immediately — fresh session, fresh playlist — instead of erroring out or leaving the dead
  session URL to be replayed (v0.28's own lesson, relearned). Verified: kill → five errors
  over 20s → "[player] transcode session failed its network retries; replacing the session" →
  replacement producing within ~25s, buffer rebuilt, playback material restored, no overlay.
- **A paused stream that stops loading is detected and repaired in the background.** Pausing
  mid-buffer hides the starvation signal the stall watchdog keys on (the playhead stops, so
  "buffer ahead" stops meaning healthy), so a source that died while the viewer was away was
  only noticed when they pressed play and the leftover buffer ran out. Three minutes of zero
  fragments on a paused live stream now recovers the source — without resuming playback,
  which was the viewer's choice (`LIVE_STALE_WHILE_PAUSED_MS` in `liveStreamRecovery.ts`).
- **"Startup" has a deadline.** The watchdog deliberately ignored runs with zero fragments
  ever appended (hls.js owns loading) — but a run that produces nothing for 90s is dead, not
  starting, and without this escape the watchdog stayed blind to exactly the state a dead
  session leaves (`LIVE_STARTUP_ABANDON_MS`). Session runs also skip the doomed plain-reload
  attempt in the stall ladder and go straight to session replacement.

Sunderland, for the record, plays directly — its encode never trips any of this; the
`levelLoadTimeOut` seen while testing it was the provider's flaky window, not the player.

*Also for AutoClaw, continuing from the v0.43.2 note below:* your media-error conversion is
live and working — the completion needed was merging your duplicated switch case into the
recovery ladder (v0.43.2), and the session-death follow-on it exposed is now closed here
(v0.43.3). The whole recovery story was verified against the real channels on 2026-09-19:
Newcastle converts on its fatal `mediaSourceRequiresReset` errors and survives its transcode
session being killed outright; Sunderland plays directly. If you pick this thread up again:
the remaining flakiness is the *provider's* (intermittent ~30s no-response windows — visible
as `Upstream did not respond within 30000ms` in the server log), which the player now rides
out but can never fix; a server-side variant (restarting a stalled ffmpeg from the transcode
service itself, rather than waiting for the player to notice) is the one unexplored direction,
only worth it if these channels still visibly stutter after v0.43.3. The one-shot reproducer
for any future regression here: play a converted channel, `pkill -f ffmpeg-static/ffmpeg`, and
expect "replacing the session" in the browser console within ~30s with playback material
restored shortly after.

**v0.43.2 — fatal media errors convert instead of freezing.**

*Handoff note for AutoClaw, whose uncommitted `LivePlayer.tsx` work this release completes.*
Your change was recovered exactly as left — a new `case Hls.ErrorTypes.MEDIA_ERROR` routing
fatal media errors to the transcoder — and it was close, but it could never run: it was pasted
*below* the existing `MEDIA_ERROR` case in the same switch, and JavaScript dispatches to the
first matching label, so the whole branch was unreachable dead code (it type-checked, linted,
and passed the suite while doing nothing). The completed version merges the two into one
ladder: the bounded `recoverMediaError()` attempts (with the 2nd-attempt audio-codec swap) run
first, because transient decode hiccups elsewhere must not spin up ffmpeg; only when those are
exhausted — your diagnosed case, the stream provably valid but un-decodable — does it note the
transcode hint (`noteStreamNeedsTranscode`) and hand off via `tryFallbackForSilentAudio`,
mirroring the three sibling conversion branches (EC-3 audio, refused 400/403 segments,
double-stall). One correction to your guard: `url.startsWith('/__transcode/')` never fires in
LivePlayer (the prop is always the original `/live/...` path; the transcoded URL only ever
exists inside `getSourceUrl`), so the "already converted" check is `hasSession()` instead. A
run that is *already* on transcoder output and still exhausts recoveries shows "This channel
cannot be decoded on this device, and automatic transcoding failed." — no loop is possible
(the fallback's `triedRef` refuses a second conversion of the same run).

Verified live on the real failing channels (2026-09-19): "Newcastle United" raised four fatal
`mediaSourceRequiresReset` errors in two seconds, exhausted its recoveries, converted, and
played at 1080p through the transcoder — exactly one `/api/transcode/start`, no loop;
"Sunderland" in the same category plays directly and never triggers the path. (The follow-on
originally flagged here — the converted session's output later stalling with nothing recovering
it — is what v0.43.3 above fixed and then verified by killing ffmpeg under a playing session.)

**v0.42.1 — "Sessions that survive a deploy, and regressions paid off."** Nine releases (v0.35.0–v0.42.1)
of follow-up work, in the order it was needed:

- **v0.35.0** — sessions mirrored into SQLite so a recreate stops signing everyone out. Verified by
  signing in, forcing a recreate, and reusing the same cookie.
- **v0.36.0–v0.38.0** — a stalled transcode's `idle` shown in the System tab; a silent provider answering
  504 with a sentence on live as well as movies; the audio probe cached; and the provider's behaviour
  finally written down.
- **v0.39.0** — the audio/subtitle choice remembered per device, by language, applied once per stream.
- **v0.40.0** — four public guide presets, each fetched and verified; three of eight candidates were dead.
- **v0.41.0/v0.41.1** — the guide match broken down by source; source URLs shown in full after being
  truncated in code where no column width could reveal them.
- **v0.42.0** — favourite reordering and removal, both silently broken by v0.37.0's row change: the
  operations are matched against the *stored* list and were being given the resolved id.
- **v0.42.1** — a channel whose segments the provider refuses is converted rather than freezing.

**The lesson of the day**, worth more than any individual fix: of the four bugs found, **three were
regressions I had introduced** — the guide-URL truncation, and both favourites operations — and each was
found by the user rather than by me. The row that carried only the resolved id looked correct in every
test I wrote, because I tested the resolver and not the path from a row to a click or a drag.

A fifth, found during the v0.43.2 handoff, belongs to the same family and is the sharpest of them: a
conversion branch added *below* an existing `case` in the same switch — unreachable, therefore dead —
which type-checked, linted and passed all 447 tests. Nothing was wrong with the tests; nothing was
checking that the new code could run at all. Both gaps are closed in v0.43.4.

### The stretch before it (v0.34.1 and back)

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

- **Settle whether Safari's native pipeline takes HEVC-in-MPEG-TS — this decides everything else.**
  *Open, and the top of this list.* The provider's UHD feeds are HEVC Main 10, 3840x2160 at 50 fps,
  10-bit HDR, ~14-22 Mbps, with E-AC-3/AC-3 5.1 audio — and packed in **MPEG-TS** segments (measured
  2026-09-22; see the note below). Apple's own HLS authoring rules put HEVC in **fMP4**, so native
  Safari playback may refuse the container while happily decoding the codec. Two very different
  outcomes follow, and they need opposite work:
  - *If native Safari plays it* — nothing more to do; v0.46.3 already plays these untouched, at full
    quality, with hardware decode, and the re-encode tier is dead weight.
  - *If it refuses* — the fix is **not** a re-encode. It is the v0.44.1 machinery (a stream-**copy**
    remux into fMP4, which changes no pixels) applied *before* hls.js is ever attached: detect that
    the browser will not take this container and remux, rather than falling back to a JavaScript
    demux into MSE. That keeps full quality and full resolution.
  Wants one live observation on Safari to settle it.
- **Verify native playback live, and let it reach further.** *Open (v0.46.3, unverified).* Live TV now
  prefers the browser's own HLS pipeline wherever one exists — Safari has had one all along, and
  forcing hls.js instead is what put every HEVC / 10-bit HDR / Dolby stream through a JavaScript demux
  into MSE, and therefore what made transcoding look necessary at all. What is left: prove it against a
  real 4K feed (blocked — see the placeholder note above), decide whether the VOD/series player should
  prefer native the same way for HLS sources (it already uses a plain `<video src>` for direct files),
  and record what is given up on that path (the in-app audio/subtitle switcher is an hls.js facility;
  native playback delegates track selection to the browser).
- **Say "this channel isn't broadcasting" instead of looping.** *Open.* The provider currently answers
  every channel with a repeating placeholder behind a playlist that never advances (measured; see
  above). The app cannot tell that apart from a broken channel, so it spends its entire recovery ladder
  on it — reloads, session restarts, and one of the account's two provider connections per attempt. A
  non-advancing-playlist detector, plus a message that says so, turns a mystery black screen into one
  sentence. Wants one live browser reproduction first to pin the exact signal hls.js reports — worth
  measuring rather than guessing at, given how much of this project's history is exactly that.
- **A quality selector in the player.** *Open.* The re-encode tier's cap is an environment variable, so
  changing it means a redeploy, and since v0.46.3 its default is the honest one: keep the source's
  resolution. A per-device control (Source / 1080p / 720p) would let a viewer make that trade
  deliberately, when their own host cannot keep up, instead of the app making it for them. This is the
  piece of the "player settings that persist" item below that the UHD question actually needs.
- **Player settings that persist.** *Open (partial).* `TrackControls` lets you switch audio /
  subtitle tracks live, but the choice resets per session and there is no quality or
  subtitle-styling surface. Persist the selected tracks per saved profile and add a compact
  player-settings panel (playback quality, subtitle styling, visible fallback status).
- **Remember the audio-track probe.** *Open (small).* Since v0.34.0 the player asks the server what
  audio tracks a stream carries before deciding whether to transcode, so an E-AC-3-first channel does
  not play silently on Safari. That probe costs a round trip on every play of every channel; the
  verdict could be remembered per channel the way `lib/transcodeHints.ts` already remembers "this needs
  converting" — bounded, expiring, per device.
- **Retry a refused segment with a fresh playlist — the thorough fix for expired signatures.** *Shipped in
  v0.44.0.* Heavy channels (the ~6 Mbps EPL club feeds) relay their first segment and then get **400** for
  the rest of the same playlist: the provider's URLs are signed for roughly 25 seconds, and relaying makes
  each segment slow enough to fetch that the next one's signature has gone. v0.42.1 detected that and
  converted the channel, which sidestepped the cause rather than removing it. v0.44.0 does the real fix in
  the relay, where the tokens are consumed: every served playlist's segment window (URLs + media
  sequence) is remembered; a refused segment triggers one playlist refresh (shared across concurrent
  refusals, throttled to one per 2s), the refused segment is remapped by **absolute sequence number** into
  the fresh window, and retried exactly once — approximating what native players like TiviMate do by
  consuming only fresh signatures. Out-of-window segments pass the refusal through, and the client-side
  conversion remains as the backstop. Unit-verified with a signing-URL origin (recovery, slide-remap,
  out-of-window, stampede, no-window); live verification against a real heavy channel is pending the
  provider's return (it relayed a 4K Newcastle feed directly with zero refusals in the one window tested
  before the provider went down).
- **A video re-encode tier for HEVC-incapable browsers.** *Shipped in v0.45.0; resolution cap made
  opt-in in v0.46.3.* `videoTranscode: true` on /api/transcode/start re-encodes to H.264 (libx264,
  25 fps, CRF 23, yuv420p, an explicit 4s GOP), and the player's media-error ladder escalates to it
  once when a session exhausts its recoveries — the one case where the alternative is nothing on
  screen. **v0.46.3 reversed v0.46.0's default**: the output keeps the source's resolution unless
  `TRANSCODE_VIDEO_MAX_HEIGHT` asks otherwise, and a stall can no longer reach this tier at all.
  Preferred direction instead: native playback (live TV now prefers the browser's own HLS pipeline),
  which needs no transcode and loses nothing. What is left is operational: whether the escalation
  ever fires now that Safari plays natively, and the fact that a UHD re-encode on a small NAS is still
  not real-time if it does. The one hole deliberately left here — a *direct* relay that stalls (no session yet)
  exhausting its reloads and giving up rather than converting — **shipped in v0.46.2**, as the last
  rung of `stallRecoveryShape`.

### Measured 2026-09-22: the real streams, now that the provider is back

Everything the playback work depends on, measured through the deployed app against real segments
(ffprobe of fetched fragments):

| Channel | Video | Resolution / fps | Colour | Bitrate | Audio |
| --- | --- | --- | --- | --- | --- |
| Sky Sports Main Event UHD | HEVC Main 10 | 3840x2160 @ 50 | BT.2020 + PQ (HDR) | 14.2 Mbps | E-AC-3 5.1 640k |
| TNT Sports Ultimate 4K | HEVC Main 10 | 3840x2160 @ 50 | BT.2020 + PQ (HDR) | 13.9 Mbps | E-AC-3 5.1 640k |
| Sportsnet 4K | HEVC Main 10 | 3840x2160 @ 59.94 | BT.2020, 10-bit | 21.9 Mbps | AC-3 5.1 384k |
| Sky News HD | HEVC Main | 1920x1080 @ 50 | BT.709 (SDR) | 3.6 Mbps | E-AC-3 stereo 224k |

Three things follow directly:

1. **HEVC is not a UHD problem here — it is the whole provider.** Even 1080p news is HEVC, and every
   channel's audio is Dolby. A browser must handle both to play anything untouched.
2. **The relay carries 14-22 Mbps per UHD viewer** (every segment is relayed through this app, by
   design, to keep credentials out of the browser). That is a real, sustained load on the host and a
   real thing to surface in the System tab.
3. **A re-encode of this is hopeless on a small NAS** — 10-bit 4K at 50 fps, to H.264, in real time —
   which is exactly why v0.46.3's "play natively, never trade quality" direction is the right one, and
   why the fMP4 **remux** (stream-copy) is the tool to reach for if the native path needs help.

### Measured 2026-09-21: the provider serves a repeating placeholder on every channel

*This was a provider state, not a condition — the same account served real streams again on
2026-09-22, above.

Read this before chasing a playback bug that is not ours. Measured through the deployed app against
the live provider, sampling across unrelated categories (Sky Sports UHD / TNT Ultimate 4K, Sky News,
BBC One HD, Scripps, US local ABC/CW affiliates, NFHS, 24/7 channels):

- **Every channel returns byte-identical media**: one shared ~2-minute loop, 1920x1080 H.264 at
  ~435 kb/s, with **4 kb/s audio** (i.e. silent) — on both the HLS path and the raw `.ts` path. That
  is a provider-side placeholder, not content; "NFHS Network 2941: NO EVENT" is fairly self-describing.
- **The live playlist never advances.** Every refresh answers `#EXT-X-MEDIA-SEQUENCE:0` with the same
  segment indices (`0.ts, 1.ts, …`); only the containing token directory changes. hls.js cannot build
  a monotonic live timeline from that.
- The panel itself is healthy (`reachable: true, auth: 1, Active, 0/2 connections`) — which is why
  "the provider is down" is the wrong diagnosis and "the provider is serving a placeholder" is right.
- The deployed build at the time was **v0.44.1**, so none of the v0.45.0/v0.46.x work was even in play.
- **Open improvement:** the app cannot tell this apart from a broken channel — it runs its whole
  recovery ladder against the placeholder. A non-advancing-playlist detector, plus a message that says
  so, is the obvious next quality item; it wants one live browser reproduction to pin the exact signal
  hls.js reports before it is written.
- **Widen the undecodable-audio check beyond Dolby.** *Open.* The check that decides whether to convert a
  stream for audio reasons only considers `ac3`/`eac3`. Sunderland's feed carries **aac HE-AACv2**, which
  is a different question entirely and is not covered — the same blind spot the E-AC-3 fix closed for
  Dolby codecs, still open for everything else.
- **Say "the provider isn't responding" in the live player too.** *Partly done.* v0.31.0 made the
  server answer **504** with a sentence when the provider goes silent, and the *movie* player shows it.
  The live player still surfaces hls.js's own generic network error for the same condition, so a
  provider outage reads as an app fault on live channels.

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
- **Image bloat.** *Shipped 2026-09-17.* Every release leaves its predecessor behind — 48 images /
  44.7 GB on the NAS before anyone noticed, the same drift that caused the earlier disk-full incident
  (89 images / 55 GB). `scripts/dockhand-update.sh` now prunes unused images after a successful deploy,
  bounded so a Dockhand that stops answering cannot hold the script open; `PRUNE=0` skips it.
- **Expose a transcode's `idle` reading in the System tab.** *Open (small, high diagnostic value).*
  Tonight's hardest bugs were all visible as that one number: a session whose output nothing had fetched
  for 60+ seconds was a session nobody was watching. The server tracks `idleSeconds` and the admin health
  endpoint reports it; surfacing it in the UI would let the *user* see a stuck transcode rather than
  report a black screen.
- **The guide parse blocks the event loop for about four seconds.** *Open (measured).* A refresh keeps the
  app responsive at 12–20 ms, then stalls once for **3.9 s** while the parser runs. Not enough to explain
  the 502s of 2026-09-19 — those were an OOM crash loop — but on a slow day it is the difference between a
  spinner and a timeout. Parsing in chunks, or in a worker thread, removes it.
- **Parsing a ~97 MB gzipped guide into memory is the wrong shape.** *Open (design).* Node's default heap
  could not hold it, so the app died in an OOM restart loop that presented as *"the EPG is failing to
  load"* plus a 502 from the reverse proxy. The immediate fix was a 6 GB heap (v0.40.1), which is
  headroom rather than a fix: a streaming parse keeping only the channels it will match removes both the
  memory ceiling and the stall above.
- **A slow provider response reads as a failure.** *Open.* One category (`USA | Local Univision`) took
  **52 seconds** from a cold cache while its eight siblings answered in under four. The UI gives up and
  reports an error instead of *"this category is slow — still trying"*. A longer timeout for category
  fetches, with the loading state kept alive, is the same shape as the v0.31.0 fix for provider stalls.
- **The host now carries live video bandwidth.** *Worth documenting and measuring.* Live segments are
  relayed through the app (v0.33.0) rather than fetched by the browser from the provider's CDN, which is
  what removed the provider credentials from the browser and the dependence on the CDN accepting the
  viewer's address. The cost is real: every viewer's live stream now flows through the NAS. Worth a note
  in the README and a line in the System tab, so it is a known trade rather than a surprise.
- **Skip the multi-arch build for docs-only commits.** *Open.* Every push to `main` builds a full
multi-arch image (~13–20 min, arm64 `better-sqlite3` under emulation). `[skip ci]` in the commit
message is used by hand for documentation commits; a `paths-ignore: ['**.md']` on the workflow would
make that automatic and stop it depending on remembering.

### 4. Deployment

- **Reverse-proxy / TLS docs for non-Synology hosts.** *Open.* Document a Caddy or nginx setup
  for self-hosters running anywhere other than a Synology box with its own reverse proxy.
- **Write down what this provider actually does.** *Shipped 2026-09-19*, as a "What this provider
  actually does" section in the README covering the HLS-or-TS flip, the renumbered ids, the credentials
  in CDN URLs, the flapping panel and the two-connection limit. The original note: Several hours went into behaviour
  documented nowhere: channels answer their `.m3u8` URL with **either** a real playlist **or** raw
  MPEG-TS depending on the moment (Sky News does both); playlists contain **absolute CDN URLs carrying
  the account credentials**, signed for roughly 25 seconds; and the panel flaps with DNS and TCP fine
  but no HTTP response at all. A "known provider quirks" section in the README would save the next
  person — likely me — from rediscovering each one.
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

- **A duplicate switch case can no longer pass.** *Shipped in v0.43.4.* `no-duplicate-case` and
  `no-unreachable` are enforced, and CI runs `lint`, `typecheck` and `test` in a `check` job the image
  build depends on. The motivating defect: a conversion branch pasted below the live `case` of the same
  switch — dead code that passed type-checking, linting and the full suite, because lint carried only two
  rules and CI ran none of them.
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
- **A browser smoke check for the CSP.** *Shipped 2026-09-18* as `scripts/verify-csp-worker.mjs` (in the
  agent workspace, beside `verify-catchup.mjs`): it launches a real browser against a deployment, creates
  a `blob:` worker, and asserts it answers. Verified both ways — it passes against this app, and fails
  against a page carrying the old policy, quoting the browser's own "'worker-src' was not explicitly set"
  line. The original note: hls.js runs its demuxer in a `blob:` worker, and a policy without
  `worker-src` makes the browser refuse it — after which hls.js never starts and *every* stream hangs
  with one console line and no other symptom. Every server-side check passed while that was true. A
  script that loads the app in a real browser and asserts a `blob:` worker can be created **and answer**
  turns a silent multi-hour failure into a one-line result.
- **Verify on Safari, not only Chrome.** *Open.* The harnesses drive Chrome; the user's browser is
  Safari, and two of the four real bugs on 2026-09-17 were **invisible in Chrome** — the raw-TS path and
  the audio fallback, both of which Chromium handles better. The user's console has found two bugs no
  server-side check could. Anything asserted about playback should say which browser proved it.
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