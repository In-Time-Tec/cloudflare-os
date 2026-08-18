import { describe, expect, it } from 'vitest'
import { asTime, formatRelativeTime } from './time'

describe('asTime', () => {
  it('reads Date, ISO, and epoch values', () => {
    const when = new Date('2026-08-15T12:00:00.000Z')
    expect(asTime(when)).toBe(when.getTime())
    expect(asTime(when.toISOString())).toBe(when.getTime())
    expect(asTime(when.getTime())).toBe(when.getTime())
    expect(asTime(undefined)).toBe(0)
  })

  it('formats relative time from Date or ISO strings', () => {
    expect(formatRelativeTime(new Date())).toBe('just now')
    expect(formatRelativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m ago')
    expect(formatRelativeTime(undefined)).toBe(formatRelativeTime(0))
  })
})
