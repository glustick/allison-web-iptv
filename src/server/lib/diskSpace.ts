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
