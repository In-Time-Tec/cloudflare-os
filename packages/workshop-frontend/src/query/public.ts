import { queryOptions, useQuery } from '@tanstack/react-query'
import type { ServerConfig } from '@gadgets/workshop-shared/api'
import { workshopSession, type WorkshopSession } from '../session'
import { cacheBustSiteLogoUrl } from '../siteLogoUtils'
import { persistedQueryMeta } from './client'

export function serverConfigOptions(session: WorkshopSession) {
  return queryOptions({
    queryKey: ['public', 'serverConfig'] as const,
    queryFn: async (): Promise<ServerConfig> => {
      const cfg = await session.publicApi.getServerConfig()
      return {
        ...cfg,
        siteLogo: cfg.siteLogo ? { url: cacheBustSiteLogoUrl(cfg.siteLogo.url) } : undefined,
      }
    },
    meta: persistedQueryMeta,
  })
}

export function publicBlueprintOptions(session: WorkshopSession, id: string) {
  return queryOptions({
    queryKey: ['public', 'blueprint', id] as const,
    queryFn: async () => session.publicApi.getBlueprint(id),
    meta: persistedQueryMeta,
  })
}

export function useServerConfigQuery() {
  return useQuery(serverConfigOptions(workshopSession))
}

export function usePublicBlueprintQuery(id: string) {
  return useQuery({
    ...publicBlueprintOptions(workshopSession, id),
    enabled: id.length > 0,
  })
}
