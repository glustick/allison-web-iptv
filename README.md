# Allison Web IPTV

A self-hosted web service for Xtream Codes/M3U IPTV providers — a browser-based sibling of the
[AllisonIPTV](https://github.com/glustick/iptv-app) desktop app, for personal/household use
(not a public multi-tenant service).

See `EFFORT-ASSESSMENT.md` for the full scoping writeup this project started from.

## Current state (v0.51.0 — playlists, phase 1: the model and the migration)

**v0.51.0 lands the first piece of the multiple-playlist feature** the operator asked for — more than one
Xtream profile per account, for redundancy. This phase is the **model and the migration only**, and it
deliberately changes no behaviour: `src/server/lib/playlists.ts` reads a stored blob as a *list* of
playlists, migrating today's single-profile shape into one playlist labelled "Primary", and preserves
every account-level field it finds alongside the credentials (`epgUrls`, `alertWebhook`, and anything a
future build adds) so reading and writing back loses nothing.

Three things it settles, all tested (13 cases):

- **The stored object is not only credentials.** It also carries the guide URLs and alert webhook, so a
  migration that dropped unknown fields would silently take those with it. Unknown fields survive.
- **Parsing never throws.** It runs on the path that decides whether an account can play anything, so
  anything unreadable becomes "no playlists" rather than an exception.
- **Channel identity cannot be a stream id.** Ids are provider-scoped: two lines use different ids for
  the same channel and the same id for different ones. `channelMatchKey` matches on normalised name and
  category — and its first test immediately caught a real case, providers prefixing the same channel
  with a region tag (`UK: Sky Sports Main Event` on one line, plain on another).

**Deliberately not wired yet.** Nothing calls the new module. The credential read path is the one that
decides whether anything plays at all, and rewiring it belongs with the configuration UI, reviewed
fresh — not bolted on at the end of a session. That is the next step, and it is why this release is a
model rather than a feature.

## Current state (v0.50.0 — a client-side decode check, and the capability answer)

**The operator's stats panel reports `WebCodecs HEVC decode (4K Main 10, prefer hardware): yes` — but
that reading was taken in Safari on their Mac, not on the machine this direction is *for*.** It settles
that Safari has all three pieces (native HLS, MSE+HEVC, WebCodecs), which is worth knowing, and it
settles nothing about the Chrome/Windows box with the RTX 3080 Ti. That box is where UHD is meant to be
watched, so its capability lines and the decode-check number are still outstanding — and until they are
in, the client-side plan is a well-founded hypothesis rather than a measured one. (Corrected here the
same hour it was written: a reading from one browser on one machine is not a reading from another.)

**v0.50.0 adds the decode check to admin → System**: it runs the pipeline a client-side player would use
— fetch a live segment, demux it to Annex-B HEVC with the shipped extractor, hand it to `VideoDecoder`
as `hev1` — and reports **frames per second**, the number that decides whether a client-side player is
worth building (hundreds = the GPU is doing the work; single digits = a slideshow with a green tick
next to it). It draws decoded frames into a canvas, because a frame count with a black canvas would be a
lie of omission. Two limits are stated in the page itself: the whole stream is one chunk, so it measures
throughput rather than frame pacing, and a browser that cannot decode says so — it is a measurement, not
a fallback.

## Current state (v0.49.4 — the stats toggle sits clear of the controls)

**v0.49.4** moves the stats overlay down the player on the operator's own measurement (10% of the screen
height) — at the top edge the toggle sat over the browser's volume control. The toggle and the panel are
now one stacked container with a single offset, so they cannot cover each other and one number moves
both.

**Confirmed by the operator after v0.49.3:** Sky News HD plays smoothly again, the stats panel renders
properly, and the UHD channels still show the honest error — which is the remaining gap, and the reason
the client-side decoder is the next piece of work.

## Current state (v0.49.3 — remux only what the browser cannot decode)

**v0.49.3 fixes a regression I introduced in v0.48.0**, reported as *"Sky News HD is not playing
smoothly"*. The v0.48.0 rule routed **every** HEVC live channel through the server-side container remux
— on the codec alone. But a browser's MSE can decode **Main** (8-bit) HEVC while refusing **Main 10**,
and that is exactly the shape of the operator's machine: the 1080p channel used to play *directly* and
smoothly, and v0.48.0 replaced that working path with a remux that cuts ~5.8-second segments and adds a
hop through the NAS. Hence the stutter.

The capability check made it worse by asking only about Main 10 at level 5.3 — the UHD profile — which
is the wrong question for a 1080p feed. Now:

- `canDecodeVideoCodec` asks about **both** HEVC shapes this provider uses (`Main` and `Main 10`) and
  answers yes if the browser takes *either*.
- The remux is applied only when the browser genuinely cannot present the stream (or on the native-HLS
  engine, which cannot present HEVC-in-TS at all) — never merely because the codec is HEVC.

497 tests; typecheck, lint and both builds green. Measured before changing anything: the remux itself is
healthy (8.2s to start, segments in realtime, ffmpeg at 8.5% CPU, correct bitrate) — the fault was in
*choosing* to use it.

## Current state (v0.49.2 — the stats panel actually shows, and stays off the controls)

**v0.49.2 fixes the stats panel the operator reported broken on sight**: its toggle button sat on top of
the native PiP and fullscreen controls, and the panel itself came up blank. One cause, found by reading
the stylesheet rather than guessing: `.player-wrap` had no `position: relative`, so the absolutely
positioned button and panel anchored to a different ancestor entirely — the button landing over the
control strip, the panel behind the opaque video. Both overlays now anchor to the player, and both live
at the top-right, where no browser puts its controls.

## Current state (v0.49.1 — client-side decoding, step one: the provider's own bytes come out of TS)

**v0.49.1 lands the first piece of moving video work to the client** — the direction decided on
2026-09-22, because this NAS has no headroom for video transcoding and the client edge has a GPU.
`src/client/src/lib/tsHevc.ts` demuxes the provider's MPEG-TS segments down to the HEVC elementary
stream in Annex-B form, which WebCodecs' `VideoDecoder` accepts *without* a codec description, because
Annex-B carries its parameter sets in-band. No ffmpeg, no remux, no re-encode — and no server CPU.

