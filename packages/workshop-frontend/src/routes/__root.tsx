import { useEffect } from 'react'
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import { TooltipProvider, Toasty } from '@cloudflare/kumo'
import type { WorkshopRouterContext } from '../router'
import { useServerConfig } from '../ServerConfigContext'
import { applyAccentColor } from '../theme'
import { applySiteFavicon } from '../siteLogoUtils'

export const Route = createRootRouteWithContext<WorkshopRouterContext>()({
  component: RootComponent,
})

function ServerAppearance() {
  const config = useServerConfig()
  useEffect(() => {
    applyAccentColor(config?.accentColor ?? '')
  }, [config?.accentColor])
  useEffect(() => {
    return applySiteFavicon(config?.siteLogo?.url)
  }, [config])
  return null
}

function RootComponent() {
  return (
    <TooltipProvider>
      <Toasty>
        <ServerAppearance />
        <Outlet />
      </Toasty>
    </TooltipProvider>
  )
}
