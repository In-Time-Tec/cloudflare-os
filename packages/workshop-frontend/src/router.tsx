import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen'
import type { WorkshopSession } from './session'
import RouteError from './components/AppShell/RouteError'

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
    defaultErrorComponent: RouteError,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>
  }
}
