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

export function publicTemplateOptions(session: WorkshopSession, id: string) {
  return queryOptions({
    queryKey: ['public', 'template', id] as const,
    queryFn: async () => session.publicApi.getTemplate(id),
    meta: persistedQueryMeta,
  })
}

export function useServerConfigQuery() {
  return useQuery(serverConfigOptions(workshopSession))
}

export function usePublicTemplateQuery(id: string) {
  return useQuery({
    ...publicTemplateOptions(workshopSession, id),
    enabled: id.length > 0,
  })
}
