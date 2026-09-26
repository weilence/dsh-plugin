export function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== typeof right) return false
  if (left === null || right === null) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => jsonEqual(value, right[index]))
  }
  if (typeof left === 'object') {
    const a = left as Record<string, unknown>
    const b = right as Record<string, unknown>
    const keys = Object.keys(a)
    if (keys.length !== Object.keys(b).length) return false
    return keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
  }
  return false
}

export type WriteOutcome =
  { kind: 'written' } | { kind: 'conflict'; message: string } | { kind: 'refused'; message: string }

export function classifyWrite(
  response: { ok: true } | { ok: false; error: { code?: string; message: string } },
): WriteOutcome {
  if (response.ok) return { kind: 'written' }
  if (response.error.code === 'settings/conflict')
    return { kind: 'conflict', message: response.error.message }
  return { kind: 'refused', message: response.error.message }
}
