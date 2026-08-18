import { queryOptions, useQuery } from '@tanstack/react-query'
import type { AiChatAuthorInfo, GatekeeperVendorFilter } from '@gadgets/workshop-shared/api'
import { workshopSession, type WorkshopSession } from '../session'
import { persistedQueryMeta } from './client'

export const OUTPUT_CATCH_UP_LIMIT = 32

export function accountKey(scope: string, name: string, ...rest: unknown[]) {
  return ['account', scope, name, ...rest] as const
}

function api(session: WorkshopSession) {
  return session.requireAuthenticatedApi()
}

export function whoamiOptions(session: WorkshopSession) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'whoami'),
    queryFn: async (): Promise<AiChatAuthorInfo> => ({ ...await api(session).whoami() }),
    meta: persistedQueryMeta,
  })
}

export function threadsOptions(session: WorkshopSession) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'threads'),
    queryFn: async () => [...await api(session).listThreads()],
    meta: persistedQueryMeta,
  })
}

export function gatekeeperAppsOptions(session: WorkshopSession) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'gatekeeperApps'),
    queryFn: async () => [...await api(session).listGatekeeperApps()],
    meta: persistedQueryMeta,
  })
}

export function amIAdminOptions(session: WorkshopSession) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'amIAdmin'),
    queryFn: async () => await api(session).amIAdmin(),
    meta: persistedQueryMeta,
  })
}

export function modelsOptions(session: WorkshopSession) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'models'),
    queryFn: async () => [...await api(session).listModels()],
    meta: persistedQueryMeta,
  })
}

export function quickModelOptions(session: WorkshopSession) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'quickModel'),
    queryFn: async () => await api(session).getQuickModel(),
    meta: persistedQueryMeta,
  })
}

export function aiConfigOptions(session: WorkshopSession) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'aiConfig'),
    queryFn: async () => ({ ...await api(session).getAiConfig() }),
    meta: persistedQueryMeta,
  })
}

export function addableGatekeepersOptions(session: WorkshopSession) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'addableGatekeepers'),
    queryFn: async () => [...await api(session).listAddableGatekeepers()],
    meta: persistedQueryMeta,
  })
}

export function gatekeeperVendorsOptions(session: WorkshopSession, filter?: GatekeeperVendorFilter) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'gatekeeperVendors', filter ?? null),
    queryFn: async () => [...await api(session).listGatekeeperVendors(filter)],
    meta: persistedQueryMeta,
  })
}

export function featuredTemplatesOptions(session: WorkshopSession) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'featuredTemplates'),
    queryFn: async () => [...await api(session).listFeaturedTemplates()],
    meta: persistedQueryMeta,
  })
}

export function ownTemplatesOptions(session: WorkshopSession) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'ownTemplates'),
    queryFn: async () => [...await api(session).listOwnTemplates()],
    meta: persistedQueryMeta,
  })
}

export function libraryTemplatesOptions(session: WorkshopSession) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'libraryTemplates'),
    queryFn: async () => [...await api(session).listLibraryTemplates()],
    meta: persistedQueryMeta,
  })
}

export function outputsOptions(session: WorkshopSession) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'outputs'),
    queryFn: async () => {
      for (let attempt = 0; attempt < OUTPUT_CATCH_UP_LIMIT; attempt += 1) {
        const { outputs, catchingUp } = await api(session).listOutputs()
        if (!catchingUp) return [...outputs]
      }
      throw new Error(`Output index did not catch up within ${OUTPUT_CATCH_UP_LIMIT} attempts`)
    },
    meta: persistedQueryMeta,
  })
}

export function onboardingOptions(session: WorkshopSession) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'onboardingCompleted'),
    queryFn: async () => await api(session).isOnboardingCompleted(),
    meta: persistedQueryMeta,
  })
}

export function featureFlagsOptions(session: WorkshopSession) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'featureFlags'),
    queryFn: async () => ({ ...await api(session).getUiFeatureFlags() }),
    meta: persistedQueryMeta,
  })
}

