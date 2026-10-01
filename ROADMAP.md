# Roadmap

**Correction, 2026-09-21 (after v0.46.1).** Two entries below said live verification was pending
because "the provider has been down since 2026-09-20". That came from the 2026-09-20 session's own
notes and was carried forward without re-checking — the provider was back. What actually blocks the
live proof is deployment: the running deployment was still on v0.44.1, so no real channel had been
exercised against the v0.45.0 tier or the v0.46.x resolution cap. Those entries now say that instead.
Worth recording as a habit: a note inherited from an earlier session is a hypothesis, not a fact —
check it before repeating it into a release note.

Recommended enhancements for future development, refreshed **2026-09-28 against v0.61.6**.
Grouped by theme rather than a strict backlog — pick based on what matters most to whoever
picks this up next. See `README.md` for the full current state and `EFFORT-ASSESSMENT.md` for
the original scoping writeup this project started from.

## Current release

**v0.66.5 — sound is attempted, not asked for.** The operator's question, and the right one:
*"why do we need a button to press? shouldnt this be just activated."* It should — and Chrome
agrees more often than v0.66.3 assumed: unmuted autoplay is allowed after a recent interaction or
with media engagement on the site (both true for the person using this app daily). The carrier now
attempts sound outright; the "Tap for sound" chip appears only on a genuine refusal
(`NotAllowedError` — activation window closed, no engagement), where it is the honest minimum
rather than the default. The clock never waited on any of this (v0.66.4). 741 tests, typecheck,
lint and the client build clean.

**v0.66.4 — the clock listens to buffering, not playback.** Still "no audio clock" on the ".48
Chrome" retest (both Sky Sports Main Event UHD and Sky Sports F1 UHD) — and this time the chain was
verified link by link until the broken one had nowhere to hide. Real ffmpeg produces a correct
audio-only playlist, PDT on every segment (v0.66.3's check). A real browser (headless Chrome
against that very playlist, hls.js 1.7) proved the client-side parsing: the fragment fields carry
the stamps fine — **on `FRAG_BUFFERED`**. What never arrives is `FRAG_CHANGED`: it fires only for
fragments that actually *play*, and the carrier still has not started playing when the clock needs
it (autoplay refused past the activation window; even the muted start is not guaranteed before the
first fragment is wanted). The clock is therefore built from **buffered** fragments now
(`playingWallMsFromFrags`, pure and unit-tested): the map engages the moment the first fragment
lands, regardless of playback state; a paused element freezes `currentTime` and the clock with it —
a held picture, which is what a held sound track should produce. 741 tests (3 new), typecheck, lint
and the client build clean.

**v0.66.3 — the paused carrier: why the sound and the clock died together.** The retest (".48
Chrome", v0.66.2) confirmed the screen and fullscreen fixed — and still no audio, still no clock,
which pointed the diagnosis somewhere new. The server side was proven first this time: the exact
audioOnly argv, run against real ffmpeg, produces a correct audio-only fMP4 playlist with
PROGRAM-DATE-TIME on every segment (`video:0kB audio:141kB` — nothing to fix there). The cause was
client-side and explains both symptoms at once: **the audio element never started playing**.
`FRAG_CHANGED` fires only for *played* fragments, so a paused element gives no sound and no clock —
and it was paused because its `play()` ran long after the channel click that earned Chrome's
transient user activation (the ladder takes seconds to reach the engine), so unmuted autoplay was
refused and the refusal was swallowed. The carrier now **starts muted — always allowed, clock and
sync engage immediately — and unmutes on the first interaction**, with a visible "Tap for sound"
chip until then (the native controls' own unmute works too). And a session that cannot start now
says why, with the server's own message, instead of vanishing into the engine's generic no-clock
notice. 738 tests, typecheck, lint and the client build clean.

**v0.66.2 — the first live run's three findings, fixed.** The ".48 Chrome" test (2026-10-01,
written up in `/agent/test`): the diagnostics loop read **50 fps presented, zero dropped frames**,
and the decode check 425.7 fps at 4K Main 10 — the engine's video half is done. The player
surfaced three bugs, all now fixed. **(1) No audio, no clock — the v0.24.0 lesson repeated in new
code**: WebCodecsPlayer called `crypto.randomUUID()`, which exists only in secure contexts, so over
the plain-HTTP LAN address the audio session's start threw before any promise, was silently
swallowed, and the picture ran unclocked and silent. The codebase's own `newSessionId()` exists for
exactly this; the player now uses it. (The "initially audio with no video" the operator heard was
the ladder's direct MSE attempt playing audio-only before escalating — honest, and now followed by
a working engine.) **(2) The player collapsed to a small strip**: the audio carrier has no video
track and therefore no intrinsic size, and the absolutely-positioned canvas contributes no layout —
the carrier now carries the player's 16:9 shape itself. **(3) The controls' fullscreen button
black-screened**: it fullscreens the *video element*, leaving the canvas on the page behind —
redirected to the wrapper (canvas and controls together), with double-click kept. 738 tests,
typecheck, lint and the client build clean.

**v0.66.1 — the measured-lie rescue: the engine catches what MSE falsely claimed.** The operator's
first live test (2026-10-01, Chrome on the Mac, Sky Sports Main Event UHD) hit the terminal
sentence — and exposed a hole in the proactive gate. This Mac's Chrome answers
`isTypeSupported(hvc1) → true` and then fails the actual append (the exact lie videoCapability.ts
has documented since v0.45.0), so the gate's `!mseCanDecode` condition never fired and the ladder
walked itself to the end: direct → copy session → append fails again → "cannot be played". The fix
is the ladder's new last rung: **when playback has provably failed and the device holds a usable
decode verdict, the client's own GPU gets the channel** — one bounded attempt per run, the dead
session stopped, the engine mounted in place of the error. Browsers whose MSE tells the truth are
untouched: a yes that works stays direct, a no hits the proactive gate as before. Also from the
morning's cut: the v0.66.0 tag moved one commit forward after CI's typecheck caught a stale
interface declaration (the TranscodeService interface had never grown `audioOnly`; the gate worked
exactly as built). 738 tests, typecheck, lint and the client build clean.

**v0.66.0 — the client-side engine joins the player.** The direction this file has been building
since the NAS was ruled out of video transcoding (2026-09-22), landed. On a browser whose MSE
cannot present a live HEVC channel, **the device's own GPU now decodes it**: LivePlayer chooses
the WebCodecs engine when the saved verdict says the device can (measured twice on the target
machine: 396.7 and 383.8 fps at 4K Main 10), the canvas presents the provider's own bits — full
resolution, zero re-encode, the server never touches the picture — and the sound rides the
audio-only session, whose PROGRAM-DATE-TIME stamps are the A/V clock. Both renditions describe the
same source, so the same wall instant names the same content instant: the engine maps the audio
element's playhead through its fragment stamps onto the video's own playlist stamps, presents the
frame the ear says is due, and degrades honestly at every step — no clock yet or a failed session
runs the picture on wall time *and says so*; a browser without the verdict keeps today's honest
paths untouched (native, remux, the sentence).

The pieces: `lib/webCodecsVideo.ts` is the controller (loop + decode + present, driven by an
injectable clock — fake-driven end-to-end in tests, real TS bytes in, the audio clock's frame
choices out); `WebCodecsPlayer.tsx` is the surface (a picture-less `<video>` underneath carries
real controls and the sound, the canvas paints over it letting every click through, double-click
fullscreens the pair); the planner learned to read `#EXT-X-PROGRAM-DATE-TIME`; the audio tier
stamps its playlists (`+program_date_time`); and the fallback hook grew an audio-session lifecycle
that never touches the transcode ladder's own bookkeeping. Engine order is unchanged for everyone
else: Safari native, Chrome-with-MSE-HEVC direct, and the engine only where MSE says no and the
device said yes. 738 tests (3 new), typecheck, lint and the client build clean. **Wants its live
proof on the deployment** — the UHD channels in Chrome on the measured machine — and the media
stats panel now names the engine when it runs.

**v0.65.0 — the audio half of the client-side player: a session that carries sound alone.** The
loop's validation run came in clean first (2026-10-01: presented 37 fps against a 50 fps stream,
**queue empty, 0.1 s behind the live edge** — presentation keeping pace where it previously starved
at 13%), so the player integration began. This is its server half, and the pattern is the playlists
feature's: **built, tested, deliberately unwired** until the engine joins LivePlayer
(`/api/transcode/start` accepts `audioOnly`, and no client sends it yet). The design it serves:
WebCodecs decodes the provider's own 4K video bits in the browser, but WebCodecs has no Dolby
decoder and this provider's audio is E-AC-3/AC-3 — so audio alone rides an ffmpeg session
(`-c:a aac`, video simply unmapped, every live-input guarantee intact: `-re` pacing, the
authenticated relay, the window sizing). An audio-rate re-encode is trivial next to the decode the
client is doing for itself, and the session's HLS output doubles as the A/V clock the canvas will
sync against — audio arriving *with* the integration, never before it. Pinned by an argv test in
the tier's own style: no `0:v:0`, no `-c:v`, `0:a:0` mapped, AAC, `-re` still present. 735 tests,
typecheck, lint and the client build clean.

