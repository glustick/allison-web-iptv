# Roadmap

**Correction, 2026-09-21 (after v0.46.1).** Two entries below said live verification was pending
because "the provider has been down since 2026-09-20". That came from the 2026-09-20 session's own
notes and was carried forward without re-checking — the provider was back. What actually blocks the
live proof is deployment: the running deployment was still on v0.44.1, so no real channel had been
exercised against the v0.45.0 tier or the v0.46.x resolution cap. Those entries now say that instead.
Worth recording as a habit: a note inherited from an earlier session is a hypothesis, not a fact —
check it before repeating it into a release note.

Recommended enhancements for future development, refreshed **2026-09-23 against v0.53.0**.
Grouped by theme rather than a strict backlog — pick based on what matters most to whoever
picks this up next. See `README.md` for the full current state and `EFFORT-ASSESSMENT.md` for
the original scoping writeup this project started from.

## Current release

**v0.49.3 — remux only what the browser cannot decode.** The operator reported *"Sky News HD is not
playing smoothly"* — a regression from v0.48.0, which routed **every** HEVC live channel through the
container remux on the codec alone. A browser's MSE can decode **Main** (8-bit) HEVC and refuse **Main
10**, and that is the shape of the operator's machine: a 1080p channel that played directly and smoothly
was replaced by a remux with ~5.8s segments and an extra hop. The capability check compounded it by
asking only about Main 10 at level 5.3 — the UHD profile — so a 1080p feed was judged undecodable.

Measured before changing anything: the remux output is healthy (8.2s to start, segments in realtime,
ffmpeg at 8.5% CPU, correct 3.8 Mbps for a 3.6 Mbps source). The fault was in *choosing* it, not in it.
Now `canDecodeVideoCodec` asks about both HEVC shapes and answers yes if the browser takes either, and
the remux is used only when the browser genuinely cannot present the stream — or on the native-HLS
engine, which cannot present HEVC-in-TS at all. 497 tests; all gates green.

**v0.49.2 — the stats panel shows, and keeps out of the controls' way.** Reported on sight by the
operator: the Stats button sat **on top of** the native PiP and fullscreen controls, and the panel came
up **blank**. One cause: `.player-wrap` had no `position: relative`, so the absolutely positioned
overlays anchored to a different ancestor — the button over the control strip, the panel behind the
opaque video. Both now anchor to the player and sit top-right, away from the controls every browser
places along the bottom. *Verified by reading the stylesheet and the built CSS; not verified on screen,
because the deployed build is still the one with the bug.*

**v0.49.1 — client-side decoding, step one: the provider's own bytes come out of MPEG-TS.** The operator's suggestion, shipped as the next build: a **Stats**
button in the live player opening a panel that reports what the player is actually doing — engine in
use, stream codec and audio track count, presented resolution, played/buffered, dropped frames,
bandwidth estimate, and the browser's capability lines (native HLS, MSE+HEVC, WebCodecs 4K Main 10 with
the hardware path the platform chose). It subsumes the standalone decode probe page this file used to
plan, and it is the capability gate for the client-side (WebCodecs/NVDEC) direction below. Two rules
shipped with it: the panel **only runs while it is open** (one-second interval, cleared on close), and
**nothing is invented** — a capability the platform does not expose is shown as `unknown`. 486 tests;
typecheck, lint and both builds green.

**v0.48.2 — native or an error: the conversion offer is gone.** The operator's call, and the right one:
live TV plays natively or it reports that it cannot, and asks for another channel. Removed from the
client: the "Convert this channel" button, the media-error ladder's re-encode escalation, and
`stallRecoveryShape`'s `video-transcode` rung — so nothing in the player can reach the re-encode tier
any more, which on this host could not keep up with a 4K feed anyway (measured: ffmpeg pegged at
~400% CPU, one segment, then it falls behind). A remembered per-device "this needed the video tier" is
ignored for the same reason. The tier remains a server capability; the client does not call it.

