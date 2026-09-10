export function normalizeVersion(version: string): number[] {
  const cleaned = version.trim().replace(/^v/i, '')
  const match = cleaned.match(/\d+(?:\.\d+)*/)
  if (!match) return [0]

  return match[0].split('.').map((part) => Number.parseInt(part, 10) || 0)
}

export function compareVersions(current: string, target: string): number {
  const left = normalizeVersion(current)
  const right = normalizeVersion(target)
  const maxLength = Math.max(left.length, right.length)

  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    if (leftValue < rightValue) return -1
    if (leftValue > rightValue) return 1
  }

  return 0
}
