import { readFileSync } from 'fs'
import { dirname, join } from 'path'

/**
 * What the container's own mount table says about where DATA_DIR actually lives on the host, and
 * whether it was even mounted read-write.
 *
 * This exists because of a real deployment failure. The image began running unprivileged (uid
 * 1000), so a data directory created by an earlier, root-running build needed a `chown` — and the
 * boot message could only say "<your appdata dir>", because a process inside a container has no
 * general way to know the host path its bind mount came from. The operator was left guessing, and
 * guessed wrong.
 *
 * /proc/self/mountinfo answers it precisely: for a bind mount, the field before the mountpoint
 * ("root", relative to the filesystem) is the host path that was mounted. Reading it turns the
 * message into `sudo chown -R 1000:1000 /volume1/docker/appdata` — the actual thing to run — and it
 * distinguishes that case from a directory that was mounted `:ro`, which no amount of chowning
 * fixes.
 */

export interface DataDirMount {
  /** Host path this directory was mounted from, when the kernel reports one. */
  hostPath: string | null
  mountPoint: string
  fsType: string | null
  readOnly: boolean
}

/** mountinfo escapes spaces and a few other characters as three-digit octal. */
function unescapeMountField(field: string): string {
  return field.replace(/\\(\d{3})/g, (_match, code: string) => String.fromCharCode(parseInt(code, 8)))
}

/**
 * Parse mountinfo text, returning the entry that covers `target`. Exported for tests — the
 * parsing is the fiddly part and is worth pinning without a container.
 */
export function parseMountInfo(content: string, target: string): DataDirMount | null {
  let best: DataDirMount | null = null
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    const [left, right] = line.split(' - ')
    if (!left || !right) continue
    const fields = left.trim().split(' ')
    const mountPoint = unescapeMountField(fields[4] ?? '')
    if (!mountPoint) continue
    const matches = target === mountPoint || target.startsWith(mountPoint.endsWith('/') ? mountPoint : `${mountPoint}/`)
    if (!matches) continue
    // Longest matching mountpoint wins: /appdata should not be described by "/".
    if (best && best.mountPoint.length >= mountPoint.length) continue
    const rightFields = right.trim().split(' ')
    const mountOptions = (fields[5] ?? '').split(',')
    const superOptions = (rightFields[2] ?? '').split(',')
    const root = unescapeMountField(fields[3] ?? '')
    best = {
      hostPath: root && root !== '/' ? root : null,
      mountPoint,
      fsType: rightFields[0] ?? null,
      readOnly: mountOptions.includes('ro') || superOptions.includes('ro')
    }
  }
  return best
}

/** Reads the running container's own mount table. Null anywhere the file doesn't exist (macOS). */
export function describeDataDirMount(dataDir: string): DataDirMount | null {
  try {
    return parseMountInfo(readFileSync('/proc/self/mountinfo', 'utf8'), dataDir)
  } catch {
    return null
  }
}

/**
 * The instructions to log when the data directory is unusable, tailored to what the mount table
 * actually shows. Kept here (not in index.ts) so the wording that a stuck operator reads is
 * covered by tests.
 */
export function dataDirRecoveryHint(dataDir: string, uid: number | null, mount: DataDirMount | null): string[] {
  if (mount?.readOnly) {
    return [
      `${dataDir} is mounted read-only — no permission change will help.`,
      'Set that volume to read-write in the stack definition (docker: ./appdata:/appdata:rw) and restart.'
    ]
  }
  const who = uid === null ? '1000' : String(uid)
  const target = mount?.hostPath ?? `${dataDir} (its host path — find it with: docker inspect <container> --format "{{range .Mounts}}{{.Source}} -> {{.Destination}}{{end}}")`
  return [
    `Run on the host: sudo chown -R ${who}:${who} ${target}`,
    'Then RESTART this container: SQLite fixes its write mode when it opens the file.'
  ]
}

/** Unused by the hint itself, but keeps path handling consistent for callers that need it. */
export const dataDirParent = (dataDir: string): string => dirname(join(dataDir))