**v0.64.0 — every sport was asking football's host.** The operator's report (2026-10-01): *"looking
at the api requests there are only football requests, no AFL Baseball Basketball Formula 1 Handball
Volleyball rugby nfl nba mma and hockey are all 0."* The evidence trail: the persisted store held
exactly one row (football) against 16 requests spent; curl from the NAS reached every host with the
account's key; and a reproduction through the service's own code showed the truth — **every
non-football request was addressed to `v3.football.api-sports.io`** (`HTTP 429 fetching
https://v3.football.api-sports.io/games`), because `getSportFixtures` passed the *football* origin
default into every sport's URL builder. Basketball had been asking football for `/games` — "The
Games endpoint does not exist" — since **v0.61.5**: the hosts were confirmed by curl back then, never
through the app, and no test could see it because a fake test origin happily serves every path. The
fix is one line of intent (the origin override is for tests, and nothing else); the regression test
that now pins it watches the wire itself — a fake upstream that records which host each request
actually reached. Verified against the real API after the fix: **262 fixtures across ten sports**
(basketball 42, ice-hockey 61, handball 20, baseball 12, volleyball 3, football 123), 11 requests for
11 sports, and honest zeros for the out-of-season ones. Three more sports joined on the same report:
**handball, volleyball and MMA** (`mma`/`ufc` resolve to the fighting feed), taking the catalogue to
eleven. Formula 1's refusal — the free plan covers seasons 2022-2024 only, so the current calendar
is a paid feature — is now held for the season's TTL instead of re-billed every poll, and one sport's
refusal no longer hangs an error banner over a day that answered. And the tab's other ask landed
with it: the fixtures pane says **"loading fixtures…"** while a cold fill asks its eleven feeds,
rather than sitting static and reading as a hang. 734 tests (4 new), typecheck, lint and the client
build clean.

**v0.63.2 — the loop's first live run, and the draw cost it exposed.** The operator ran the
client-side live loop on the 4K Main 10 channel in Chrome (2026-10-01): decode was magnificent —
**3,643 frames on the hardware path, ~8x realtime** — while presentation starved: 411 frames drawn
against 2,645 dropped late, the queue pinned at its cap, and "8.4 s behind the live edge". Two
causes, both on the drawing side, and neither a flaw in the engine's timing logic (which is pure and
pinned by tests). **First, the canvas blitted every frame at the stream's full 3840x2160** into a 2D
context that the browser then scaled down to panel width — the draw alone consumed more than a frame
interval, so the newest-due policy dropped everything it skipped; the loop now draws at the canvas's
displayed size, which is what a diagnostics canvas is for (the stream's own resolution reaches the
player integration, where the canvas is the television). **Second, a hidden tab draws nothing** —
the browser stops requestAnimationFrame outright while decoding happily continues, which read as
"presented 0 fps" over a backgrounded stretch; the stats now say so in a line rather than letting it
look like a stall. The intro also now names the two behaviours that are not faults before they look
like bugs: the joining burst of drops (the edge buffer is paid for all at once) and the hidden-tab
pause. 730 tests, typecheck, lint and the client build clean.

**v0.63.1 — a Safari refusal gets its sentence.** The operator ran the decode check in Safari
(2026-10-01) and got a bare `check failed: Decoder failure` — the check had walked the whole chain
(fetch, demux, codec negotiation) and then WebKit's decoder answered with its generic refusal, most
likely its VideoDecoder not taking Annex-B HEVC with in-band parameter sets (`hev1`, no description).
Two things shipped. **The sentence**: a decoder that refuses a configuration it just claimed to
support now says which codec, what that means (a finding about the browser build, not the stream or
the device), and where this path actually runs — Chrome, Brave and Edge; **Safari plays these
channels natively and never needed the client-side path**, so the failure blocks nothing. And a
stale sentence in the check's own introduction ("the whole stream is submitted as one chunk") —
wrong since v0.61.6 split the stream into access units — finally says what the check does. If Safari
client-decode ever matters, it wants an hvcC-style description rather than Annex-B; recorded here so
the idea is not re-derived. 730 tests, typecheck, lint and the client build clean.

**v0.63.0 — the whole sport catalogue, and answers that survive the restart that asked for them.**
The operator's report (2026-09-30): *"checking the API football, i can only see the football api
calls … AFL baseball basketball formula 1 NBA NFL are all missing api calls"* — and, right: the
client's sport list carried American Football, Aussie Rules and Motorsport all along, but the
server's host table had nothing behind them, so `sportApiFor` returned null and the multi-sport
fetch **fell back to football-only**. Three hosts were added — `v1.american-football` (NFL),
`v1.afl` (Aussie Rules) and `v1.formula-1` — with everyday aliases resolved onto the right feed
(`nba`→basketball deliberately: NBA's games are already inside basketball's `/games`, and querying
both would double the request count for the same fixtures), and the in-play status codes extended
with the american quarters (Q1-Q4, OT). Baseball and basketball were already wired (v0.61.5); the
confirmation of the three new shapes wants the same live pass the original five got. **Formula 1 is
not two teams and a score**: `/races` answers a *season calendar*, so each session (practice,
qualifying, the race) becomes a fixture at its own kickoff, a season is fetched once and memoised
for a day, and live/finished are derived from the asking clock rather than cached — a stored "live"
flag would be a lie the next day.

