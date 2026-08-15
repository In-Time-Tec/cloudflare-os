import { useGatekeeperApps as useGatekeeperAppsQuery, gatekeeperAppsKey } from './query/hooks'
import { queryClient } from './query/client'
import type { GatekeeperAppInfo } from '@gadgets/workshop-shared/api'

/**
 * Invalidate the cached gatekeeper-apps list so mounted hooks refetch. Callers pass the api stub
 * only for API familiarity — the query cache is keyed by the query key, not the stub (the active
 * stub is held in query/api.ts).
 */
export function refreshGatekeeperApps(_api: object): void {
  void queryClient.invalidateQueries({ queryKey: gatekeeperAppsKey })
}

/**
 * The gatekeeper-served management apps available to the current user (one per gatekeeper that sets
 * `providesUi`, e.g. the Context Library). Backed by the shared query cache, so the sidebar and the
 * /gatekeepers/$appId page share one request. Returns [] until loaded.
 */
export function useGatekeeperApps(): GatekeeperAppInfo[] {
  const { data = [] } = useGatekeeperAppsQuery()
  return data
}
