/**
 * The playback decision, made once and up front: reference the stream, then the record table,
 * then the device — and select the correct way to decode and display audio+video *before* anything
 * is attached. The operator's design (2026-10-02): *"rather than randomly try to decode the video
 * and audio, you should reference the stream first, then the record table, and then select the
 * correct way to decode and display the audio video."*
 *
 * The three references, in the asked order:
 *
 * 1. **The stream** — the probed facts (`rememberedTracks`, mirrored from the server's
 *    `channel_plans` row): what video and audio codecs this channel actually carries.
 * 2. **The record table** — the household's last known *working* config for this channel
 *    (`channel_plans`, mirrored synchronously): proved direct, proved audio-remux, or proved
 *    video-re-encode. A proved plan is playback evidence, the strongest input there is.
 * 3. **The device** — this browser's saved decode verdict (the tier its own GPU measured), plus
 *    what the browser answers for native HLS and MSE.
 *
 * What comes out is one route. The recovery ladder stays as the safety net — a lie from MSE, a
 * stall, a dead session still escalate exactly as before — but the *first* attempt is now the
 * informed one, not a guess.
 */

import type { DecodeVerdict } from './decodeGate'
import { verdictIsUsable } from './decodeGate'

export interface PlaybackRouteFacts {
  videoCodec: string | null
  audioCodecs: string[]
}

export interface PlaybackRoutePlan {
  /** A proved plan says this channel needed converting (audio remux at least). */
  needsConvert: boolean
  /** …and needed the video re-encode tier specifically. */
  needsVideo: boolean
  /** A proved plan says this channel played directly, no conversion. */
  playsDirect: boolean
}

export interface PlaybackRouteInputs {
  url: string
  /** The stream reference: probed codecs, or null when this channel has never been probed. */
  facts: PlaybackRouteFacts | null
  /** The record table: what last worked for this channel, proved by playback. */
  plan: PlaybackRoutePlan
  /** The device record: this browser's saved decode verdict, or null. */
  verdict: DecodeVerdict | null
  /** The browser has its own HLS pipeline (Safari) — native playback is possible. */
  nativeHls: boolean
  /** MSE's answer for the stream's video codec (only meaningful once facts name one). */
  mseCanDecodeVideo: boolean
  /** Whether the WebCodecs engine can run in this browser at all. */
  webCodecsAvailable: boolean
  /** MSE's answer for an audio codec. */
  mseCanDecodeAudio: (codec: string) => boolean
}

export type PlaybackRoute =
  | { route: 'direct'; engine: 'native' | 'hls'; reason: string }
  | { route: 'webcodecs'; reason: string }
  | { route: 'remux'; reason: string }
  | { route: 'video-transcode'; reason: string }
  | { route: 'unplayable'; reason: string }

/** The audio codecs no browser-side MSE carries, and what WebCodecs lacks too — the server must touch audio. */
const SERVER_AUDIO_CODECS = /^(e-?ac-?3|ac-?3)$/i

export function choosePlaybackRoute(inputs: PlaybackRouteInputs): PlaybackRoute {
  const video = (inputs.facts?.videoCodec ?? '').trim().toLowerCase()
  const audio = inputs.facts?.audioCodecs?.[0]?.trim().toLowerCase() ?? ''
  const isHevc = video === 'hevc' || video === 'h265'

  // --- the record table: a proved plan is playback evidence and wins ---------------------------
  // (Consulted after the stream is referenced — the plan's own codecs are what named isHevc —
  // but a *proved* route beats a guess about this request.)
  if (inputs.plan.needsVideo) {
    return { route: 'video-transcode', reason: 'the record says this channel needed the video re-encode tier — starting there' }
  }
  if (inputs.plan.needsConvert) {
    return { route: 'remux', reason: 'the record says this channel needed converting — starting with the session' }
  }

  // --- the stream: video -----------------------------------------------------------------------
  if (isHevc) {
    // The browser's own pipeline first: Safari presents fMP4-HEVC natively once the container is
    // remuxed — hardware decode, untouched picture, no client engine, no audio session. Where a
    // native pipeline exists it is strictly the better route.
    if (inputs.nativeHls) {
      return { route: 'remux', reason: 'HEVC video — the native pipeline needs the container remuxed, then plays it untouched' }
    }
    // The device next: a measured GPU is the route this whole direction exists for — the engine
    // exists precisely for browsers (Chromium) with no native HLS pipeline to make the offer to.
    if (inputs.webCodecsAvailable && verdictIsUsable(inputs.verdict)) {
      return { route: 'webcodecs', reason: 'HEVC video — this device measured its decode (client-side engine + audio session)' }
    }
    // MSE claims HEVC: some builds mean it (direct is free when true), some lie (the ladder's
    // measured-lie rescue catches that after one honest attempt). Either way the attempt is informed.
    if (inputs.mseCanDecodeVideo) {
      return {
        route: 'direct',
        engine: 'hls',
        reason: inputs.plan.playsDirect
          ? 'HEVC video — the record says this channel plays directly, and MSE claims it can decode it'
          : 'HEVC video — MSE claims it can decode it; the ladder stands behind the attempt'
      }
    }
    return {
      route: 'unplayable',
      reason: 'HEVC video — no measured device decode, no native pipeline, and MSE declines it'
    }
  }

  // A named video codec MSE declines that is not HEVC: nothing on the client will carry it.
  if (video && !inputs.mseCanDecodeVideo && !inputs.nativeHls) {
    return { route: 'unplayable', reason: `${video} video — this browser declines it and there is no client-side decode for it` }
  }

  // --- the stream: audio (on an otherwise-direct route) ----------------------------------------
  if (audio && SERVER_AUDIO_CODECS.test(audio) && !inputs.nativeHls && !inputs.mseCanDecodeAudio(audio)) {
    return { route: 'remux', reason: `${audio} audio — MSE cannot decode it, so the server re-encodes audio alone` }
  }

  // --- the record: a proved direct play is the cheapest correct answer -------------------------
  if (inputs.plan.playsDirect) {
    return { route: 'direct', engine: inputs.nativeHls ? 'native' : 'hls', reason: 'the record says this channel plays directly' }
  }

  // --- nothing named: the informed default ------------------------------------------------------
  return {
    route: 'direct',
    engine: inputs.nativeHls ? 'native' : 'hls',
    reason: inputs.facts ? 'the stream carries nothing this browser declines' : 'the stream has not been probed yet — the probe records it for next time'
  }
}
