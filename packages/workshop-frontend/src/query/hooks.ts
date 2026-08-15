import { useQuery } from '@tanstack/react-query'
import { getActiveAuthenticatedApi } from './api'

// Boot + sidebar read queries, centralized here so every consumer shares one cache entry per
// resource (deduping the duplicate whoami/listGadgets calls that used to fire per component).
// These hooks only run inside the authenticated shell, by which point useAuth has registered the
// active stub in query/api.ts, so the queryFn can read it synchronously.

export const whoamiKey = ['whoami'] as const
export const gadgetsKey = ['gadgets'] as const
export const gatekeeperAppsKey = ['gatekeeperApps'] as const

function api() {
  const stub = getActiveAuthenticatedApi()
  if (!stub) throw new Error('Not authenticated yet')
  return stub
}

export function useWhoami() {
  return useQuery({ queryKey: whoamiKey, queryFn: () => api().whoami() })
}

export function useGadgets() {
  return useQuery({ queryKey: gadgetsKey, queryFn: () => api().listGadgets() })
}

export function useGatekeeperApps() {
  return useQuery({ queryKey: gatekeeperAppsKey, queryFn: () => api().listGatekeeperApps() })
}


export const amIAdminKey = ['amIAdmin'] as const
export function useAmIAdmin() {
  return useQuery({ queryKey: amIAdminKey, queryFn: () => api().amIAdmin() })
}