Kept, and explicitly *not* a transcode: the container remux, which re-wraps the identical bitstream as
fMP4 so a browser with its own HLS pipeline (Safari) decodes it in hardware. Removing that would make
the UHD channels unplayable everywhere.

**v0.48.1 — a conversion that cannot succeed is no longer offered, and the notice stops guessing the
browser.** Found by using it: a Chrome user on the UHD channels got *"this browser cannot decode… Safari
plays it natively"* (an assumption, not a test), pressed **Convert this channel**, and landed back in the
same place — twice. Measured since:

- 4K10 HDR HEVC -> H.264 4K runs at **1.43x realtime on this Mac**, with hardware decode; 3.04x when
  downscaled to 720p.
- The same job on the NAS: ffmpeg pegged at **376-498% CPU**, **one segment produced**, then it falls
  behind the live edge and stalls.

**Downscaling is not a rescue**: the speedup is in the encoder, while decoding 4K10 at 50 fps is the
fixed cost, and the NAS does it in software. Chrome cannot decode these channels itself (no native HLS;
MSE + HEVC fails on the measured build), so **in Chrome the UHD channels are not watchable on this
server at any resolution**. The honest answer is the one the app now gives: a browser with its own HLS
pipeline (Safari) plays them untouched after the container remux, because then nothing on the server has
to decode anything.

**Open, and a product decision rather than an engineering one:** what Chrome users on this hardware
should be offered for UHD — a loudly-labelled low-resolution compatibility mode that still has to pay
the decode, or simply the truth. The evidence above says the decode is the wall, so the second is more
honest; the first is worth a measurement on the real box before it is dismissed.

**v0.48.0 — the UHD channels play video: HEVC live is remuxed, not re-encoded.** The complaint that
started this whole line — "the UHD channels don't play well" — is now explained and fixed, and it was
not what any of the intervening work assumed. The provider's UHD feeds are HEVC Main 10 in **MPEG-TS**
segments, and the macOS native pipeline **presents no video at all** for HEVC-in-TS: it plays the audio
track, reports `presentationSize 0x0` and zero decoded frames, and the session runs out around twenty
seconds in. That is the reported symptom, word for word. The same Mac decodes the same bitstream from
fMP4 without effort, so this is the container — and it is why v0.46.3's native-first change produced
*audio only* rather than a picture: the engine it prefers cannot read this container.

The fix is the cheapest one available and changes no pixels: **an HEVC live channel is routed through
the transcoder's stream copy** (`-c:v copy` into fMP4), re-wrapping the container into HLS both engines
present natively, at full resolution and bitrate. `needsStreamCopyRemux` (pure, unit-tested) makes the
decision from the video codec the probe already reports. 486 tests; all gates green.

**v0.47.0 — ask before re-encoding, and let the viewer decide.** Measured on 2026-09-22 by driving a
real browser into the deployed app and playing *Sky Sports Main Event UHD*: the relay carried the 4K
feed correctly (segments 0.6-3.1 s each, with the provider's intermittent expired-signature 400s that
v0.44.0's fresh-playlist retry handles), and then the app started a **transcode session** — 7.7 MB
written in 36 s, `idleSeconds: 24`, its output never consumed — because Chromium cannot decode HEVC
and nothing had asked that question beforehand. So the app's response to "this browser cannot play
this" was its single most expensive option, on the host that can least afford it.

- `probeTracks` now also reports the source's **video codec** (ffmpeg's own "Video: hevc (Main 10)" line,
  the same free source the audio/subtitle patterns already read), so the client knows *before* playback.
- `lib/videoCapability.ts` (pure, unit-tested) maps that to the question MSE understands and returns the
  browser's answer — optimistically: an unrecognised codec or a failed probe answers "yes", because a
  wrong "no" would block a channel that plays perfectly.
- The live player asks first. A "no" shows a plain sentence naming the codec and pointing at Safari,
  with **Convert this channel** as an explicit button. The media-error ladder's exhausted case now
  surfaces the same offer instead of escalating on its own.

