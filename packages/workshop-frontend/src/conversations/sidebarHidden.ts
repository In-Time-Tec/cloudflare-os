export const SIDEBAR_HIDDEN_KEY = 'gadgets:sidebar-hidden'

export type SidebarHiddenKind = 'conversations' | 'channels' | 'emails'

export type SidebarHiddenMap = Record<SidebarHiddenKind, string[]>

const EMPTY: SidebarHiddenMap = {
  conversations: [],
  channels: [],
  emails: [],
}

function asIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

export function readSidebarHidden(): SidebarHiddenMap {
  try {
    const raw = localStorage.getItem(SIDEBAR_HIDDEN_KEY)
    if (!raw) return { ...EMPTY, conversations: [], channels: [], emails: [] }
    const parsed = JSON.parse(raw) as Partial<SidebarHiddenMap>
    return {
      conversations: asIds(parsed.conversations),
      channels: asIds(parsed.channels),
      emails: asIds(parsed.emails),
    }
  } catch {
    return { conversations: [], channels: [], emails: [] }
  }
}

export function writeSidebarHidden(next: SidebarHiddenMap): void {
  try {
    localStorage.setItem(SIDEBAR_HIDDEN_KEY, JSON.stringify(next))
  } catch {
  }
}

export function hideSidebarItem(
  current: SidebarHiddenMap,
  kind: SidebarHiddenKind,
  id: string,
): SidebarHiddenMap {
  if (current[kind].includes(id)) return current
  return { ...current, [kind]: [...current[kind], id] }
}

export function clearSidebarHidden(
  current: SidebarHiddenMap,
  kind: SidebarHiddenKind,
): SidebarHiddenMap {
  if (current[kind].length === 0) return current
  return { ...current, [kind]: [] }
}

export function visibleSidebarItems<T>(
  items: T[],
  hidden: readonly string[],
  idOf: (item: T) => string,
): T[] {
  if (hidden.length === 0) return items
  const blocked = new Set(hidden)
  return items.filter((item) => !blocked.has(idOf(item)))
}