export function outputFormatsOptions(session: WorkshopSession) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'outputFormats'),
    queryFn: async () => [...await api(session).listOutputFormats()],
    meta: persistedQueryMeta,
  })
}

export function adminSettingsOptions(session: WorkshopSession) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'adminSettings'),
    queryFn: async () => {
      const admin = await session.ensureAdminApi()
      if (!admin) throw new Error('Not an admin')
      const view = await admin.getSettings()
      return {
        ...view,
        resourceVendors: [...view.resourceVendors],
        formats: [...view.formats],
      }
    },
    meta: persistedQueryMeta,
  })
}

export const whoamiKey = (session: WorkshopSession = workshopSession) => whoamiOptions(session).queryKey
export const threadsKey = (session: WorkshopSession = workshopSession) => threadsOptions(session).queryKey
export const gatekeeperAppsKey = (session: WorkshopSession = workshopSession) => gatekeeperAppsOptions(session).queryKey
export const amIAdminKey = (session: WorkshopSession = workshopSession) => amIAdminOptions(session).queryKey
export const modelsKey = (session: WorkshopSession = workshopSession) => modelsOptions(session).queryKey
export const quickModelKey = (session: WorkshopSession = workshopSession) => quickModelOptions(session).queryKey
export const aiConfigKey = (session: WorkshopSession = workshopSession) => aiConfigOptions(session).queryKey
export const addableGatekeepersKey = (session: WorkshopSession = workshopSession) => addableGatekeepersOptions(session).queryKey
export const gatekeeperVendorsKey = (session: WorkshopSession = workshopSession) => gatekeeperVendorsOptions(session).queryKey
export const featuredTemplatesKey = (session: WorkshopSession = workshopSession) => featuredTemplatesOptions(session).queryKey
export const ownTemplatesKey = (session: WorkshopSession = workshopSession) => ownTemplatesOptions(session).queryKey
export const libraryTemplatesKey = (session: WorkshopSession = workshopSession) => libraryTemplatesOptions(session).queryKey
export const outputsKey = (session: WorkshopSession = workshopSession) => outputsOptions(session).queryKey
export const adminSettingsKey = (session: WorkshopSession = workshopSession) => adminSettingsOptions(session).queryKey

export function useWhoami() {
  return useQuery(whoamiOptions(workshopSession))
}

export function useThreads() {
  return useQuery(threadsOptions(workshopSession))
}

export function useGatekeeperApps() {
  return useQuery(gatekeeperAppsOptions(workshopSession))
}

export function useAmIAdmin() {
  return useQuery(amIAdminOptions(workshopSession))
}

export function useModels() {
  return useQuery(modelsOptions(workshopSession))
}

export function useQuickModel() {
  return useQuery(quickModelOptions(workshopSession))
}

export function useAiConfig() {
  return useQuery(aiConfigOptions(workshopSession))
}

export function useAddableGatekeepers() {
  return useQuery(addableGatekeepersOptions(workshopSession))
}

export function useGatekeeperVendors() {
  return useQuery(gatekeeperVendorsOptions(workshopSession))
}

export function useFeaturedTemplates() {
  return useQuery(featuredTemplatesOptions(workshopSession))
}

export function useOwnTemplates() {
  return useQuery(ownTemplatesOptions(workshopSession))
}

export function useLibraryTemplates() {
  return useQuery(libraryTemplatesOptions(workshopSession))
}

export function useOutputs() {
  return useQuery(outputsOptions(workshopSession))
}

export function useOnboardingCompleted() {
  return useQuery(onboardingOptions(workshopSession))
}

export function useFeatureFlagsQuery() {
  return useQuery(featureFlagsOptions(workshopSession))
}

export function useOutputFormatsQuery() {
  return useQuery(outputFormatsOptions(workshopSession))
}

export function useAdminSettings() {
  return useQuery(adminSettingsOptions(workshopSession))
}