Verified against real bytes rather than a hand-built fixture: the tests generate a genuine HEVC
transport stream and decode the extracted stream back (frames counted), and the same check runs against
a **real 7 MB 4K segment captured from the provider**, extracting VPS/SPS/PPS and slices that ffmpeg
then decodes. Ten tests, all green.

**Still to build:** the `VideoDecoder` loop on top of this extractor, canvas presentation with A/V sync
against the MSE-fed audio, and the capability gate. The media stats panel (v0.49.0) already reports the
WebCodecs capability line this depends on.

## Current state (v0.49.0 — a media stats panel: the player reports what it is doing)

**v0.49.0 ships the panel the operator asked for** — a **Stats** button in the live player that opens
what the player is actually doing, so the next "why is it black?" is answered by reading instead of by
guessing. It was motivated by exactly that: today's debugging needed three assumptions about the
browser (which engine ran, whether MSE took the append, whether decode was hardware or software), and
one of them (Safari silently falling back to hls.js) cost a release cycle.

The panel shows, and where each number really comes from:

- **Engine in use** — native HLS / hls.js, straight from the player's own state.
- **Stream video codec and audio track count** — from the on-play probe (`probeTracks`) that already
  runs for every channel.
- **Presented resolution** — `videoWidth`/`videoHeight`. A black picture that still *decodes* reads
  here as none, which is the signature of the HEVC-in-TS case.
- **Played / buffered ahead** — `currentTime` and `buffered`.
- **Dropped frames** — `getVideoPlaybackQuality()`, where the platform provides it.
- **Bandwidth estimate** — hls.js's own estimate, where the engine provides one.
- **What this browser supports** — native-HLS check, MSE+HEVC check, and `VideoDecoder.isConfigSupported`
  for 4K Main 10 *with* the `hardwareAcceleration` path the platform chose, which is the go/no-go for
  the client-side (WebCodecs/NVDEC) direction.

Two rules kept deliberately: **the panel only runs while it is open** (a one-second interval, cleared on
close — it must not compete with the thing it measures), and **nothing is invented**: a capability the
platform does not expose is reported as `unknown` rather than guessed.

486 tests; typecheck, lint and both builds green.

## Current state (v0.48.2 — live TV plays natively, or says it cannot)

**v0.48.2 makes the rule explicit, on the operator's instruction:** *"if the only option is native then
let's say that, no need to transcode — just give an error that the channel cannot be played, then
display an error and to select another channel."* So the live player no longer offers conversion at
all. A channel whose video this browser cannot decode now produces one sentence naming the codec and
telling the viewer to choose another channel; the **Convert this channel** button is gone, the stall
ladder can no longer reach a re-encode, and a remembered "this channel needed the video tier" (learned
back when the app still tried) is deliberately ignored.

What remains, and is deliberately *not* a transcode: the **container remux** (`needsStreamCopyRemux`) —
the same bitstream re-wrapped as fMP4, byte-for-byte unchanged, so a browser with its own HLS pipeline
can decode it in hardware. Removing that too would leave the UHD channels unplayable everywhere.

The video-re-encode tier still exists on the server (env- and API-reachable); nothing in the client
calls it.

## Current state (v0.48.1 — and what Chrome cannot do, measured)

**v0.48.1** stops the player presuming which browser the viewer uses, and stops offering a conversion
that cannot succeed. Reported live by a **Chrome** user on the UHD channels: the notice said *"Safari
plays it natively"* — an assumption, not a test — the **Convert this channel** button was pressed, and
the same dead end came back, twice.

The measurements behind the honest version:

| | throughput |
| --- | --- |
| 4K10 HDR HEVC -> H.264 4K, on this Mac (hardware decode) | **1.43x realtime** |
| the same downscaled to 720p | 3.04x realtime |
| the same job on the NAS | ffmpeg at **376-498% CPU**, **one segment**, then it falls behind the live edge and stalls |

So on this hardware a 4K re-encode cannot keep up — and **downscaling does not rescue it**: the extra
speed comes from the encoder, while the **decode** of 4K10 50fps is the fixed cost, and the NAS pays it
in software. Chrome cannot decode these channels itself (no native HLS, and MSE+HEVC fails), so in
**Chrome the UHD channels are not watchable on this server at all** — at any quality setting. The one
working client for them today is the **desktop app** (`~/Desktop/Development/iptv-app`), which plays the
same streams perfectly with no load on the NAS: a native player decodes HEVC-in-MPEG-TS that a browser's
HLS stack will not present.

The path that *does* work needs no decode: **Safari**, where v0.48.0's stream-copy remux hands the
browser fMP4 and the browser decodes HEVC in hardware. The notice now says that as a capability rather
than as advice about what the viewer is running, and a conversion that has already been tried shows
what happened instead of offering itself again.

## Current state (v0.48.0 — HEVC live plays at full quality: stream-copy remux, no re-encode)

**v0.48.0 fixes the video on the UHD channels, which v0.46.3's native-first path did not.** Measured by
counting **decoded video frames** rather than trusting a playhead: an audio-only stream advances a
playhead exactly as happily as a playing one, and the first version of this test said "PLAYED" about a
stream with **no video at all**. Counted properly, the macOS native pipeline presents **no video** for
HEVC in MPEG-TS — `presentationSize 0x0`, zero frames — while playing the audio track, which is
precisely the reported symptom (*"only playing audio... no video, then both audio and video is blank
after around 20 seconds"*). The same Mac decodes the *same bitstream* from fMP4 without effort (28
frames at 3840x2160), so this is the container — and Apple's HLS rules are explicit that HEVC belongs
in fMP4. The fix is the cheapest one available: **an HEVC live channel now goes through the
transcoder's stream copy**, which changes the container and not one pixel of the video, into HLS that
both engines present natively. No re-encode, no resolution change, no quality loss. 486 tests; all
gates green.

