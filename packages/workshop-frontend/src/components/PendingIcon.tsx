import { useEffect, useState, type ReactNode } from 'react'
import { useMatchRoute, type LinkProps } from '@tanstack/react-router'
import { DotmHex1 } from './dotm-hex-1'

export const NAV_ICON_PENDING_DELAY_MS = 200

export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!active) {
      setShown(false)
      return
    }
    const id = window.setTimeout(() => setShown(true), delayMs)
    return () => window.clearTimeout(id)
  }, [active, delayMs])
  return shown
}

export function useLinkPending(opts: {
  to: LinkProps['to']
  params?: LinkProps['params']
  search?: LinkProps['search']
}): boolean {
  const matchRoute = useMatchRoute()
  return !!matchRoute({ ...opts, pending: true } as Parameters<typeof matchRoute>[0])
}

export function PendingIcon({
  pending,
  size,
  children,
}: {
  pending: boolean
  size: number
  children: ReactNode
}) {
  const show = useDelayedFlag(pending, NAV_ICON_PENDING_DELAY_MS)
  if (!show) return children
  return <DotmHex1 size={size} />
}
