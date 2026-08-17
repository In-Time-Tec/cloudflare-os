import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen'
import type { WorkshopSession } from './session'

export type WorkshopRouterContext = {
  session: WorkshopSession
  queryClient: QueryClient
}

export function createRouter() {
  return createTanStackRouter({
    routeTree,
    context: {
      session: undefined!,
      queryClient: undefined!,
    },
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>
  }
}