**v0.47.0** stops the app deciding to re-encode on the viewer's behalf. Playback now **asks whether
this browser can decode the channel's video before playing it**: the server's existing on-play probe
reports the video codec (every channel this provider serves is HEVC; the UHD tier is Main 10), and
`canDecodeVideoCodec` (pure, unit-tested) puts that to the browser's own media stack. When the answer
is no, the player *says so* — "this browser cannot decode the video this channel uses; Safari plays it
natively" — and offers a **Convert this channel** button instead of starting a transcode. The same
applies when the ladder fails later: the media-error path's last resort is now that same offer, not an
automatic escalation.

The reason is the one the user gave, in their words: re-encoding changes the picture, so it is the
viewer's trade to make, not the app's. It is also, on a 10-bit 4K feed at 14-22 Mbps, the heaviest
thing the host can be asked to do — and the app's own browser test (2026-09-22, Chromium, Sky Sports
Main Event UHD) measured exactly what that costs: a transcode session started, 7.7 MB written in 36
seconds, and its output never consumed, because the browser could never have played it. 479 tests;
typecheck, lint and both builds green.

**v0.46.3 changes direction, because the last three releases were aimed at the wrong thing.** Two
things were true — no NAS CPU re-encodes 4K in real time, and a heavy channel can stall a relayed
session — and neither should have been solved by the picture. v0.46.0 let the re-encode tier downscale
a channel by default, and v0.46.1 let a stutter push a viewer onto that tier. Both traded **picture
quality for smoothness, unasked**, on a player whose job is to show the stream the provider sent.

- **Live TV now uses the browser's own HLS pipeline wherever it has one** — `prefersNativePlayback`,
  pure and unit-tested. Safari has had one all along behind the same MIME type HLS has always used,
  and it is the route a native player like TiviMate takes: the container goes to a decoder that
  understands it, with hardware decode and no transcoding at all. Live TV was previously driven
  through hls.js wherever MediaSource existed, which is what forced every HEVC/HDR/Dolby stream
  through a JavaScript demux and into MSE. Chromium has no native HLS, so nothing changes there; a
  native failure re-attaches with hls.js once, so the worst case is the old behaviour one retry later.
- **The re-encode tier no longer caps resolution by default** — opt in with
  `TRANSCODE_VIDEO_MAX_HEIGHT`. It exists to make a stream the browser cannot decode *playable*, at
  the quality the provider sent, not to reshape a channel the browser can play.
- **A stall never escalates to a re-encode.** v0.46.1's escalation is gone: a stalled session is
  replaced in the shape it already has. The tier remains the media-error ladder's last resort (v0.45.0),
  where the alternative is no picture at all.

472 tests; typecheck, lint and both builds green. *Later corrected:* the operator first reported the
UHD channels "looking ok", then — watching properly — found they played **audio only, no video, going
blank after around twenty seconds**. The cause and the fix are v0.48.0, above. The "confirmed" note
that briefly sat here was an over-optimistic first look, and is recorded as such rather than deleted.

**v0.46.2** closes the last hole in the ladder v0.46.1 opened. A **direct** stream — the provider's own
feed, relayed — that stalled through every reload it was allowed ended in the terminal error, while
every other reload path in this app (a refused segment, two `BUFFER_STALLED` errors) converts the
channel instead. That was the one place a heavy channel could die without the transcoder ever being
offered. `stallRecoveryShape` now decides the whole rung set — `reload` → `convert` → `session` /
`give-up` (the `video-transcode` rung it briefly added was removed again in v0.46.3, above) — and a
direct stream is converted to the **cheap copy
tier** once its reloads are spent; nothing there claims the video is undecodable, and a session that
then goes on to stall escalates a rung by itself. 473 tests; typecheck, lint and both builds green.

**v0.46.1** is the other half of the same problem: the stall ladder could not *reach* the tier
v0.46.0 had just made affordable. hls.js's own reload paths already end in the transcoder — a refused
segment (400/403) converts the channel, two `BUFFER_STALLED` errors convert it, and v0.45.0 taught the
media-error ladder to escalate to the video tier — but the backgrounding watchdog's stall rung did
not: it rebuilt the source, or replaced a dead session with **the same shape**. So a heavy 4K channel
whose stream-copied session kept starving itself was handed another 4K stream-copy, again and again,
until the ladder gave up. That is measurably the shape behind *"the UHD channels don't play well"*,
with the tier that fixes it never reached. `stallRecoveryShape` (pure, unit-tested) now decides the
shape: a repeatedly-stalling **copy** session escalates to the video re-encode tier once — a quarter
of the pixels, and a bitrate the host can actually sustain — after which that rung retires and the
session is replaced in place exactly as before. A run that is not on a transcode session is untouched.
470 tests; typecheck, lint and test all green.

