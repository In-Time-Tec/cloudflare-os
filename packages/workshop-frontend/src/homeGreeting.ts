export function firstNameOf(name: string | undefined | null): string {
  const part = name?.trim().split(/\s+/)[0]
  return part || ''
}

export function attentionGreeting(name: string | undefined | null): string {
  const first = firstNameOf(name)
  return first ? `What needs attention, ${first}?` : 'What needs attention?'
}

export function glanceDateLabel(date: Date = new Date(), locale?: string): string {
  return date.toLocaleDateString(locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

export function dayStart(date: Date): Date {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

export function addDays(date: Date, amount: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + amount)
  return next
}

export function glanceRange(now = new Date()): { from: Date; to: Date } {
  return { from: dayStart(addDays(now, -1)), to: dayStart(addDays(now, 1)) }
}

export function isSameCalendarDay(value: Date | string | number | undefined, day: Date): boolean {
  if (value == null) return false
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return false
  return date.toDateString() === day.toDateString()
}