The second half is the operator's other rule, verbatim: *"we should be storing the data and
referencing it when we can, not pulling it again from the API database … check that you have the
data before you poll the API again. This information should be stored on the storage mount so its
not lost on update."* Every fixture answer now lands in **`sports_fixtures_cache`** in the app's own
SQLite database on the persisted volume, kept **for seven days and purged beyond that** (on write
and on boot). Reads are cache-first all the way down — memory, then the database, then the API —
and a **past day is final**: fetched 26+ hours after the day it describes, its results can no longer
change, so it is served from storage for its whole seven-day life without another request. Today
keeps the live (5 min) and idle (1 h) windows it always had, because an hour-old score is not a
score. The **request counter is persisted too** — a restart used to reset our own ceiling while the
provider's kept counting. Admin → Sports data now shows the whole catalogue the key is asked for,
requests spent today, and what the store holds (days, oldest to newest) — "only football calls are
being made" is answerable from the screen. Also landed, from the same day's report (*"VOD is missing
movies and TV"*): when the provider *answers* with an empty movie or series catalogue, the tabs now
say so in a sentence instead of rendering a silently bare sidebar — an empty answer is the
provider's to explain, and a load failure already had its banner. And one reported the same day, the sharpest of the set:
*"the error Xtream request failed: 502 Bad Gateway appears, but then its not cleared, even if the
channel is switched and the video is playing correctly"* — three fetch paths set the live tab's
error banner and **nothing ever cleared it**, so a banner from one of the provider's transient
silent windows (surfaced by the relay as 502) outlived the outage by however long the tab stayed
open. Every list fetch now clears the banner on its own success, and a channel that actually plays
clears it too — video working *is* the provider answering again, and the player has its own error
state, so nothing real can be hidden. The VOD tabs got the same success-clears-error rule.

**And the stale logins, reported the same day:** *"i have only one login but i can see 3 previous
logins still active, one even streaming a channel. Only one login per account should be active, the
other stale logins should be automatically cleaned out."* The idle timeout could never reap those by
itself — a tab left open on a channel heartbeats every ~15s, which *is* activity, so an abandoned
login never went idle and kept its provider connection forever. Now **a fresh sign-in retires every
other login of that account** (`lib/singleSession.ts`, pure and tested): the abandoned tab's next
request 401s, the player's session-expired state takes over, playback stops, and the transcode
idle-reaper collects whatever it was holding. Found alongside, and fixed in the same move:
`destroyAuthSession` never removed the SQLite row, so even a *logged-out* (or admin-force-logged-out)
session lingered on disk until the idle prune and was **revived by a restart** — the exact "stale
login still active" shape. Retirements are audited as a new `revoked` outcome in the sign-in trail.
730 tests (33 new), typecheck, lint and the client build clean.

**v0.62.0 — the WebCodecs engine's live loop, proven standalone.** The gate the roadmap demanded
before this work — *measure the target machine first; a capability is not a throughput* — was passed
on 2026-09-30: the operator ran the decode check on channel 668 and it read **265.1 frames/second at
3840x2160 on the hardware path**, a comfortable tier with five times the headroom the 50 fps streams
need. The same afternoon the NAS-side transcoder died reading that very channel (exit 255, the
still-unexplained signature from 2026-09-22) — the whole argument for client-side decoding in one
exchange. This release builds the engine's risky half and proves it where a bug costs a canvas, not a
channel: **Admin → System now carries "Client-side live playback — video only"** beside the decode
check. It polls the playlist, fetches new segments while their signatures are young, demuxes with
PTS, decodes with WebCodecs, and presents on a canvas paced by the frames' own timestamps — the exact
video pipeline the player will run. Three pure modules carry the decisions, each unit-tested:

- **`lib/liveSegmentLoop.ts`** — the playlist planner hls.js would otherwise own: join ~9s behind the
  live edge, notice new segments by *absolute sequence number* across the sliding window, bound a
  catch-up over several polls, poll at playlist cadence when at the edge, and remap a refused segment
  (400/403 — the ~25s signatures) by sequence from a fresh playlist, the same move the relay makes.
  It also detects a **playlist that never advances** — five caught-up polls with an unmoved window
  reports "this channel may not be broadcasting" instead of waiting forever, the honest half of the
  open "isn't broadcasting" item below, landed where it was cheap.