479 tests; typecheck, lint and both builds green. *Not verified live:* the offer itself needs a look on
a real device — and the pre-flight's "yes" is not proof, since some Chromium builds claim hvc1 support
and then fail the append (v0.45.0's own measurement), which is exactly why the ladder still exists.

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

472 tests; typecheck, lint and both builds green. **Confirmed working 2026-09-22** — the operator
deployed it and reported UHD playback looking correct, on the real 4K feeds (the provider had returned
by then; see the note below). That is the live proof this entry was shipped without, and it is the one
that closed the UHD question this file had been circling since v0.44.1.

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

## Feature: multiple playlists (redundant Xtream profiles)

**Requested 2026-09-23 by the operator:** *"one provider can be unstable, I would like the capability to
configure two Xtream profiles or playlists for redundancy; show them both in the channel selection, but
give an option to sort or hide a playlist to avoid having 1000s of channels."*

### What already fits, and what does not

- **Storage is nearly right.** One Xtream profile per account lives in `users.iptv_credentials` as an
  encrypted blob (`SESSION_SECRET`, AES-256-GCM), and `providerLists.ts` already consumes credentials as
  a small struct (`{ server, username, password }`). "A playlist" is that struct plus an identity and a
  label — so the column can hold a **versioned envelope containing a list**, and the migration is a blob
  rewrite rather than a schema change.
- **The hard part is threading.** Every client-facing path is currently one provider: `/api/stream/...`,
  `/api/xtream?action=...`, the EPG endpoints, and — the subtle ones — the *server-generated* segment
  URLs inside relayed playlists (`/__fetch/<urlencoded upstream>`), the transcode sessions, and the
  search index built by `providerLists.ts`. Channel ids are **provider-scoped**, so two profiles can and
  will use the same numeric id for different channels: every id the client sees has to become
  `playlistId + ':' + streamId`, and every request has to carry which playlist it means.
- **Everything downstream of a channel id** has to learn the same thing or silently misbehave:
  favourites, watch history, resume positions, custom categories, timeshift, the search index, EPG
  matching, and the transcode hints. Denormalised name/category columns (already in the schema for
  exactly this robustness reason) are what make the migration survivable.

### Phases, smallest useful first

1. **Model + configuration.** Versioned envelope in `iptv_credentials` holding a list of playlists
   (`{ id, label, server, username, password }`), a settings UI to add/edit/test them, and the existing
   single-profile blob migrated into a one-entry list on first read. Nothing else changes yet — the app
   keeps using the first playlist, so this phase is invisible and safe.
2. **Browse with two sources.** Client-side channel identity becomes composite; the browse endpoints
   take a playlist id. Channel selection gains playlist **filter chips**, a per-playlist **hide** toggle,
   and a sort preference — the operator's explicit ask.
3. **Dedupe by channel, not by row.** The same channel on two playlists is one row with a source badge
   (matching on normalised name + category, since ids are provider-scoped), with both sources listed
   under it. This is the part that keeps "1000s of channels" from becoming "2000s".
4. **Failover.** When a stream fails on one playlist, retry the *matched* channel on another. This is a
   new rung in the recovery ladder, and it is where the provider-instability benefit actually lands.
5. **Everything else follows the primary**, with a per-account choice: EPG, search index, probes, and
   the update/health checks — one playlist is primary, the others are standbys unless a channel is only
   present on them.

### Decisions taken — 2026-09-23, by the operator

1. **Two genuinely different playlists**, not one provider on two lines.
2. **No automatic merging and no automatic failover.** Both are manual.
3. **The channel list must say where a channel came from — a Playlist column.** This is the affordance
   the whole feature hangs on: if the column is right, "the other line has this channel" is something the
   operator can see and act on themselves, and nothing has to guess on their behalf.
4. Sort and hide per playlist, as originally asked, so two catalogues do not become thousands of rows.

**What those decisions remove, and what they leave standing:**

- **Dedupe is out.** Different catalogueues with no merging means the default view shows both rows and
  the column tells them apart — simpler, and no heuristic ever hides a channel.
- **Automatic failover is out.** No ladder changes, no second provider connection opened behind the
  operator's back.
- **`channelMatchKey` survives, repurposed.** It was written to merge rows; with merging gone it becomes
  a *lookup*: given a channel on one playlist, find the same channel on another, for a **manual** switch
  ("also on Backup →"). That is the manual failover the operator asked for, offered rather than taken —
  and it keeps the region-tag normalisation (the `UK: Sky Sports…` case) doing real work.
- **The EPG question is now trivial:** each playlist has its own guide, and the guide follows whichever
  playlist the channel came from.

**Phase 1b, in progress.** The server half landed 2026-09-23 (v0.51.1): `resolveAccountCredentials`
resolves the **primary playlist** and returns the shape every caller already reads, so an account stored
in the old single-profile shape is unaffected — the same object, field for field, which is what the test
asserts (the failure mode being silent credential loss rather than a crash).

**Closed 2026-09-23 (v0.51.2):** the writers now route through `applyCredentialPatch`, so an
account-level save (guide URLs, alert webhook) merges into what the account carries and cannot disturb
the playlist list — with a test asserting exactly that on a two-playlist account. And every *read* now
goes through `credentialsFromStored`, because several callers used to decrypt the column themselves and
would have found no `server` on it once the blob became an envelope — a delayed breakage that wiring the
write path exposed.

**1b complete 2026-09-23 (v0.52.0):** the manager and the endpoints. `GET`/`PUT /api/iptv/playlists`
with the admin console's **Playlists** section — add, edit, remove, save whole-list. Passwords are never
returned (a row carries `passwordSet`; blank means keep), the list is merged into the envelope so guide
URLs and the alert webhook survive an edit, and a decrypt failure aborts the save instead of writing an
empty list over the account's configuration. Each server URL goes through the same external-URL checks the
guide sources use.

**Phase 2, next — the part that makes two playlists visible:** the browse layer carries a playlist
dimension (channel identity becomes `playlistId:streamId`), the channel list gains a **Playlist column**,
and hide/sort become per-playlist preferences held on the device (the same shape as the transcode hints,
which need no server support). The relay and the Xtream proxy must resolve credentials for the playlist a
request names rather than for the account. Then phase 3: the manual "also on…" switch. Then **phase 2**: the channel list carries a
playlist dimension (identity becomes `playlistId:streamId`), with a **Playlist column**, per-playlist
hide, and sort. Then **phase 3**: the manual counterpart switch. Phases of the earlier plan that the
operator's decisions removed — automatic dedupe and automatic failover — are deliberately not built.

**Phase 1 landed 2026-09-23 (v0.51.0), model only.** `src/server/lib/playlists.ts` parses a stored blob
as a list of playlists, migrates the legacy single-profile shape into one playlist ("Primary"), preserves
every account-level field it does not recognise (the blob is not only credentials — it carries
`epgUrls` and `alertWebhook` too), answers "which playlist does an unqualified request mean" with the
operator's own order rather than a flag that can disagree with it, hands out readable ids, and provides
the cross-playlist channel key. Thirteen tests, including the one that caught providers prefixing a
channel with a region tag (`UK: Sky Sports Main Event` vs plain).

**Deliberately not wired.** Nothing calls it yet, and that is the point: the credential read path
decides whether anything plays at all, so rewiring it goes with the configuration UI rather than being
bolted on. Next: phase 1b — a settings screen that reads and writes the new envelope, with the server
resolving credentials through `primaryPlaylist`, which keeps an existing account's behaviour identical
after migration. Then phase 2 (playlist-aware browse with filter chips, hide and sort).

## Open work

### 0. Client-side decoding, so the NAS never transcodes video

**The rule, decided 2026-09-22 on the operator's instruction:** *this NAS has no CPU headroom for
video transcoding, and demanding it overloads the box. If transcoding can be done at the client edge,
that is where it belongs — the client has an RTX 3080 Ti.*

The measurements back it: a 4K10 HDR HEVC -> H.264 re-encode runs at **1.43x realtime on a fast Mac
with hardware decode**, and nowhere near realtime on the NAS (ffmpeg at 376-498% CPU, one segment,
then it falls behind the live edge). So server-side video transcoding is off the table on this
hardware, permanently — and the client it would be competing with has an RTX 3080 Ti.

**It is an option per browser, because the two browsers need different answers:**

- **Safari** has its own HLS pipeline, and it handles HEVC-in-fMP4 natively (measured). With the
  container remux in front of it, Safari is already done — native playback, no client decode, no GPU
  work at all.
- **Chrome** has no native HLS *and* MSE cannot decode HEVC, so hls.js can never work here. But
  **WebCodecs can**: `VideoDecoder` with `hvc1` uses the platform decoder — NVDEC on the 3080 Ti — and
  there are two client-side routes from there, in order of preference:
  1. **Decode only, render to canvas** — decoded `VideoFrame`s draw straight to a `<canvas>`, so there
     is **no re-encode at all** and the picture is bit-exact with the source. A/V is synced manually
     against the MSE-fed audio.
  2. **Decode + re-encode on the client** — `VideoDecoder` (NVDEC) -> `VideoEncoder` (NVENC, H.264) ->
     MSE, keeping the existing pipeline. Costs an encode the GPU can do easily, but reuses everything
     else. Kept as the fallback if manual A/V sync proves too fiddly.
- **Dolby audio is the one piece that cannot move in either case.** WebCodecs' `AudioDecoder` has no
  AC-3/E-AC-3, and this provider's audio is E-AC-3 5.1 / AC-3 5.1. So the server keeps the audio-only
  re-encode its copy path already does (`-c:v copy -c:a aac`), which is an audio-only decode — trivial
  next to a 4K video decode. The video stays bit-exact.

**Measured 2026-09-22 evening, and this is the state to start from: no browser plays these channels
today.** Reported by the operator after v0.48.2 was deployed — Chrome shows the honest "cannot decode
hevc" error, and **Safari throws the same error**, which was the one path expected to work.

What the server saw during the Safari attempt (from the app's own health endpoint, not inferred):

- a **remux session did start** and produce a playlist, and the browser **fetched it for roughly
  thirteen seconds** before stopping (`idleSeconds` 131 of 141 running) — so the container-remux path
  was taken and playback began;
- an earlier ffmpeg exited with code 255 while reading the source
  (`Skip ('#EXT-X-PROGRAM-DATE-TIME…')`), which is logged and unexplained.

So the failure is in the **last hop — playing the app's own stream** — not in codec selection, and the
two candidates are:

1. **The earlier AVFoundation proof did not test the real shape.** It played a *VOD* playlist from a toy
   local server: container and codec controlled for, **playlist semantics and relay headers not**. The
   app serves a *live* playlist — rolling window, `delete_segments`, advancing media sequence — through
   its own relay. That gap is the first thing to close: run the same frame-counting test against a
   **real running session's live playlist**, captured exactly as the browser would receive it.
2. **The engine fallback may be manufacturing the error.** v0.46.3 made a native failure re-attach with
   hls.js — and for a HEVC channel hls.js can never work, so a native hiccup becomes the "cannot decode
   hevc" message on *both* browsers. That would explain the identical error on Chrome and Safari.

**A cheap product fix to fold in:** the two failure paths currently render nearly the same sentence, so
"same error as Chrome" tells us less than it could. Distinct messages make the next test
self-diagnosing.

**Step 1 landed 2026-09-23 (v0.49.1): the TS -> HEVC extractor works, verified against real bytes.**
`src/client/src/lib/tsHevc.ts` walks 188-byte packets, finds the video PID through the PAT/PMT, and
reassembles the PES payloads into Annex-B — which WebCodecs accepts with **no codec description**,
because Annex-B carries its parameter sets in-band. That is the whole reason the client can decode the
provider's own bytes with no ffmpeg, no remux, and no re-encode.

Two things it taught, both now pinned by tests:

- **`PES_packet_length` must be honoured, or TS padding (`0xff`) reaches the decoder as NAL data.** The
  first attempt failed here, and the *hand-built* fixture that was supposed to catch it was itself
  wrong: it split a PES down the middle, which no muxer does — real muxing fills every packet and pads
  only the last. Fixing the fixture to behave like a muxer made the parser's bug visible, which is the
  reverse of the usual order and worth remembering.
- **A raw elementary stream needs `-f hevc` to be decoded at all**, and ffmpeg's progress output starts
  at `frame= 0`, so "how many frames did it decode" is the *last* match, not the first. Both cost a
  debugging cycle.

Proof, not assertion: the suite generates a real HEVC transport stream with ffmpeg and decodes the
extracted stream again (frames counted), and the same test runs against a **real 7 MB 4K segment
captured from the provider** (set `UHD_TS_SEGMENT=/path/to/seg.ts` to exercise it) — where it extracts
parameter sets (VPS/SPS/PPS) and slices and ffmpeg decodes the result. Ten tests, all green.

**Step 2 shipped 2026-09-23 (v0.50.0): the decode check**, in admin -> System. It answers *how fast* and
*on which path* — fetch a live segment,
demux with the shipped extractor, decode with `VideoDecoder` as `hev1`, and report frames per second
while drawing decoded frames to a canvas. Hundreds of fps means the GPU is carrying it and the player is
worth building; single digits means a software path and a different decision.

**Still to build, in order:** wire the decoder into the player — canvas presentation with A/V sync
against the MSE-fed audio, the playlist/segment loop for live, and the capability gate (a startup probe
rather than a capability string, since a "yes" from `isConfigSupported` is not proof of throughput).

**Where the capability evidence actually comes from, and where it does not:** the operator's three
readings — `Native HLS pipeline: yes (maybe)`, `MSE accepts HEVC: yes`, `WebCodecs HEVC: yes` — were
taken **in Safari on their Mac**, not on the Chrome/Windows machine with the RTX 3080 Ti that this whole
direction exists for. So Safari is known-capable (all three pieces), the target machine is *unmeasured*,
and the decode check exists to measure it. Run it there first: a "yes" from `isConfigSupported` is a
capability, and a capability is not a throughput.

**Also open:** UHD still errors in Safari even though the container remux runs (measured 2026-09-22
evening: the session is fetched for ~13 seconds, then playback stops). That is the *last hop* — playing
the app's own fMP4 live output.

**The local AVFoundation harness is not evidence — stop using it for this.** Tried again on 2026-09-23
against the app's own live playlist, copied verbatim with every segment it listed and served with
correct content types: `Cannot Open`, zero frames — and the same result with `#EXT-X-ENDLIST` added to
rule out the playlist type. That is the **second false negative this harness has produced in two days**
(the first was the main-run-loop bug, which made every stream look dead). Meanwhile the same harness
played an ffmpeg-generated fMP4 VOD playlist without trouble, so it is not simply broken — it is
*unreliable*, and unreliable in one direction: it says "cannot play" about things that may be fine.

The lesson, recorded before it costs another evening: **when a hand-built reproduction disagrees with
the real thing, the real thing wins**, and the instrument to reach for is the app's own stats panel —
engine, presented resolution, buffered, dropped frames — read on the screen that is actually failing.
That is what to ask for next, not another local experiment.

**Next build, on the operator's suggestion (2026-09-22), and it replaces the standalone probe page:**
a **media stats panel** in the live player — a button that opens what the player is actually doing.
Every debugging session today needed a guess about the browser's side (which engine was used, whether
MSE took the append, whether decode was hardware or software), and each guess cost a round trip. A panel
makes each test self-diagnosing instead.

What it shows, and where each number comes from — deliberately only things that are real:

| Shown | Source | Why it earns its place |
| --- | --- | --- |
| Engine in use | `engineRef` (native / hls.js / WebCodecs once it exists) | The single fact that would have saved today: Safari silently fell back to hls.js, where HEVC can never work |
| Codec, container, declared resolution | the existing `probeTracks` result (video codec, audio tracks) | Says what the channel *is*, before any playback decision |
| Presented resolution and frame size | `videoWidth`/`videoHeight` on the element | Catches a black picture that is decoding fine (0x0 is the signature of the HEVC-in-TS case) |
| Video/audio bitrate | measured from the bytes the player actually received (hls.js fragment stats, or the relay's own accounting) | Distinguishes "starved by bandwidth" from "cannot decode" |
| Buffered / played / stalled seconds | `video.buffered`, `currentTime`, `playbackQuality` | The buffering story, in numbers |
| Dropped frames | `getVideoPlaybackQuality()` where available | Hardware decode that is *nearly* keeping up looks exactly like this |
| Decode path: hardware or software | `VideoDecoder.isConfigSupported({hardwareAcceleration:'prefer-hardware'})` for WebCodecs; for plain `<video>` there is **no API** — the panel must say "unknown" rather than guess | The honest version of "is the GPU being used" |
| Browser capabilities | `canPlayType` (native HLS), `MediaSource.isTypeSupported(hvc1)`, WebCodecs `isConfigSupported` at 3840x2160 | Three lines that make every future report unambiguous, and the go/no-go for client-side decoding |

**Build order for v0.49:**

1. **Media stats panel** (above) — capability lines first, then the live numbers. — a small page behind the app (`/uhd-probe`) that fetches a real fMP4
   segment from a running session, demuxes it, and runs `VideoDecoder` at the stream's own resolution
   (3840x2160 Main 10) while counting decoded frames per second. On the 3080 Ti this should read in the
   hundreds of fps on NVDEC; if it does, the rest is worth building, and if it does not, we have learned
   it in an hour.
2. **fMP4 sample demuxer** — `mp4box.js`, or a minimal parser for the single-video-track shape this
   transcoder emits (`hev1`/`hvc1`, one init segment, in-band parameter sets).
3. **Canvas presentation + A/V sync** (decode-only route), with the NVENC re-encode as the fallback.
4. **Capability gate** — `VideoDecoder.isConfigSupported(hvc1)` plus a short decode probe at startup, so
   a browser that cannot do this gets today's honest error rather than a black canvas.

**Capability gate, decided:** this is an *option where available* — never the only path. Native HLS
(Safari) keeps playing untouched; WebCodecs is the route for browsers without it, offered only when the
probe proves it can decode; otherwise the honest error stands.

**Target clients, confirmed by the operator:** the machine with the RTX 3080 Ti will most likely run
**Chrome or Brave**. Both are Chromium, so nothing about the plan changes — same WebCodecs path, same
absence of native HLS, same MSE+HEVC limitation. Two consequences worth building in from the start:

- **The probe must measure *speed*, not just support.** `isConfigSupported` answers "can this config be
  decoded", and on Windows that can be true through a *software* fallback (e.g. no HEVC Video
  Extensions installed) which would decode 4K Main 10 at a handful of frames per second. A capability
  check alone would then promise playback and deliver a slideshow. So the probe reports **decoded frames
  per second against the stream's real 3840x2160**, and only a comfortable margin over realtime (50 fps
  source; expect hundreds on NVDEC, tens on software) counts as "available".