**v0.46.0** closes the gap v0.45.0 left inside the re-encode tier itself: **resolution**. Capping the
framerate while leaving the resolution alone meant a UHD (3840x2160) channel was re-encoded *at 4K* —
and no NAS CPU re-encodes 4K in real time, so the session fell behind the live edge and the viewer saw
a stream that never caught up. That is the shape behind *"the UHD channels don't play well"*, while
TiviMate plays them because it decodes HEVC in hardware and never re-encodes at all. The tier scaled
to **1080p by default** — `scale=-2:'min(1080,ih)'`, a *cap* rather than a resize, so a 720p or 1080p
channel passes through untouched and nothing is ever upscaled — which is about a quarter of the
encoder's work and the shape every plain channel already plays. **v0.46.3 made that opt-in rather than
the default** (see the top of this file): downscaling a channel to spare a slow host is the operator's
decision to make, not something a viewer should discover. `TRANSCODE_VIDEO_MAX_HEIGHT` sets it (unset,
as it now is by default, keeps the source's own resolution) and `TRANSCODE_VIDEO_MAXRATE_KBPS` adds an optional capped-CRF
bitrate ceiling for a host whose *network* rather than its CPU is the limit. The copy path still emits
none of it. Proven three ways: argv-level tests for the cap, a lowered cap with a ceiling, and
the untouched copy path; pure tests for the env parsing (`0`, empty and garbage all mean "no cap"
rather than a broken encode); and a real-ffmpeg integration test that pushes a taller synthetic source
through the tier and reads the output's actual dimensions back — the check that catches a malformed
`min(1080,ih)` filtergraph, which would otherwise kill every re-encode the moment it shipped. 466
tests; typecheck, lint and test all green.

**v0.45.0** closes the per-browser wall v0.44.1 left behind. Some Chromium builds answer
`isTypeSupported(hvc1)` → true and then fail the actual append (`mediaSourceRequiresReset`) — so a
session that stream-copies HEVC can never play there, no matter how many times it recovers. This
release adds the last tier: `videoTranscode: true` on `/api/transcode/start` re-encodes the video
with libx264 (~25 fps, CRF 23, 8-bit yuv420p so the 10-bit HDR feeds land somewhere Chromium's MSE
will accept), and the player's media-error ladder reaches it — a session that exhausts its
recoveries and still cannot decode is replaced once by a re-encoding session, then gives up with the
message it always gave. The requirement is *remembered per device*, so the next play of that channel
goes straight to H.264 instead of paying for a copy session it will abandon. Two things the real
binary taught, both pinned by tests: the HLS muxer only splits a segment at a keyframe, so libx264's
default ~10s GOP left the first segment unclosed until the input was nearly over — measured against a
throttled source the session's playlist never appeared at all until EOF, which for a live channel
means forever — hence an explicit 4s GOP matching `-hls_time`; and the plain copy path still emits
none of this. 460 tests; typecheck, lint and test all green. *Not yet verified live:* the tier's
encode throughput on a NAS CPU, and the escalation against a real HEVC channel — both need a
deployment actually running this build. (This entry and two others originally blamed a provider
outage; that was wrong — see the correction note at the top of `ROADMAP.md`.)

**v0.44.1** makes the Sky Sports/EPL family (HEVC video + E-AC-3 audio — unplayable natively
in any browser, native in TiviMate-class players) actually work through the transcode
fallback: output moved from MPEG-TS to fMP4 segments (a stream-copied HEVC stream is
undecodable by Chromium's MSE in TS, decodable in fMP4 — measured), the transcode file
server learned to serve the init segment the playlist references (its absence 404'd the
player's very first fetch and churned every session), and the audio keeps its source channel
layout (5.1 stays 5.1 AAC 384k) instead of folding to stereo. One caveat measured live:
some Chromium builds claim HEVC support and fail the actual decode — on browsers with real
HEVC support (Safari; Chrome with working hardware decode) these channels play; the rest are
served by v0.45.0's video re-encode tier above.

**v0.44.0** fixes the root cause behind the heavy-channel conversions in the relay itself: when
the provider's ~25-second signed segment URLs expire mid-playlist (the measured 400/xxx pattern
on the ~6 Mbps EPL feeds — native players like TiviMate never see it because they always consume
fresh signatures), the relay now remembers each served playlist's segment window, refreshes the
playlist once on a refusal, remaps the refused segment by absolute sequence number, and retries
it — one shared, throttled refresh per playlist, one retry per segment, out-of-window refusals
passed through, and the client-side conversion retained as the backstop. Five new unit tests
against a signing-URL origin (453 total, all green). Verified live in the one healthy window
before the provider's 2026-09-20 outage: a 4K EPL feed relayed directly, zero refusals, zero
transcodes; the retry path's live proof resumes when the provider does.

**v0.43.4** made the release gate a gate (lint, typecheck, tests must pass in CI before the
image builds).

**v0.43.4** closes the two gaps that let a dead conversion branch reach a tag.
`eslint.config.mjs` now enforces `no-duplicate-case` and `no-unreachable` — a duplicate `case` below the
live one is unreachable code that type-checks and passes tests (measured, not theorised) — and CI runs
`lint`, `typecheck` and `test` in a `check` job that the image build depends on. Until now the workflow
only built and pushed, so a release with failing tests published anyway.

## v0.43.3 — a dead transcode session no longer freezes the channel

**v0.43.3** closes the recovery holes found when the converted club channels still froze in
real testing: a transcode session whose playlist exhausts its network retries is now replaced
immediately at the moment of failure (a dead session replayed can only re-freeze — verified
live by killing ffmpeg under a playing session: five errors, session replaced, playback
material restored within ~25 seconds); a stream that stops loading while the viewer has it
paused is detected and repaired in the background after three minutes of zero fragments
(pausing mid-buffer used to hide the stall until the buffer played out); and a player run that
never produces a fragment is treated as dead after 90 seconds instead of being ignored as
"startup" forever.

**v0.43.2** completes the club-channel ladder: a fatal `MEDIA_ERROR` that exhausts hls.js's
bounded `recoverMediaError()` attempts now notes the transcode hint and converts the channel
through the transcoder — the same route EC-3 audio, refused segments, and double-stalls already
take — instead of freezing on "gave up after 3 recovery attempts". (The branch had been left as
unreachable dead code: a duplicated switch case below the live one, which JavaScript never
reaches.) Verified live on the real failing channels: "Newcastle United" raised four fatal
`mediaSourceRequiresReset` errors, converted, and played at 1080p; "Sunderland" plays directly
and never needed it.

**v0.42.2–v0.43.1** — favourite reordering actually drags in Safari (v0.42.2); a stream that
stalls twice without an HTTP error converts rather than freezing, since a frozen picture raises
nothing but a non-fatal stall warning (v0.43.0); and the reordering UI points at where
reordering lives and offers to switch there (v0.43.1).

Nine more releases since v0.34.1, mostly cleaning up after the work that made every channel type play —
and one that finally removes an irritation present since the first deploy.

**v0.35.0 — sessions survive a restart.** They lived only in a memory map, so every recreate signed
everyone out; on the day above that cost real time repeatedly. `auth_sessions` now mirrors the map into
SQLite, with the token encrypted under `SESSION_SECRET` and only its hash indexed. The map is still the
hot path and the store is touched at most once a minute.

**v0.36.0–v0.38.0 — finishers.** A stalled transcode's `idle` reading is visible in the System tab (the
number that explained every hard bug on 2026-09-17); a provider that goes silent answers **504 with a
sentence** on live channels as well as movies; the audio-track probe is cached per session; and the
README gained the *"what this provider actually does"* section that would have saved most of that week.

**v0.39.0 — the audio and subtitle choice is remembered**, per device (which browser can decode what is a
property of the browser), by language rather than index, applied once per stream, and with *subtitles off*
stored as the choice it is.

**v0.40.0 — public guide presets, verified rather than remembered.** Four URLs, each fetched and checked;
of eight obvious candidates, three were dead and one answered 200 with an empty body.

**v0.41.0/v0.41.1 — the guide match broken down by source**, and source URLs shown in full: they had been
truncated *in code*, so widening the column could never reveal the rest.

**v0.42.0/v0.42.1 — favourites reordering and removal fixed**, both silently broken by the row change that
made a renumbered favourite play; and heavy channels (~6 Mbps club feeds) whose segments the provider
refuses are converted automatically rather than freezing a second in.

### Earlier (v0.34.1 and back)

**v0.34.1** closes the last gap in the playback path. Channels the provider serves as **raw MPEG-TS**
rather than HLS — Sky News FHD and HD — now play: the client sniffs the first bytes, recognises the TS
sync byte, and routes those streams through the transcoder instead of handing them to hls.js, which
could never have parsed them. **v0.34.0** fixed the same kind of blind spot for audio: the
silent-audio fallback is driven by `webkitAudioDecodedByteCount`, which exists **only in Chromium**, so
E-AC-3-first channels (Sky Atlantic, Sky One) played silently in Safari and nothing ever recovered. The
client now asks the server what tracks a stream carries and decides *before* playing.

**v0.33.0/v0.33.1** moved live segments **through the app** rather than letting the browser fetch the
provider's CDN directly. The provider writes absolute CDN URLs — with the account credentials in them —
into its playlists, so live playback was putting those credentials in the browser, depending on the CDN
accepting the browser's address (the 400s seen when segments were refused), and racing a ~25-second
signed URL. Segments are relayed now, and a raw-TS response is piped straight through rather than
buffered.

**v0.27.0** was the one that mattered most, and it is the smallest: the Content-Security-Policy had no
`worker-src` directive, so the browser refused the `blob:` worker that hls.js builds its demuxer in.
hls.js therefore never started and **every** stream it handled hung — with nothing in the console but a
single line about worker-src. It was found by reading the browser console, after hours of eliminating
the provider, the reverse proxy, buffering, mixed content and CORS.

**v0.28.0–v0.30.0** fixed a catch-up that could never play. The effect that starts the archive transcode
also stops it in its cleanup, and its dependencies were whole objects plus the session client, so any
unrelated re-render restarted the session — measured as a new transcode every 12 seconds, for as long
as the viewer stayed on the channel. A second loop came from the fallback hook "converting" the
transcoder's own output. **v0.22.0** added the per-title transcode memory; **v0.31.0/v0.31.1** made a
silent provider say so (504 and a sentence) and stopped a deploy's image prune holding the script open.

### Earlier (v0.23.0 and back)

**v0.23.0** adds the two things that only matter when something is wrong. **App-health alerts** post
to the same Discord webhook as the provider watchdog when the *app itself* is in trouble — a full
disk or an unwritable database, the two failures that have actually taken this deployment down —
because both were previously visible only to someone already looking at the System tab. And a
programme that is **still on air** can be **restarted from its beginning**: double-click it (or
Shift+Enter on a focused programme) and the archive serves it from the start, which is the whole
point for live sport.

**v0.22.0** remembers which streams need converting. Sky News FHD carries E-AC-3 first (undecodable
in Chrome) and *Batman Begins* is E-AC-3 5.1 inside Matroska: both played **nothing for ten to
thirty seconds** before the fallback noticed — on every single start. The fallback now remembers, so
the second play goes straight to the transcoder.

**v0.21.0** lets the watchdog post to **several Discord channels** at once (comma- or
newline-separated, deduplicated; a mistyped destination is refused when you save it rather than
discovered during an outage) and says how many accepted each alert. **v0.20.0** moves the sign-in
audit trail into SQLite so it survives a restart, and lets ↑/↓ move focus from a programme to the
same column in the adjacent row. **v0.19.0** adds **keyboard navigation** to the guide (arrows pan a
quarter hour and scroll a row, Home returns to now), **series favourites**, and the sign-in **audit
trail** itself. **v0.18.0** fixes **catch-up in Safari**: a timeshift stream is raw MPEG-TS, which
hls.js cannot parse and Safari cannot decode at all, so the browser is handed this app's own HLS
output instead. **v0.17.0** ships **catch-up playback** — and fixes a real bug it exposed: the guide
had been capturing the pointer on *every* press since v0.12.0, which retargeted compatibility mouse
events and made **every click on a programme do nothing**. **v0.16.0** opens **EPG, Admin and
System in their own tabs**, so opening configuration no longer stops whatever is playing.
**v0.15.0** adds the **provider watchdog** and its Discord alerts; **v0.14.0/v0.14.1** add a
Favourites guide/list toggle and a notice when a session is ended by a deploy.

### Earlier (v0.13.0 and back)

**v0.13.0** makes the guide drag-scrollable in both directions — left/right slides the window
through time, up/down moves the channel list, 1:1 with the pointer — and fixes the category
sidebar's resize handle, which had been sitting *inside* the panel's own scroll container: clipped
by that panel's overflow and, with a non-overlay scrollbar, underneath the scrollbar, so the
scrollbar took the pointer. The handle now lives in the content column and straddles the divider,
where nothing can cover it.

**v0.12.2** refuses to start — and stops — a transcode that would fill the disk: 8 GB free for a
film (it keeps every segment so you can scrub), the database's own 256 MB floor for a live channel,
and every session is stopped below 256 MB, because a full disk breaks SQLite first.
**v0.12.1** stops a transcode when its viewer goes away: the player says goodbye on unmount and
sends a beacon when the page hides, and the server independently stops any session whose output
nothing has fetched for two minutes. **v0.12.0** added drag-to-pan the timeline and made the panel
title name the category it is showing. **v0.11.1** fixed the live transcoding fallback, which had
been dead since the credential change below. **v0.11.0** took the **provider password out of the
browser entirely** — playback goes through the server's own session-authenticated `/api/stream/…`
and `/api/xtream` routes, so it no longer appears in URLs, in browser history, or in a
reverse proxy's access log.

### Much earlier (v0.10.0 and back)

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

## Security

What protects the deployment, and the knobs available:

| Area | Behaviour |
| --- | --- |
| Passwords | scrypt-hashed with a per-user salt |
| IPTV credentials | AES-256-GCM encrypted at rest under `SESSION_SECRET`, and **never sent to the browser**: the server addresses the provider itself through `/api/xtream` and `/api/stream/…`, so the password appears in no URL the client makes (not in history, not in devtools, not in a reverse-proxy access log) |
| Sessions | HttpOnly, `SameSite=Lax`, `Secure` **when the request arrived over TLS**, 24 h idle expiry, revocable per session from the admin console |
| Sign-in throttling | per **address** and per **account**; a lockout backs off (5 min, doubling, capped at 1 h) |
| Response headers | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, a CSP that blocks inline script/objects/framing, and HSTS over TLS |
| Outbound fetch | the transcode endpoints only fetch URLs on the configured provider's origin; EPG guide URLs are checked and loopback/link-local/cloud-metadata addresses are refused |
| Audit | active sessions with role, login time, duration and now-playing on the admin console; recent server errors on the System page |

Environment knobs:

- `TRUST_PROXY` — defaults to trusting `X-Forwarded-*` from private/loopback sources only (correct behind Docker port mapping or a reverse proxy). Set `TRUST_PROXY=false` if the app is exposed directly, so those headers can't be spoofed to evade throttling.
- `SESSION_SECRET` — 16+ characters, and changing it makes stored IPTV credentials undecryptable (accounts are unaffected).
- When changing the provider server or guide sources, the settings form can be saved with the password **left blank** — a blank field means "keep the stored one", since the password can no longer be read back to the browser.

Worth doing outside the app: keep it off the public internet where possible (Tailscale/WireGuard, or an IP allowlist at the reverse proxy), enable HSTS and modern TLS at the proxy, and treat a downloaded database backup as sensitive — it contains every account.

### Container hardening

The image now runs the server as an **unprivileged user** (`node`, uid 1000), and the reference
`docker-compose.yml` adds the container-level settings worth pairing with that: a **read-only
rootfs**, a small `tmpfs` for scratch files, `no-new-privileges`, and **all capabilities
dropped**. Verified with the real image: `id` reports `uid=1000(node)`, `docker inspect` shows
`ReadonlyRootfs=true` and `CapDrop=[ALL]`, and a full transcode still completes.

**Updating an existing install** — an `./appdata` directory created by an earlier build (which
ran as root) is owned by root, and the server now writes as uid 1000. If the container starts and
logs that the data directory is not usable, that is why; the log says exactly what to run:

```bash
sudo chown -R 1000:1000 ./appdata ./transcode
```

Alternatively start it once with `user: "0:0"` in the compose file: the entrypoint repairs
ownership of both directories and then drops back to uid 1000 for the server itself. Leave that
commented out once the permissions are correct.

### Transcode storage — `TRANSCODE_TMP_DIR`

ffmpeg writes HLS segments to `TRANSCODE_TMP_DIR` (default: the OS temp dir, i.e. `/tmp`; the
reference compose points it at `/transcode`, backed by `./transcode`). **Size this volume**: a
*VOD* session keeps every segment it produces, for as long as it runs, so the viewer can scrub
anywhere in the film — a 2h20 feature at ~10.7 Mbps is well over 10 GB, not the few hundred MB a
live-TV fallback would suggest. The **System** tab shows the directory, its free space, and how
much each live session has written; live TV is unaffected (it keeps a small rolling window).
Stale session directories left by a killed container are swept at startup.

### The re-encode tier's output shape — `TRANSCODE_VIDEO_MAX_HEIGHT`, `TRANSCODE_VIDEO_MAXRATE_KBPS`

The re-encode tier exists for exactly one case: a browser that **cannot decode** the source's own
video, where the alternative is no picture at all. It is not a way to reshape a channel the browser
*can* play — since v0.46.3 its output keeps the source's own resolution by default, and a stall never
reaches it. Both knobs below are for an operator whose **host** genuinely cannot keep up, and both are
deliberate trades:

- `TRANSCODE_VIDEO_MAX_HEIGHT` — **off by default**. Set a height to cap the output
  (`scale=-2:'min(<height>,ih)'`, which never upscales, so a shorter channel passes through
  untouched). This trades picture for CPU headroom, and 4K re-encodes are genuinely beyond a small
  NAS — so if a UHD channel stutters, prefer letting the browser play it natively at full quality over
  capping it here.
- `TRANSCODE_VIDEO_MAXRATE_KBPS` — off by default. When set, the re-encode becomes capped-CRF
  (`-maxrate`, with `-bufsize` at twice that), bounding what each viewer pulls through the host.

Both apply to the re-encode tier **only**: a channel the browser can decode is stream-copied at the
source's own resolution and bitrate, with none of these flags emitted — and on a browser with native
HLS support (Safari) live TV now plays with no transcode at all.

### The guide is drag-scrollable in both directions

Grabbing the EPG — its time ruler, any channel row, or a channel name — moves it: **left/right slides
the window through time** (snapping to quarter hours), **up/down moves the channel list**. A gesture
commits to one axis, so a diagonal drag cannot both jump the time window and scroll the list, and a
drag never doubles as the click that selects a channel. The category sidebar is drag-resizable like
the guide's own channel column, and its handle deliberately lives in the *content* column rather than
inside the sidebar: the sidebar is a scroll container, so a handle inside it gets clipped by its own
overflow and — with a non-overlay scrollbar — sits underneath that scrollbar, which then takes the
pointer.

### A transcode stops when its viewer goes away

A session used to end only when the client asked it to, so anything that stopped the client from
asking — a closed tab, a reload, another tab, a laptop lid, a container restarted underneath it —
left ffmpeg writing segments indefinitely. That is worse than the wasted disk: **a live transcode
holds one of your provider's concurrent connections**, so orphans could starve real playback.

Two things now prevent it. The player stops its session when it unmounts and sends a beacon when
the page goes away; and the server independently stops any session **whose output nothing has
fetched for two minutes** (`TRANSCODE_IDLE_STOP_SECONDS` tunes this), logging the reason and
removing its directory. The idle check only applies once a session has a playlist, so the slow
starts that the start deadlines exist to allow are never mistaken for an abandoned one. The
**System** tab and `/api/admin/health` report each session's idle time.

### A transcode cannot fill the disk

The idle sweep above stops a session nobody is watching — which is what made a *directory* keep
growing — but a session somebody *is* watching can also fill a small volume: a film keeps every
segment it writes (that is what makes it scrubbable), so a 2h20 feature needs well over 10 GB. A
full filesystem is not a transcode problem, it is an outage: SQLite stops writing and every request
answers "disk I/O error" (see the space note at the top of `lib/diskSpace.ts`).

So the filesystem is checked before a session starts and while it runs:

- **Before starting**, a transcode is refused with a readable reason rather than being allowed to
  run out of room: a film needs 8 GB free, live TV — which keeps only a rolling window — needs
  256 MB, the same floor the database itself needs. The viewer sees
  *"Not enough free space to transcode this title: 3.2 GB free, 8.0 GB needed."*
- **While running**, the same sweep that reaps idle sessions stops *every* session if the free
  space falls below 256 MB, and logs why. Whatever is streaming is worth less than the app staying
  able to write to its database.

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

## Global search

A search field in the top bar covers the provider's whole catalogue — live channels, films and
series — with the same fuzzy matching the guide uses: number words fold (`sky sports one` finds
`Sky Sports 1 HD`), and every word you type must appear in the name (so `f1 news` doesn't
silently return the F1 channel). Results show the artwork, category and kind, and picking one
switches to the right tab and starts playback.

Results come from a **SQLite index**, not a live query: it is built on demand — automatically when
it is more than a day old, or from **System → Search index** — so search still answers instantly
when the provider is slow or entirely down. (Search tokenises differently from the guide matcher
on purpose: the matcher drops packaging words like `HD`/`Channel` because it is deciding identity,
whereas search keeps them, because people type the words they can see.)

## Catch-up: play a programme that already finished

For channels your provider flags with `tv_archive`, clicking a **finished** programme in the guide
plays it from the provider's archive instead of the live channel — the now-playing bar says which
programme it is, and **Return to live** switches back. A programme **still on air** plays live as
usual when you click it — but **double-click** one (or press **Shift+Enter** on a focused programme)
and it restarts from its beginning instead, for any channel that keeps an archive. That is the point
for live sport: the archive serves from any moment inside its window, so "I joined at half time" has
an answer.

The server builds the provider's own timeshift path (`/timeshift/<user>/<pass>/<minutes>/<start>/<id>.ts`)
in one small function (`lib/timeshift.ts`), because that shape is a provider convention the API does
not advertise — confirmed against the real provider (HTTP 200, `video/mp2t`). A start outside any
plausible archive window is refused before it becomes a request for years of video, and the browser
never sees the credentials: playback goes through `/api/timeshift/<id>.ts?start=&duration=`, and —
because a timeshift stream is raw MPEG-TS, which hls.js cannot parse and Safari cannot decode at all —
the browser is handed this app's own HLS output from the transcoder instead, the same machinery the
E-AC-3 fallback uses. With one deliberate difference from live: a catch-up keeps **every** segment,
because ffmpeg reads an archive far faster than real time (measured ~11.6×) — under live's rolling
six-segment window, the segment a player asks for has already been deleted, so playback died seconds
in with a 404 for the first segment.

## Streams that always need converting

Some streams this browser simply cannot play: Sky News FHD carries **E-AC-3** as its first audio
track (undecodable in Chrome), and *Batman Begins* is **E-AC-3 5.1 inside Matroska**. Both used to
play *nothing* for ten to thirty seconds before the fallback noticed and started converting — on
every start, because nothing remembered.

The fallback now remembers which streams needed converting, and the next play goes straight to the
transcoder. It is deliberately **per-device** (`localStorage`, not a server setting): which streams
need converting depends on the browser doing the playing, so the answer is not shared. The list is
bounded at 200 entries and entries expire after **14 days**, because a provider can re-encode a
stream and a stale hint would then force a pointless transcode. Worst case, if a hint is wrong, you
get the behaviour you had before.

## Tabs that do not stop playback

**EPG**, **Admin** and **System** open in their own browser tab, because all three are configuration
rather than something you watch — switching to them in the same tab unmounts the player and stops
whatever is playing. They are real links, so middle-click and ⌘/ctrl-click work as you would expect.
The tab a new window opens on comes from the URL (`?tab=admin`), since a fresh page load has no
memory of where you were; anything unrecognised falls back to Live TV.

## Provider alerts (admin → **Admin** → *Provider alerts*)

The server watches your provider and posts to a **Discord webhook** when it stops answering — once
when it goes down, once when it recovers, and never repeatedly while it stays down. It needs two bad
checks in a row before calling it an outage, and a single good check in the middle breaks the run, so
a blip cannot turn into chatter in someone's support channel.

The message names the host, when it started, and the provider's own error verbatim; it never mentions
your account, because a support channel is not private. The webhook is stored encrypted with your
provider credentials and is never sent to the browser — the panel shows a blank field that means
*keep the saved one* — and only `https://discord.com/api/webhooks/…` URLs are accepted. **Send test
alert** proves delivery on the spot rather than during a real outage. `PROVIDER_WATCH_INTERVAL_SECONDS`
tunes how often it checks (default 90).

The same webhook also carries **app-health alerts** — the *app's* own failures, rather than the
provider's. A full disk and an unwritable database are the two that have actually happened here:
a full root filesystem presents as SQLite `disk I/O error` on everything including sign-in, and an
unwritable database presents as being unable to store anything at all. Both used to be visible only
to someone already looking at the System tab. The check runs every five minutes, needs two agreeing
readings before it calls it, posts once when it degrades and once when it recovers, and every
distinct destination is told exactly once even with several accounts configured. The message says
what to do, including the container restart that an unwritable database needs after its permissions
are fixed.

## What this provider actually does (measured, not assumed)

Worth reading before debugging anything that looks like a playback bug. Every item here cost real time to
establish and none of it is documented by the provider — and each one has been mistaken for a bug in this
app at least once.

- **A `.m3u8` URL may return a playlist *or* raw MPEG-TS**, and which one changes from moment to moment.
  Sky News (FHD and HD) does both. Nothing in the app trusted the extension after that was measured: the
  client sniffs the first bytes before choosing a player, and the transcoder sniffs before choosing its
  input options.
- **Stream ids are renumbered.** BBC One FHD was 37237 in one week's notes and 42783 in live data the
  next, and *both ids still answer* — so a stale id fails quietly rather than loudly. Saved favourites,
  history and custom categories resolve against the provider's current list for exactly this reason.
- **Live playlists carry absolute CDN URLs containing the account credentials**, signed for roughly 25
  seconds. Live segments are therefore relayed through this app rather than fetched by the browser, which
  is what keeps those credentials out of it.
- **The panel flaps.** DNS resolves, TCP connects in ~0.3 s, and then there is no HTTP response at all.
  That signature is the provider rather than this app: the watchdog reports it, and a request that never
  answers becomes a 504 with a sentence instead of a hang.
- **`max_connections` is 2.** Anything that opens a second connection on the same account can starve
  playback, which is why transcode sessions are never pre-warmed.
- **Every channel can answer with a repeating placeholder while the panel still looks perfectly
  healthy.** Measured 2026-09-21: the panel reported `reachable: true, auth: 1, Active, 0/2
  connections`, while *every* channel sampled — 4K (Sky Sports UHD, TNT Sports Ultimate), news (Sky
  News, BBC One HD, Scripps), US local affiliates, niche feeds — returned **byte-identical media**: one
  shared ~2-minute loop, 1920x1080 H.264 at ~435 kb/s with **4 kb/s audio** (i.e. silent), on both the
  HLS path and the raw `.ts` path. The HLS playlist also never advances: every refresh answers
  `#EXT-X-MEDIA-SEQUENCE:0` with the same segment indices (`0.ts, 1.ts, …`), and only the containing
  token directory changes. A native player plays that loop smoothly; hls.js cannot build a monotonic
  live timeline out of it, so this app's recovery ladder can spend its whole budget cycling against a
  channel that was never broadcasting. **"The provider is down" and "the provider is serving a
  placeholder" look nothing alike from the panel and only one of them is a bug worth chasing** — check
  a channel known to be live before debugging the player, and note that an event-only channel outside
  its event is the most likely source of this. And treat it as a *state*, not a condition: the same
  account served real, distinct streams again the next day (2026-09-22), with an advancing playlist and
  per-request tokens.
- **Every channel here is HEVC, and every channel's audio is Dolby.** Measured 2026-09-22 against the
  recovered streams: the UHD tier is HEVC **Main 10** at 3840x2160 and **50 fps** (59.94 on one CA
  feed), BT.2020 with a PQ transfer — i.e. 10-bit HDR — at **~14-22 Mbps**, carrying E-AC-3 5.1 at
  640 kb/s or AC-3 5.1. Even the 1080p HD channels are HEVC (Main, 8-bit, 50 fps) with E-AC-3 stereo,
  not H.264. Two consequences worth holding onto: **a browser has to decode both HEVC *and* Dolby to
  play any of this untouched** (Safari does; Chromium usually does not), and **the segments are
  MPEG-TS**, and that container *is* the problem: Apple's HLS rules put HEVC in fMP4, and measured
  against the macOS media stack (AVFoundation, Safari's engine), **an HEVC Main 10 TS stream presents
  no video at all** — audio only, zero decoded frames. The same bitstream remuxed to fMP4 (`-c:v copy`,
  no re-encode) decodes immediately at 3840x2160. So an HEVC live channel goes through the stream-copy
  remux (v0.48.0) before playback, and plays at full resolution and bitrate as fMP4.

## Backup, restore and system health (admin → **System** tab)

- **Health**: version, uptime, memory, database size and row counts, provider reachability with
  **connection usage** (`1 in use of 2`), guide-source status, active transcodes, and the last few
  server errors — the "is it them or us?" page.
- **What the relay is carrying** (v0.47.1): every live segment is relayed through this host by design, so
  the Active-transcodes table now shows each session's **average rate** and a running total — 14-22 Mbps
  per UHD viewer, measured 2026-09-22. If that number sits below what a channel should produce, the host
  is the bottleneck and no amount of recovery in the player will change it; that is worth knowing before
  hunting a playback bug.
- **Backup**: download the whole database with one click (a consistent copy taken with SQLite's
  own backup API, safe while the app is running). A snapshot is also written to `/appdata/backups`
  automatically once a day, keeping the last handful.
- **Restore**: upload a backup; it is verified (must be a real Allison database) and applied on
  the next restart, with the database it replaces kept in `/appdata/backups` — so a restore is
  itself undoable. Swapping the file under a live process is how SQLite databases get corrupted,
  hence restart-time application.
- **Search index** controls and stats.

## Your library: favourites, history and custom categories

Favourites and custom categories can be shown either as the **reorderable list** (drag to reorder,
✕ to remove, and where a category's *Add channels* lives) or as the **guide**, showing what is on
across just those channels. A small **Guide / List** toggle sits above them and remembers your
choice; Favourites opens on the guide.

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

**Reorder your lists.** Favourites and each custom category are drag-and-drop: grab a row's grip
(⋮⋮) to move it, or use the ▲/▼ buttons — which are also the keyboard/touch route, and disabled at
the ends of the list. The order is stored per account in the database, so it survives an update.
History stays time-ordered (newest first) because reordering a log makes no sense.

**Resume where you left off (movies and series).** Playback position is tracked per title — and
per *episode* for series — and stored with the account. **Movies → 🕘 History** and
**Series → 🕘 Continue watching** list what you were watching with its position (`42% · 1:02:03`)
and offer **Resume** or **Start over**. Positions are stored once you're more than 15 seconds in;
reaching the end (or seeking back to the start) clears it, so nothing is offered that shouldn't
be. Live TV has no resume by design — there's nothing to return to.

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
