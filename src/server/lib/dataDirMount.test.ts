import { describe, expect, it } from 'vitest'
import { dataDirRecoveryHint, parseMountInfo } from './dataDirMount.js'

// A real Synology bind-mount line, and a named-volume line: these are the two shapes a deployment
// here actually produces, and the hint rides on getting them right.
const bindMount = [
  '25 30 0:23 /volume1/docker/allison/appdata /appdata rw,relatime shared:11 - ext4 /dev/vg1/volume_1 rw',
  '26 30 0:24 /volume1/docker/allison/transcode /transcode rw,relatime shared:12 - ext4 /dev/vg1/volume_1 rw',
  '30 1 0:20 / / rw,relatime - ext4 /dev/vg1/volume_1 rw',
  '44 30 0:26 /var/lib/docker/volumes/abc/_data /var/lib/docker/volumes/abc/_data rw,relatime - ext4 /dev/vg1/volume_1 rw'
].join('\n')

describe('parseMountInfo', () => {
  it('finds the host path a bind mount came from', () => {
    const m = parseMountInfo(bindMount, '/appdata')
    expect(m).toMatchObject({ hostPath: '/volume1/docker/allison/appdata', mountPoint: '/appdata', readOnly: false })
  })

  it('picks the most specific mountpoint, not "/"', () => {
    expect(parseMountInfo(bindMount, '/appdata')?.mountPoint).toBe('/appdata')
    expect(parseMountInfo(bindMount, '/somewhere/else')?.mountPoint).toBe('/')
  })

  it('matches a subdirectory of a mount', () => {
    expect(parseMountInfo(bindMount, '/appdata/nested')?.hostPath).toBe('/volume1/docker/allison/appdata')
  })

  it('detects a read-only mount', () => {
    const ro = '25 30 0:23 /volume1/docker/appdata /appdata ro,relatime - ext4 /dev/vg1/volume_1 ro'
    expect(parseMountInfo(ro, '/appdata')?.readOnly).toBe(true)
  })

  it('detects read-only declared only in the superblock options', () => {
    const ro = '25 30 0:23 /volume1/docker/appdata /appdata rw,relatime - ext4 /dev/vg1/volume_1 ro'
    expect(parseMountInfo(ro, '/appdata')?.readOnly).toBe(true)
  })

  it('unescapes spaces in a host path', () => {
    const m = parseMountInfo('25 30 0:23 /volume1/docker/my\\040data /appdata rw - ext4 /dev/vg1/volume_1 rw', '/appdata')
    expect(m?.hostPath).toBe('/volume1/docker/my data')
  })

  it('reports no host path for the root filesystem itself', () => {
    expect(parseMountInfo('30 1 0:20 / / rw,relatime - ext4 /dev/vg1/volume_1 rw', '/')?.hostPath).toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(parseMountInfo('', '/appdata')).toBeNull()
  })
})

describe('dataDirRecoveryHint', () => {
  it('names the exact host path to chown when it knows it', () => {
    const hint = dataDirRecoveryHint('/appdata', 1000, parseMountInfo(bindMount, '/appdata'))
    expect(hint[0]).toBe('Run on the host: sudo chown -R 1000:1000 /volume1/docker/allison/appdata')
    expect(hint[1]).toContain('RESTART')
  })

  it('refuses to suggest a chown for a read-only mount', () => {
    const ro = '25 30 0:23 /volume1/docker/appdata /appdata ro,relatime - ext4 /dev/vg1/volume_1 ro'
    const hint = dataDirRecoveryHint('/appdata', 1000, parseMountInfo(ro, '/appdata'))
    expect(hint[0]).toContain('mounted read-only')
    expect(hint.join(' ')).not.toContain('chown')
  })

  it('falls back to asking the operator how to find the path when the mount table is unavailable', () => {
    const hint = dataDirRecoveryHint('/appdata', 1000, null)
    expect(hint[0]).toContain('docker inspect')
  })

  it('uses uid 1000 when the runtime cannot report one', () => {
    expect(dataDirRecoveryHint('/appdata', null, null)[0]).toContain('1000:1000')
  })
})
