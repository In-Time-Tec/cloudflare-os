import { useEffect, useState } from 'react'
import { useIsRestoring } from '@tanstack/react-query'
import { useGadgets, useGatekeeperApps } from '../../query/hooks'
import { useConversations } from '../../conversations/ConversationsContext'

// The sidebar is chrome: it is the same on every page, and a rail that fills in row by row after
// the page is interactive reads as breakage rather than progress. So the shell holds until the
// rail's data is in hand, and the rail itself never renders a placeholder.
//
// Two details make this affordable rather than a stall:
//
//  * The cache is persisted to IndexedDB, so a repeat visit has the lists already. But the restore
//    is asynchronous and the first paint happens before it lands, so this waits on
//    `useIsRestoring` first — otherwise the gate would open on an empty cache and the rail would
//    render empty before filling in, which is the exact flash it exists to prevent.
//  * It reads `isSuccess`, not `isFetched`. Restored data is a cache hit, not a fetch:
//    `isFetched` stays false until a network round trip happens, so gating on it would block a
//    returning user behind a request whose answer is already on screen.
const SIDEBAR_READY_TIMEOUT_MS = 3000

/**
 * Whether the sidebar's data is ready to render in full.
 *
 * Bounded: the rail is not worth a blank window, so past the deadline the shell renders regardless
 * and any section still waiting simply starts empty. The comms queries are `enabled`-gated on a
 * capability that may never arrive, so an unbounded wait here could hang forever.
 */
export function useSidebarReady(): boolean {
  const { isSuccess: gadgetsReady } = useGadgets()
  const { isSuccess: appsReady } = useGatekeeperApps()
  const { available, conversationsReady, channelsReady, emailsReady } = useConversations()
  const isRestoring = useIsRestoring()

  const [deadlinePassed, setDeadlinePassed] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setDeadlinePassed(true), SIDEBAR_READY_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [])

  if (deadlinePassed) return true
  if (isRestoring) return false

  // The workspace lists and the gatekeeper nav rows are on every rail.
  if (!gadgetsReady || !appsReady) return false

  // The comms sections exist only when a connected account provides them; `null` means that is
  // still being probed, so whether they belong on the rail isn't known yet either.
  if (available === null) return false
  if (available && !(conversationsReady && channelsReady && emailsReady)) return false

  return true
}