- **`lib/framePresenter.ts`** — the presentation clock: anchored on the first drawn frame, advanced
  by wall time (audio's clock arrives with the player integration), presenting the newest frame whose
  time has come and closing everything older — a decoder that falls behind skips ahead rather than
  queueing 4K frames into GPU memory.
- **`lib/tsHevc.ts` learned timestamps**: each PES header's PTS is carried onto the access units that
  start inside it (mapped by byte range, so a PES carrying several pictures shares one honest time),
  with 33-bit wrap handling and a discontinuity rule that re-anchors on a timeline reset without
  mistaking **B-frame reordering** for one — the fixture taught that decode order is not presentation
  order, and the presenter keys off the decoder's output (display) order accordingly. Chunks are
  marked `key` from real IRAP detection (NAL types 16-23) rather than "first frame of a segment",
  which the provider is under no obligation to make true.

One correction to the check itself, found while building this: **the codec string is now read from
the stream's own SPS** (`hevcCodecStringFromAnnexB`). The decode check had hardcoded
`hev1.1.6.L153.B0` — Main — which would have measured this provider's Main 10 HDR UHD feeds as Main.
The SPS's profile_tier_level layout was pinned empirically against x265's own output for Main,
Main 10 and Rext before trusting it (the compatibility flags sit *before* level_idc, and profile_idc
in the byte's low five bits — both easy to get subtly wrong, so the derivation and its candidates
are pinned by tests including a forced-Main cross-check). **Video only, on purpose**: audio stays on
the server's AAC path until this engine joins the player, which is the next release's work — the
engine choice in LivePlayer, the audio session, and A/V sync against a real clock. 709 tests (12
new), typecheck, lint and the client build clean.

**v0.61.8 — the plan records the working channels too.** The operator's original ask was *“a database
should be reference for the last known working config”*, and until now only the failures were recorded:
a plan was written when a channel needed converting, so a channel that simply worked read as
*“unknown — this channel has not been proved yet”* — true, and useless. (Seen in the wild on 2026-09-28
on a channel playing h264 at 720p with zero dropped frames.) Now a channel that buffers fragments **on
the direct source** records *“direct play, no conversion needed — proved N ago”*, kept deliberately out
of the “needs converting” list so it can never force the transcode it has just disproved, and cleared
when the channel later fails. A conversion still outranks it when both are true — the audio-undecodable
case, where the direct source half-worked. 697 tests, typecheck, lint and the client build clean.

**v0.61.7 — a failed decode measurement is not a device verdict.** The media stats panel reported
“0 fps at 300x150 — not enough for these channels”, which was the verdict the broken check had saved
(v0.61.6) presented as a property of the machine. A verdict with no picture in it now reads as what it
is — *“the run produced no picture, so this is a failed measurement rather than a verdict — re-run it”* —
and the tier is still not trusted, because a device must not be credited on the strength of a failed
run either.

**v0.61.6 — the decode check was feeding the decoder something invalid.** The operator's run on
2026-09-28 reported `decoded frames: 0`, `0.0 frames/second` and a 300x150 canvas — and, worse, the
release before this one *saved* that as the device's verdict. The fault was in the check: it handed the
whole elementary stream to `decode()` as a single `EncodedVideoChunk`, and a chunk is one frame by
definition. The decoder accepted the configuration and produced nothing at all. It now splits the stream
into **access units** first (`splitAccessUnits` — on the first slice of each picture, with parameter
sets attached to the picture they precede) and feeds one chunk per frame. Two consequences worth
keeping. **A failed measurement is no longer recorded as a verdict**: the verdict is saved only when
the run actually produced picture, and the result says so plainly when it did not — writing off a
machine that was never given a fair test is the false negative this project keeps having to unlearn.
And the panel now reports the stream as *“3.51 MB in N access units”*, so the next run distinguishes
“the demux found nothing” from “the decoder produced nothing”. 695 tests, typecheck, lint and the
client build clean.

**v0.61.5 — the other sports.** The operator's correction: *“its not only football, its other sports as
well … even though its called api football, there are other sports retrievable on that website.”*
Checked, and right: api-sports runs a **host per sport**, all answering this account's key —
`v1.basketball`, `v1.baseball`, `v1.hockey`, `v1.rugby` (football is the odd one at `v3.football`),
which is why the tab only ever showed football. The app now fetches **five sports**, each from its own
host, and every fixture carries **the sport of the API it came from** — the only authority on the
question, rather than a guess from the league name (which remains as a fallback for a feed that does
not say). The non-football hosts speak a different dialect and both were taken from live responses
rather than assumed: `/games` instead of `/fixtures`, basketball nesting the score under
`scores.home.total` while hockey puts a plain number there — so the normaliser accepts both, and a
missing score stays null instead of becoming a 0-0. Sports are additive: an unlisted one costs nothing,
a dead one does not empty the pane (errors are collected, with the plan-limit message preferred when
several agree), and the shared request budget from v0.61.4 is what makes five feeds affordable on a
free plan. 692 tests, typecheck, lint and the client build clean.

**v0.61.4 — the app manages its own api-football quota.** Checked the account through the API on
2026-09-28 and it is a **free plan: `limit_day: 100`** — while the Sports tab polls every five minutes
for live scores, which over a long evening is more requests than the whole day allows. Two rules now
keep it inside that allowance, and they had to come before adding more sports, because each sport
multiplies the request count. **A day with nothing in play is cached for an hour**; only a day with a
fixture actually being played refreshes on the five-minute cadence, so scores stay honest without the
quota paying for a static list. **And the service keeps its own ceiling of 80** — below the plan's
hundred, so the app degrades to what it already has and *says why* ("Daily api-football request budget
reached — fixtures resume tomorrow") instead of returning the API's errors for the rest of the day.
Until this release the account had spent **2 of its 100**. 688 tests, typecheck, lint and the client
build clean.

**v0.61.3 — an unrecognised competition is still football, and the plan's limit is stated.** Two
findings from checking the live feed through the app's own service on 2026-09-28 (the operator's
*“do number 1 via the API”*). **(1) api-football is a football-only feed, and the app was dropping
most of it.** Fixtures are filed into a sport by a rule table, and a competition it did not recognise
returned *no sport* — so its fixtures never appeared. Measured that day: **38 competitions had
fixtures and a fraction were recognised** (Prva Liga, Azadegan League, QSL Cup, the Africa Cup
qualifiers all vanished). Now anything unrecognised files under **Football**, with its own league name
as the group header, while recognised competitions keep their own sport. **(2) The key is a free-tier
plan, which covers today ±1 only.** A query for the following Saturday came back *“Free plans do not
have access to this date”* — so the ±7 day picker can only show three days of fixtures, and outside
them the pane falls back to the provider's own schedule. That is a fact about the subscription rather
than a fault, and the header now says so (**“Plan covers today ±1”**, with the feed's own wording in
the tooltip) instead of the generic “Scores unavailable” that sent you looking for a bug. 670 tests,
typecheck, lint and the client build clean.

**v0.61.2 — the plan is visible, and a fresh load stops re-probing.** Three follow-ups from the same
day. **(1) The media stats panel shows the channel plan** — *“video copy, audio re-encode — proved 2 h
ago”* — so a caching layer nobody can see becomes one nobody has to take on trust. **(2) The probe's
answer is remembered too.** The audio-track probe is an ffprobe against a live source and it ran once
per channel per page load; `channel_plans` now carries the **facts** as well as the plan (the codecs,
with their own shorter 7-day window), written even for channels nobody has played yet, so a fresh load —
or another device — skips it. Facts and plans are deliberately different things: a probe is not a proof
(`proved`), and a failure clears the plan while **keeping the facts**, since a failure says nothing about
what the stream carries. Existing installs get the wider table through an additive migration, verified by
a test that builds the v0.61.0 shape first. **(3) The redundant staged copy of the api-football key** was
removed from the repository's own appdata, now that the live volume holds the authoritative file and the
database the encrypted row. 666 tests, typecheck, lint and the client build clean.

**v0.61.1 — the decode gate is a tier per device, not a verdict on one machine.** The operator's
correction (2026-09-28): *“i dont want this player to need the rtx 3080 TI, its just one of the system
i have available, it should run on a varity of systems with or without hardware accesleration.”* The
verdict from v0.60.0 was a yes/no against a 30 fps floor, which quietly made one benchmark machine the
yardstick. It is now a **tier** — *comfortable* (100 fps or more: decode will not be what holds this
device back), *marginal* (30-99 fps: drops frames, and still better than a black screen in a browser
that cannot present HEVC any other way), or *insufficient* — and the messages built on it say what a
device can do rather than writing it off: a machine with no hardware decode at all is told what it
managed. Hardware decode is a fast path, never a prerequisite; a stream a device cannot carry at all
still falls back to the server's own path. 660 tests, typecheck, lint and the client build clean.

**v0.61.0 — what each channel needs is remembered once, in the database.** The operator's ask
(2026-09-28): *“a persistent record for each channel's transcoding need … a database should be
reference for the last known working config, if that fails for whatever reason then it should be
reassessed and updated … persistent through different builds.”* There was already a hint for this —
`lib/transcodeHints.ts`, localStorage, per device, 14 days — and it worked, but it was rebuilt on
every new browser and invisible to the server, which is where the transcoder actually is. The record
now lives in the app's own database (`channel_plans`, lib/channelPlans.ts) in the persisted volume:
one row per channel per account, shared by every device, surviving image updates. Two rules do the
real work. **A plan is a bet, not a fact** — it carries the moment it was proved, expires after 30
days, and is only ever written from a playback that *worked*. **A failure forgets it** — when a
converted session still will not play, the player reports it and the row is deleted, so the next
click re-discovers once instead of repeating a wrong answer for a month; the report is skipped when
the direct source was the one that failed, since then no plan was acted on. The client keeps reading
**synchronously** on the playback path — a hint that cost a round trip would defeat its own purpose —
from an in-memory mirror refreshed once a session, with localStorage as the instant-boot copy and the
offline fallback. 657 tests (12 new), typecheck, lint and the client build clean.

**v0.60.0 — a measured client-decode verdict, and failure messages that tell the two paths apart.**
Two pieces of the client-side decoding work, both of them the parts that had to come first.
**(1) The decode check now records a verdict per device** (`lib/decodeGate.ts`): frames per second,
the size it actually presented, and when it was measured — cached for two weeks and shown in the
player's media stats panel. The roadmap's own order puts a measurement before the player for a reason
worth repeating: `isConfigSupported` answering yes is a *capability*, and a capability is not a
throughput. This turns “run it there first” from an instruction into one click on the machine that
would be doing the decoding. A verdict under 30 fps, with no picture, or older than two weeks reads
as *not measured*, so a slideshow can never sit behind a green tick. **(2) The two video failure
paths now say different things** (`lib/playbackDiagnosis.ts`): the message names the engine that
answered and whether the native pipeline had already failed, so the fallback speaking is not recorded
as a codec verdict — the 2026-09-22 finding, where Safari and Chrome producing the same sentence told
us nothing — and it ends with what this device measured: either “a client-side player is viable
here”, or the instruction to measure it. 645 tests (19 new), typecheck, lint and the client build
clean.

**v0.59.2 — the api-football key is visible and editable in the admin screen.** The Sports data
section only ever reported *whether* a key was set; the field **shows** it now and lets it be changed
(the operator's ask, 2026-09-28). That is a deliberate exception to the rule the provider credentials
follow (never returned at all, v0.11.0), and it is confined: `GET /api/sports/key` is admin-only and
same-origin, the value is never logged, and it reaches nobody who is not an admin. The panel also
names where the key came from — the account that saved it, with the date — and Save only enables when
the field actually differs from what is stored. 626 tests, typecheck, lint and the client build
clean.

**v0.59.1 — the api-football key can be supplied out of band.** Until now the only way to set it was
the admin screen. The app now also adopts a key from the `SPORTS_API_KEY` environment variable, or
from a file at `<DATA_DIR>/api-football.txt` (`SPORTS_API_KEY_FILE` overrides the path) — which is
how a deployment gets one without the key passing through a chat or a repository: it is dropped into
the persisted volume the container already has. Adoption happens **only when nothing else has set a
key**, so a key entered in Admin → Sports data is never overwritten by a stale file, and the log line
names the source and never the key. 626 tests (5 new), typecheck, lint and the client build clean.

**v0.59.0 — the Sports tab's fixtures are api-football's, grouped by its competitions.** The
operator's correction (2026-09-28): the middle pane was grouping by the *provider's* channel-name
buckets, which produced a pointless “Football › Football” and did not reflect the real competition.
With a key configured the pane now shows **api-football's own fixture list** for the selected day —
one collapsible group per competition, by its real name (“English Premier League”, “La Liga”,
“Championship”) with the country beside it — live matches first and then by kickoff, each fixture
paired to the provider row carrying it so selecting one still leads to its channels. A fixture the
provider does not name is listed and still leads somewhere (the team-name search from v0.56.0). The
header says **“via api-football.com”**, so which source is in play is visible rather than inferred.
Without a key — or if the feed fails — the pane falls back to the provider's own schedule exactly as
before, and the catch-all provider competition is now labelled **“Other Football”** rather than
“Football”, the other half of the duplicate the operator saw. Client-only; 621 tests, typecheck,
lint and the client build clean.

**v0.58.1 — the Sports tab groups by competition, and each group collapses.** The fixtures pane
already drew a competition header per league; it is now a real **button** that shows or hides that
league's fixtures, with the fixture count staying visible so a shut group still says how much is
inside (and `aria-expanded` saying what it does). Provider competitions, api-football-only
competitions and the unscheduled buckets all collapse, and the choice is remembered **per league,
per device** (`lib/sportsGroups.ts`, unit-tested — a corrupt or hand-edited stored value reads as
“nothing collapsed” rather than throwing). Client-only; 621 tests (5 new), typecheck, lint and the
client build clean.

**v0.58.0 — the sports catalogue gets the guide treatment, the key goes system-wide, and both load
at 01:00.** **(1) The Sports tab's catalogue is now fetched by the server, cached on disk and shared
by every account** (`lib/sportsCatalogue.ts`): the provider's live categories and the streams of the
categories that classify as sports are cached per category for a day, so opening the tab no longer
re-fetches them and a restart does not either. Classification deliberately stays on the client
(lib/sports.ts owns the only copy of the league rules), which is why the client asks for the ids it
wants — and the ids it last asked for are remembered, which is what lets the nightly job warm
exactly the right ones. **(2) The api-football key is a system setting**, like the guide sources: one
key for the household, stored **encrypted at rest** with the app's own cipher, written only by an
admin, never returned to anyone, and adopted from an account once on the first boot after this
change. A new `systemSettings.ts` holds the generic per-key storage both features ride on. **(3) A
nightly warm at 01:00** refreshes the guides and the sports catalogue (`scheduleNightlyWarm`),
rescheduled after every run so it stays on 01:00 across DST and restarts — the other half of “not
refreshed on each login”. **(4) The Sports tab's channels resize bar works in both directions.** It
was inverted: `useResizableDimension` assumes the panel sits *before* the handle (so dragging right
grows it) and the channels column sits *after* it, so the grip ran away from the pointer; the hook
gained an `invert` option, pinned by a test. Found alongside it: the pane's localStorage keys had
been written as the read tool's own truncated rendering of another file's key (`alliso…ight`) —
harmless, but wrong, and now proper names. 616 tests (9 new), typecheck, lint and the client build
clean.

**v0.57.0 — guide sources become a system setting, fetched once a day, refreshed one at a time.**
Three changes the operator asked for, all in the same area. **(1) The extra guide sources are now
system-wide.** They used to live on each account's credentials, which meant every user carried their
own copy and any user could change the household's guides. They now live in the app's own database
(`lib/systemEpg.ts`, one `meta` row), are read by every signed-in user and written only by an admin —
and an account's existing list is adopted once on the first boot after this change, so nothing had to
be re-entered. The setup screen's guide field is honoured only as that initial seed. **(2) Once a
day.** The guide TTL goes 6h → 24h, and — the part that actually makes a day a day — each fetched
guide is now **cached on disk** (`lib/epgCache.ts`, one file per source, written under a temp name and
renamed), so a restart reuses the last download instead of re-fetching 168 MB the moment somebody
logs in. The disk copy is parsed lazily on first need, so a server that never opens the EPG never
pays for it. A forced refresh blocks hydration, or the very guide being replaced would answer the
request. **(3) Refresh one source.** `POST /api/epg/refresh` takes an optional `url`, and the sources
table gained a **Refresh** button per row (alongside “Refresh all guides”). Adding or removing a
source fetches only what changed — adding a small XMLTV feed no longer drags the provider's guide
with it — and a removed source is forgotten outright rather than lingering in a cache. 607 tests (15
new), typecheck, lint and the client build clean.

**v0.56.0 — the Sports tab, phase 3: the day's fixtures, and a way to a channel for each.** The
middle pane now carries the **whole day's fixtures for the selected sport**, not only the ones the
provider happens to name. api-football's fixtures are paired with the provider's own rows, and
anything left unpaired is listed under its competition marked **“no channel”**, in amber; selecting
one shows the third pane's fallback — *“No channel on your provider names this fixture”* — followed
by every channel whose name mentions either team, ranked and playable. Pairing runs in two tiers
(`matchFixturesToGames`): the exact normalized team pair first, then a deliberately conservative
loose pass that accepts a club whose feed name is a prefix of the provider's (“Newcastle United” /
“Newcastle”, “Brighton” / “Brighton & Hove Albion”) and **refuses an ambiguous match outright** —
one candidate or none — because a wrong score beside a fixture is worse than a missing one. Generic
words (“united”, “city”) can never carry a match by themselves, and the same stoplist keeps the
fallback name search from matching half the catalogue. An unpaired fixture still shows both clocks,
from the feed's own instant and the league-country map. With no key the pane is the provider's
schedule exactly as before. 592 tests (10 new), typecheck, lint and the client build clean.

**v0.55.0 — the Sports tab's live scores, and the layout the operator asked for.** Two changes in
one release. **(1) The layout is now [ sports ] → [ fixtures for the day, grouped by league ] →
[ channels ].** The first pane lists the *sports* (Football, American Football, Basketball…), the
middle pane the selected sport's fixtures for the chosen day with the competitions as group
headers, and the channel integration is deliberately the last pane, reached by picking a fixture.
Kickoffs now read exactly as asked — the venue's wall clock with the browser's own in brackets,
*3:00 pm (10:00 pm)* — and a match in play shows its score instead: *Sunderland vs Newcastle / Live
0-0*. The sport level above the leagues is new (a `SPORT_OF_LEAGUE` map in lib/sports.ts, so the
ported rule table stays byte-identical to the desktop's). **(2) The score source.** The provider's
channel names carry no scores, so live scores come from **api-football.com**: a new server-side
service (`lib/sportsFixtures.ts`) with the host pinned to `v3.football.api-sports.io`, the
account's key stored **encrypted with its other credentials** and never returned to the browser, a
header path added to the shared upstream fetch, a five-minute shared cache (one minute for a
failure, scoped to the key that produced it so a corrected key takes effect on the next request),
and Admin → **Sports data** to set or clear it. With no key the tab is exactly as before, and its
header says so.

**What this deliberately does not do:** it does not list api-football's own fixtures as a separate
source. The middle pane stays the *provider's* schedule — every row already has channels behind it,
which is what the third pane is for — and the feed's scores are matched onto those rows by the
parser's own normalized team pair (`fixtureMatchKey`). An api-football fixture the provider does not
carry therefore does not appear, and a fixture whose team names differ beyond the parser's
normalization will not match. Both are honest limits rather than silent gaps. 582 tests (18 new),
typecheck, lint and the client build clean.

**v0.54.0 — the Sports tab, phase 1: the desktop app's schedule, ported.** The competition → day →
game → channels drill-down now exists here, built on the desktop sibling's own pure modules:
`lib/sports.ts` (fixture parsing out of channel names, cross-category game collapse,
api-football-style competition grouping, Today ± 7 day picker) and `lib/gameTimes.ts` (dual
venue/local kickoff times, DST-correct via `Intl`). Both were ported **code-identical** — the
desktop wrote them with no DOM/Electron imports precisely so they could be shared — with both test
suites (31 tests) carried across. A new top-level **Sports** tab sits beside Series: the sidebar
lists the competitions and the flat carrier-channel list, the middle column the selected
competition's games for the selected day, the right column the channels carrying the selected game;
clicking a channel plays it in the existing live player and both panes drag-resize with the app's
existing handle machinery. **No api-football here yet** — that is phase 2, and the tab is fully
usable without it. The one adaptation from the desktop: it reads the whole-catalogue cache it
already holds, whereas this app fetches only the categories that classify as sports, rather than
pulling all ~27k channels to discard most of them. 564 tests, typecheck, lint and the client build
all clean.

**v0.53.9 — an ffmpeg failure now leads with the line that names it.** The transcoder keeps a
40-line rolling tail of ffmpeg's stderr, and on a failed start reported only its last ten lines —
which on 2026-09-23 ended mid-`Skip(…)` *warning* while the line that actually explained the death
had already been trimmed past the window. An hour went to inference a single line would have
settled. The error message now leads with the first tail line that reads like a failure (`error` /
`failed` / `invalid` / `403 Forbidden` / `Option … not found` …), then the recent tail for context,
without repeating the failure line when it is already there; with nothing failure-shaped it falls
back to the plain tail exactly as before. Server-only; 533 tests (three new, pinning the summary
and the rolled-out-of-window case), typecheck and lint clean.

**v0.53.8 — live remux input is paced at 1x, because the provider now firehoses raw TS at ~10x
realtime.** Ported from the desktop sibling's 0.7.112 the same afternoon it was root-caused there:
the panel's raw-MPEG-TS "live" connections deliver at a **sustained ~10x realtime** (78 four-second
segments of media per 30 seconds of wallclock, holding steady 8+ minutes — a firehose, not a finite
catch-up buffer). Unpaced, the relay's own output edge advanced at 10x too, so a `delete_segments`
window spanning a handful of segments covered barely a second of wallclock — segments were evicted
between the player's playlist refresh and its fragment fetch, every fragment 404'd, and the channel
died with a terminal fragLoadError once hls.js's retry ladder was spent. Two argv changes, both
pinned in the live-input-resilience tests: **`-re` on the live input** (pacing ffmpeg's read to
native frame rate, TCP backpressure flow-controlling the provider — exactly how VLC consumes the
same firehose — so the output playlist advances at a steady 1x; VOD deliberately keeps the unpaced
read, which is what makes scrub-anywhere work), and **`-hls_list_size` 6 → 15** (~60s of window),
matching the desktop's invariant that the window must outlive the player's live-sync target (hls.js
default: 3 segments behind the edge) with real margin. Playback necessarily starts where the
connection opened — a stream served faster than realtime has no joinable live edge; same as VLC.
530 tests, typecheck and lint clean.

**v0.53.7 — a guide download the provider drops midway now retries itself.** The first reading off
v0.53.6's progress columns diagnosed the provider-guide failure in one glance: the guide is now
**168 MB** (the fetch machinery was sized for ~97 MB), the provider declares **no content-length**
(hence "unknown size" in the Progress column), and the operator's first attempt died at
**26.5 MB** — `Connection closed before the download finished`, this edge's documented drop —
before a manual reload succeeded whole. The app worked; the manual step was the gap.
`fetchTextViaUpstream` now retries a premature close in-attempt (up to three tries, two seconds
apart — only that failure, since an HTTP error or a stall timeout will simply recur), and the
error names the position: *"the provider dropped the transfer 26.5 MB in"*. The progress column
restarts from zero per attempt, which is honest about what a retry is. Verified by a test whose
origin drops the first request midway and serves a complete guide on the second — the fetch must
resolve with two upstream hits. 528 tests. **Sized differently now: the streaming-parse item
below.** This download is buffered whole before parsing, which a 168 MB — and growing — guide
will eventually outgrow no matter how well the transfer is retried.

**v0.53.6 — guide downloads show progress: bytes received, declared size, and where a failed
download died.** The operator's request, and the missing half of the provider-guide diagnosis: a
~97MB download on a flaky edge reported only "loading", so a stalled fetch was indistinguishable
from a working one, and a transfer that died midway had no position. The fetch now counts wire
bytes against the response's declared content-length, the status API carries the reading, and the
guide sources table gained **Downloaded** ("43.2 MB / 97.1 MB") and **Progress** ("44%") columns —
with the last reading persisting after a failure, so "error at 12 MB of 97 MB" is a diagnosis
rather than a dead end. A server-declared length is required for the percentage; without one the
column says "unknown size" instead of inventing a number. 527 tests, including a real-HTTP test
that streams a ~400KB guide in slices and polls the status mid-flight; verified in CI's Linux
container.

**v0.53.5 — the provider guide's error message becomes visible.** Reported as "an error on the EPG
sources on the provider guide, this is the most essential guide" — and the diagnosis kept stalling
on an embarrassing discovery: **the provider guide's error text was never displayed anywhere.** The
status cell said `error`, the message-bearing hint paragraph rendered for *external* sources only,
and a failing guide could not be diagnosed from the screen that shows it — not by the operator, and
not by anyone reading a screenshot. The error now appears inline under the provider guide's own
name, as a tooltip on its status pill, and in the hint paragraph with the externals. Client-only;
typecheck, lint and build green.

**v0.53.4 — every raw-TS channel died at spawn: the demuxer sniff couldn't authenticate.** The
serious one, reported live as *"all channels are failing"* the moment v0.53.2/3 reached the
deployment. v0.53.0 moved the transcode input behind the app's own authenticated relay (to survive
provider URL expiry) — and silently broke the guard that decides between HLS and raw-TS input
arguments: `sniffsAsPlaylist` fetched the source URL **without the session cookie**, the relay
answered the sniff with a 401, and the sniff fell back to its optimistic "treat as playlist". The
provider, serving raw MPEG-TS on its `.m3u8` URLs (its documented flip), then handed ffmpeg a TS
stream carrying `-live_start_index` — an HLS-demuxer-only option — and ffmpeg exited with
`Option live_start_index not found.` before reading a frame. Measured: the deployment's exact
two-line tail reproduced with its own ffmpeg 5.1.9 in a bookworm container against a TS origin.
Three fixes: **the sniff now sends the same headers ffmpeg gets**, so it sees what ffmpeg sees; **a
one-shot retry without the HLS-only arguments** fires when ffmpeg rejects them anyway (the
provider's flip can race any sniff, including a correct one); and the `-headers` option gets its
CRLF terminator, silencing the cosmetic `No trailing CRLF found in HTTP header. Adding it.` that
was sitting in every tail looking like a suspect. Two regression tests: the authenticated-sniff
shape (origin refuses without the cookie, serves TS with it) and the retry (the fixture dies with
the real error; the retry's argv must lack the argument). 526 tests; verified under
`node:22-bookworm linux/amd64` with `CI=true`.

**v0.53.3 — the EPG screen merges "where the matches came from" into the guide sources table.**
The operator's suggestion, and an obvious one once made: the matching report duplicated every
source row on its own screen. The guide sources table now carries **Channels matched** and **Share
of matches** inline per source — a source that contributes nothing, or everything, is visible on
its own row without a second screen. `—` and `0` are deliberately different: matching has not run
for that source yet, versus matching ran and the source answered for zero channels. Client-only
change; typecheck, lint and the client build green.

**v0.53.2 — a session that succeeds is no longer reported as "exited before producing output".**
The UHD channels failed on every attempt with that message, and the cause was an old, documented
assumption breaking. The transcoder's ffmpeg `exit` handler deleted the session directory on every
exit — success included — on the theory (written into the test suite's own throttle note) that no
real input finishes within one poll interval. Live TV broke the theory: a live playlist carrying
`#EXT-X-ENDLIST` — the provider's placeholder/off-air shape — or an upstream that closes reaches a
clean exit 0 *after writing the output*, and the handler erased the playlist the start poll was
about to see. Reproduced end-to-end against a fake provider on the deployed code (ffmpeg's own
summary said success; the app said failure), fixed by giving the start flow ownership of the
directory until it settles, and pinned by two regression tests — a real-ffmpeg ENDLIST session
(verified failing unfixed, passing fixed; skipped on CI, whose ffmpeg-static 7.0.2 build segfaults
on that fixture for reasons this app's code cannot reach, autopsy in the test) and a portable
fake-ffmpeg twin that runs everywhere. 524 tests; typecheck clean. The CRLF and `Skip (...)` lines
riding along in the error tail were warnings, not the cause — a tail's last line is not
automatically its verdict.

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

**Lockout fixed 2026-09-24 (v0.53.1).** The envelope replaced the provider fields that
`decryptSessionCredentials` validates, so the first save wrote a payload the app refused to read — and
because the save path read first, the account could not be repaired from the settings screen either.
`serializePlaylists` now writes the primary's provider fields at the top level alongside the list, and
reads use the lenient `decryptSecret`, which also recovers blobs the buggy build already wrote (only the
validator rejected them; the cryptography was intact). The regression test asserts a serialized envelope
still satisfies the strict reader. **Lesson: when a stored format changes, every reader of it is part of
the format, and the migration should stay additive until they have all been found.**

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

## Feature: a Sports tab (the desktop app's, brought to the web)

**Requested 2026-09-28 by the operator:** *"the sport tab feature that is in the fat application … it
would also be good to have that in this web driven application."* The desktop sibling
(`glustick/iptv-app`) has had one since its 0.7.109 and extended it in 0.8.0 with api-football.com
fixtures. This is the plan to bring it here.

### What the desktop app actually has — two independent layers

1. **A provider-name-driven schedule, with no external service.** `src/renderer/src/lib/sports.ts`
   (521 lines, pure — its own header says *"no window/document/Electron imports … so it stays
   unit-testable and shareable with the web sibling"*) classifies the provider's live catalogue into
   sport groups from **category names** (Football/Soccer pinned first, then by channel count; carrier
   categories like "Sky Sports" become their own browse group) and parses the fixtures **out of channel
   names**, because this provider's `get_short_epg` is empty — the same finding this repo's EPG work
   already records. It handles the shapes the provider really emits (`Soccer01: Brentford vs Chelsea (
   Sky Sports Main Event Feed ) @ 3:00 pm`, `EPL 05ⓧ: Newcastle United vs. Hull City AFC | Saturday, 19
   September 2026 15:00`, the separator-less `EPL01: Brentford 20:00 Chelsea`, UK numeric dates,
   `ET`/`AEST`/`GMT±N` suffixes), collapses one fixture carried under several categories into **one game
   with several feeds**, keeps unscheduled games in their own section, and offers a Today ± 7 day
   picker. One bulk catalogue fetch, no extra provider requests, and a feed click reuses the ordinary
   player path.
2. **api-football.com fixtures.** An optional per-user key (desktop: encrypted at rest with Electron
   `safeStorage`, entered in Settings → "Sports data") fetched through a main-process handler that
   **pins the host** to `v3.football.api-sports.io`, allows relative paths only, and injects the
   `x-apisports-key` header; the renderer normalizes the v3 shape (in-play vs. terminal status codes,
   null goals preserved). On the surface: a fixtures strip above the schedule, live-first, refetched
   every five minutes, failures contained to one status line — and **nothing extra rendered when no key
   is set**.

Kickoffs are always shown twice — the venue's wall clock with its DST-correct zone name, and the
viewer's local time (`3:00 pm BST · 10:00 pm`, with a `+1d` marker when the date shifts) — from a
second pure module, `lib/gameTimes.ts`, which maps a league's country to its IANA zone and does the
arithmetic with `Intl` rather than a fixed offset.

### What already fits here, and what does not

**Fits — and is why this is a port rather than a build:**

- Both logic modules are pure and were written to be shareable; they come across as `lib/sports.ts`
  and `lib/gameTimes.ts`, tests and all.
- The catalogue they need is already fetched and cached server-side (`providerLists.ts`, the search
  index) — the same one bulk pull the desktop uses.
- `tabs.ts` already has the shape for a new top-level surface, and the desktop's drag-resizable panes
  map to the existing resizable-column hooks. Day and pane widths have a home in the existing prefs.

**Does not fit — the desktop's Electron assumptions:**

- **The api-football key must not live in the browser.** The desktop keeps it in the main process and
  the renderer never sees it; here there is no main process, so it becomes a **server-side pinned-host
  proxy** (`/api/sports/fixtures`) with the key stored **encrypted at rest with `SESSION_SECRET`** — the
  rule this app settled in v0.11.0 ("provider credentials never reach the browser") applied to a second
  secret. It rides in the account's credential envelope, which already carries account-level fields
  (`epgUrls`, `alertWebhook`), and the API answers `keySet`, never the key.
- **The five-minute refetch belongs on the server**, not per tab: one cached fetch shared by every
  session is cheaper and is what keeps the key server-side, the rate limit in one place, and a failed
  fetch recorded once.
- `ensureChannelCatalog` (Electron store) → the existing server catalogue path; the desktop's watch
  history → this app's server-side library.

### Phases, smallest useful first

1. **The schedule alone — no new service, no key.** Port `sports.ts` and `gameTimes.ts` with their
   tests, add the Sports tab (top-level, like the desktop's, beside Live TV), and render
   groups → day → games → feeds from the catalogue already in hand. This is the whole 0.7.109 feature
   and needs nothing stored and no decision from anyone. **If only one phase ever ships, ship this one.**
   *Landed 2026-09-28 (v0.54.0)* — the modules are ported code-identical and the tab is live; see the
   release note at the top of this file. The remaining phases below are unchanged.
2. **The api-football proxy.** `GET/PUT /api/sports/settings` (set/clear the key; return `keySet` only)
   and `GET /api/sports/fixtures?date=`, with the key in the account envelope, the host pinned, a shared
   cache and a rate limit, plus a Settings → "Sports data" section written the way the Playlists screen
   already is. *Landed 2026-09-28 (v0.55.0)* — endpoints came out as `GET /api/sports/config`,
   `POST /api/sports/key` and `GET /api/sports/fixtures`, and the section is in the admin console. As
   built, the feed's scores are merged onto the provider's own fixture rows rather than listed
   alongside them, so every row still leads to channels; see the v0.55.0 release note.
3. **The fixtures strip.** Above the schedule, live-first, with the api-football-style league grouping
   and the "N feeds" badge; failures stay one line.
4. **Fixture → channel click-through, and scores on the provider's rows.** *Landed — scores
   2026-09-28 (v0.55.0), click-through the same day (v0.56.0).* The provider's own rows carry the
   feed's scores (its names carry none of their own), and a fixture the provider does not name is
   still listed and still leads somewhere: selecting it searches the catalogue for a channel
   mentioning either team. See the two release notes at the top of this file. Nothing from the
   desktop's own alpha limits remains open here.

### Decisions to confirm before phase 2

1. **Is there an api-football.com key, and is a server-side proxy acceptable?** It is the only shape
   consistent with v0.11.0; the key must not be shipped to the browser.
2. **Pane layout** — the desktop's three resizable panes (leagues / channels / fixtures), or something
   that fits this app's existing channel-list layout?
3. **A top-level tab, or a surface inside Live TV?** The desktop made it top-level; as a detached tab
   here it would keep playback alive while open (the `tabs.ts` rule).
4. **Phase 1 alone first** (schedule only, no key) — recommended — or phases 1 and 2 together?

**Why the split matters, and decides how much the fixtures layer is worth:** layer 1 needs no external
account and no key, and it is what makes the tab work at all; layer 2 is an enrichment that degrades to
nothing when the key is absent. The desktop app built them as two releases, which is what lets this one
be ported in two independent pieces — and lets the first land without anyone answering a question.

## Open work

### 0. Client-side decoding, so the NAS never transcodes video

**Correction, 2026-09-28 (same scope, narrower assumption).** *The client-side player has to work on
whatever device someone is watching on — with or without hardware decode.* The operator's words: *“i
dont want this player to need the rtx 3080 TI, its just one of the system i have available, it should
run on a varity of systems with or without hardware accesleration.”* So everywhere below that names
one benchmark machine, read it as *an example of a fast client*, not as the requirement: the
capability check is **tiered per device** — comfortable / marginal / insufficient, derived from a
measurement on that device (lib/decodeGate.ts) — a machine with no GPU at all is told what it managed
rather than written off, and a stream it cannot carry at all falls back to the server's own path.
Hardware decode is a fast path, never a prerequisite.

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

**Update 2026-09-30 (v0.62.0):** the loop and the pacing are built and proven standalone — see the
release note at the top of this file. The target machine measured itself (265 fps at 4K on hardware,
comfortable tier), the live segment loop and the presentation clock exist as tested pure modules
(`lib/liveSegmentLoop.ts`, `lib/framePresenter.ts`), and Admin → System runs the whole video pipeline
continuously. What remains is the player integration proper: the engine choice in LivePlayer, the
server's AAC audio session, and A/V sync against a real audio clock — plus, one cheap measurement
first, running the loop on a **Main 10 HDR** UHD channel, since channel 668 reads as Main 8-bit and
the hard feeds are Main 10.

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

- **Log what ffmpeg actually said.** *Shipped — and it had been shipped for a while; the entry below was
  stale.* v0.53.9 made a failed start lead with the first stderr line that names a failure (`error` /
  `failed` / `invalid` / `403 Forbidden` / `Option … not found` …), then the recent tail for context,
  without repeating that line when it is already there — with nothing failure-shaped it falls back to
  the plain tail exactly as before. The 2026-09-23 case it exists for: a fourteen-second session death
  whose buffered tail ended mid-`Skip(…)` warning while the cause had already been trimmed past the
  window. Corrected so it is not proposed again, the same class of correction as the two above.
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

- **Built-in public XMLTV presets.** *Shipped — and it was already shipped; the entry below was stale.*
  System → “Add a public guide” has offered four **verified** sources since 2026-09-19
  (`lib/epgPresets.ts`: epgshare01 UK/IE/AU plus i.mjh.nz Sydney), each carrying the date it was fetched
  and a plain-language note on size and id shape. Corrected so it is not proposed again — the same class
  of correction as the transcode-idle entry above.
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
- **Expose a transcode's `idle` reading in the System tab.** *Shipped — and it was already shipped;
  the entry below was stale.* The System tab's **Active transcodes** table has carried an **Idle**
  column (`{idleSeconds}s`, flagged *“— nothing is fetching this”* past 60s) alongside Rate and Disk
  used since the bandwidth work landed; the admin health endpoint it reads was never the only place
  this number lived. Corrected here so it is not proposed again — the same class of correction the
  note at the top of this file records.
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
- **Skip the multi-arch build for docs-only commits.** *Shipped 2026-09-28.* `paths-ignore: ['**.md']` is
  on the workflow's push trigger, so a documentation-only push no longer pays for a full multi-arch image
  (~13–20 min, arm64 `better-sqlite3` under emulation) and no longer depends on remembering `[skip ci]`.
  It has one sharp edge worth knowing, learned the same day: **a tag whose commit is docs-only would also
  be skipped**, so cut release tags on the commit that carries the version bump rather than on a later
  docs commit — `workflow_dispatch` remains the manual override if a build is ever needed anyway.

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