- **Brave adds a variable Chrome does not have** — Shields and its fingerprinting protections. Neither
  touches WebCodecs or same-origin relayed fetches, so this should be a non-issue, but the probe runs
  in the real browser rather than assuming, and it is cheap to re-run if Brave misbehaves.

**Measured 2026-09-22, and this is the reference point: the fat client plays the UHD channels
perfectly** — smooth, good buffers, no stuttering (operator's report). The desktop sibling
(`~/Desktop/Development/iptv-app`) is a native player with hardware decode and it handles these channels
without help.

That settles three things at once:

1. **The streams are sound.** The provider's 4K10 HDR feeds are deliverable and playable; nothing about
   the source is the problem.
2. **The client hardware can decode them comfortably** — and it is the *same machine* that would run the
   WebCodecs path, which makes "can this GPU do it" close to answered by demonstration.
3. **The web player's failure is purely a browser-environment problem** — MSE's codec limits and the
   native pipeline's container limits — not a stream, network, or NAS problem.

And it means **UHD has a working client today**: the desktop app, with no NAS load at all. Worth saying
plainly, because the temptation is to keep building a server-side transcoder to solve something that is
already solved one layer up. The desktop sibling app (`~/Desktop/Development/iptv-app`) is the other obvious client:
a native player there can hardware-decode HEVC on the same 3090 and needs nothing from the NAS.

### 1. Live TV & playback

- **Log what ffmpeg actually said.** *Open, small, high value.* The transcoder keeps a character-limited
  *tail* of ffmpeg's stderr, and on 2026-09-23 that tail ended mid-`Skip(…)` line — so the error that
  explained fourteen-second session deaths was cut off, and finding it cost an hour of inference. Keep
  the error line (the first line matching a failure pattern), not just the end of the output.
- **A dead producer is not a stall.** *Open.* The client recovery ladder handles a *starving* player; a
  session whose ffmpeg has exited is a different thing, and the operator saw the result — the buffer
  draining to zero and staying flat with no message. The session's own state should be a first-class
  recovery case: detect it, replace it, or say so.

*Where to start next session:* the media stats panel (v0.49.0) is the first thing to deploy and use. On
a machine with the GPU, its WebCodecs line answers whether client-side decoding is real; in Chrome it
answers what Chrome is missing. The browser feature after that is the live-playback reproduction of
2026-09-22's failed attempt (see "Measured 2026-09-22 evening" above), then the WebCodecs player itself.

- **~~Settle whether Safari's native pipeline takes HEVC-in-MPEG-TS.~~ Answered 2026-09-22 — then
  answered again, better, the same evening: *no, for video.* The first answer ("yes, it plays") was read
  off a playhead that an audio-only stream advances just as happily, with the probe's own "no video
  track" line misread as a race. The fix shipped hours later as v0.48.0.** The provider's UHD feeds are HEVC
  Main 10, 3840x2160 at 50 fps, 10-bit HDR, ~14-22 Mbps, in **MPEG-TS** segments, and Apple's HLS
  authoring rules put HEVC in fMP4 — so the container was a real worry. Measured directly against the
  macOS media stack (AVFoundation, the engine Safari sits on), pointed at locally-served copies of
  real fetched segments: **both containers play**, HEVC Main 10 included — MPEG-TS advanced its
  playhead to 1.21 s with `keepUp=yes`, and the fMP4 remux of the same content to 1.29 s. So
  **no stream-copy remux is needed**, v0.46.3's native-first path is the right shape for these
  channels as they are, and the re-encode tier stays a last resort for browsers that genuinely cannot
  decode HEVC (Chromium). The harness is worth keeping: `swift` + AVFoundation against a local HLS
  origin answered in minutes a question that had been argued from documentation for a day — and the
  first version of it was wrong in a way that matters (see the note below).
- **Verify native playback live, and let it reach further.** *Confirmed by the operator 2026-09-22 —
  "UHD looks ok" — on the real UHD tier, with no transcoding.* Live TV now
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
- **A quality selector in the player.** *Partly addressed by v0.47.0.* Conversion is now offered
  rather than taken, so nothing reduces quality without being asked. *Open.* The re-encode tier's cap is an environment variable, so
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
- **The host now carries live video bandwidth.** *Shipped in v0.47.1.* Live segments are relayed
  through the app (v0.33.0) rather than fetched by the browser from the provider's CDN, which is what
  removed the provider credentials from the browser and the dependence on the CDN accepting the viewer's
  address. The cost is real, and now visible: every viewer's live stream flows through the NAS, the
  Active-transcodes table reports each session's average rate plus a total, and the measured UHD tier
  (2026-09-22) makes the number concrete at 14-22 Mbps per viewer. Documented in the README, so it is a
  known trade rather than a surprise.
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