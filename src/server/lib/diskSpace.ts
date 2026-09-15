import { statfs } from 'fs/promises'

/**
 * Free space on the filesystem holding a path.
 *
 * Added after a real outage: a host filled its root filesystem to 100%, so SQLite could no longer
 * write and the app reported "disk I/O error". Everything pointed away from the real cause — file
 * ownership was correct, the directory was writable (creating a *file* in it still worked, because
 * ext4 keeps reserved blocks), and the container's own writable layer was tiny. Only `df` showed
 * it. Nothing in the app mentioned space at all.
 */
export interface FilesystemSpace {
  freeBytes: number
  totalBytes: number
}

/** Below this, a SQLite write is about to fail rather than merely be at risk. */
export const LOW_SPACE_THRESHOLD_BYTES = 256 * 1024 * 1024

/** A transcode of a feature film keeps every segment it writes, so it needs real headroom. */
export const LOW_SPACE_THRESHOLD_FOR_TRANSCODE_BYTES = 8 * 1024 * 1024 * 1024

export async function filesystemSpace(path: string): Promise<FilesystemSpace | null> {
  try {
    const info = await statfs(path)
    return { freeBytes: Number(info.bavail) * Number(info.bsize), totalBytes: Number(info.blocks) * Number(info.bsize) }
  } catch {
    // A path that doesn't exist yet, or a platform without statfs — the caller reports "unknown"
    // rather than inventing a number.
    return null
  }
}

export function isLowSpace(freeBytes: number | null | undefined, thresholdBytes = LOW_SPACE_THRESHOLD_BYTES): boolean {
  if (freeBytes === null || freeBytes === undefined) return false
  return freeBytes < thresholdBytes
}

/**
 * Whether there is too little room to start a transcode, and what to tell the viewer.
 *
 * Added because the threshold above existed but was connected to nothing: a session could be
 * started on a filesystem with megabytes left, and — for a film, which keeps every segment so the
 * viewer can scrub — keep writing until the disk was full. At that point SQLite fails to write and
 * the whole app reports "disk I/O error", which is how the earlier outage presented.
 *
 * The two cases genuinely differ. A film keeps everything it writes (a 2h20 feature at ~10.7 Mbps
 * is well over 10 GB), so it needs the full headroom up front. Live TV keeps a small rolling window
 * — a couple of megabytes — so it only needs the same floor as the database, and refusing to
 * transcode a channel because a film-sized reservation is unavailable would be wrong.
 */
export function transcodeSpaceRefusal(freeBytes: number | null | undefined, isVod: boolean): string | null {
  if (freeBytes === null || freeBytes === undefined) return null
  const needed = isVod ? LOW_SPACE_THRESHOLD_FOR_TRANSCODE_BYTES : LOW_SPACE_THRESHOLD_BYTES
  if (freeBytes >= needed) return null
  // MB below a gigabyte: "0.0 GB free" is technically true but useless to read.
  const human = (bytes: number): string =>
    bytes >= 1024 * 1024 * 1024
      ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
      : `${Math.round(bytes / 1024 / 1024)} MB`
  return (
    `Not enough free space to transcode this ${isVod ? 'title' : 'channel'}: ` +
    `${human(freeBytes)} free, ${human(needed)} needed. Free some space and try again.`
  )
}
