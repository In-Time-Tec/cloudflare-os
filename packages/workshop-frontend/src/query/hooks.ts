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
  return useQuery({ queryKey: whoamiKey, queryFn: async () => await api().whoami() })
}

export function useGadgets() {
  return useQuery({ queryKey: gadgetsKey, queryFn: async () => await api().listGadgets() })
}

export function useGatekeeperApps() {
  return useQuery({ queryKey: gatekeeperAppsKey, queryFn: async () => await api().listGatekeeperApps() })
}


export const amIAdminKey = ['amIAdmin'] as const
export function useAmIAdmin() {
  return useQuery({ queryKey: amIAdminKey, queryFn: async () => await api().amIAdmin() })
}


export const modelsKey = ['models'] as const
export const quickModelKey = ['quickModel'] as const
export const aiConfigKey = ['aiConfig'] as const

export function useModels() {
  return useQuery({ queryKey: modelsKey, queryFn: async () => await api().listModels() })
}

export function useQuickModel() {
  return useQuery({ queryKey: quickModelKey, queryFn: async () => await api().getQuickModel() })
}

export function useAiConfig() {
  return useQuery({ queryKey: aiConfigKey, queryFn: async () => await api().getAiConfig() })
}


export const addableGatekeepersKey = ['addableGatekeepers'] as const
export const gatekeeperVendorsKey = ['gatekeeperVendors'] as const

export function useAddableGatekeepers() {
  return useQuery({ queryKey: addableGatekeepersKey, queryFn: async () => await api().listAddableGatekeepers() })
}

export function useGatekeeperVendors() {
  return useQuery({ queryKey: gatekeeperVendorsKey, queryFn: async () => await api().listGatekeeperVendors() })
}


export const featuredBlueprintsKey = ['featuredBlueprints'] as const
export const ownBlueprintsKey = ['ownBlueprints'] as const
export const libraryBlueprintsKey = ['libraryBlueprints'] as const

export function useFeaturedBlueprints() {
  return useQuery({ queryKey: featuredBlueprintsKey, queryFn: async () => await api().listFeaturedBlueprints() })
}

export function useOwnBlueprints() {
  return useQuery({ queryKey: ownBlueprintsKey, queryFn: async () => await api().listOwnBlueprints() })
}

export function useLibraryBlueprints() {
  return useQuery({ queryKey: libraryBlueprintsKey, queryFn: async () => await api().listLibraryBlueprints() })
}


export const outputsKey = ['outputs'] as const

/** listOutputs is a bounded catch-up sweep; one queryFn loops until the server reports done. */
export function useOutputs() {
  return useQuery({
    queryKey: outputsKey,
    queryFn: async () => {
      for (;;) {
        const { outputs, catchingUp } = await api().listOutputs()
        if (!catchingUp) return outputs
      }
    },
  })
}
