import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { useIsRestoring } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { RpcStub } from 'capnweb'
import { PublicApi } from '@gadgets/workshop-shared/api'
import {
  createAccountPersister,
  createAccountPersistOptions,
  queryClient,
} from './query/client'
import { clearGatekeeperFrames } from './query/gatekeeper-app'
import { ThemeProvider } from './ThemeContext'
import { createRouter } from './router'
import AnnouncementBanner from './components/AnnouncementBanner'
import { applyStoredThemeMode } from './theme'
import './styles.css'
import FrontendErrorBoundary from './FrontendErrorBoundary'
import { installWorkshopErrorReporting, reportIssue } from './errorReporting'
import { workshopSession } from './session'

async function devAutoLogin(stub: RpcStub<PublicApi>): Promise<void> {
  if (import.meta.env.VITE_DEV_AUTO_LOGIN !== 'true') return
  if (localStorage.getItem('authToken')) return

  const username = import.meta.env.VITE_DEV_USERNAME ?? 'dev'
  const password = import.meta.env.VITE_DEV_PASSWORD ?? 'devpassword'

  const { hashPassword } = await import('./passwordHash')
  const passwordHash = await hashPassword(username, password)

  let token = await stub.createAccount(username, username, passwordHash)
  if (!token) {
    token = await stub.login(username, passwordHash)
  }
  if (token) {
    localStorage.setItem('authToken', token)
  }
}

installWorkshopErrorReporting()
applyStoredThemeMode()

workshopSession.connect()
await devAutoLogin(workshopSession.publicApi).catch(() => {})
await workshopSession.applyStoredAuth()

workshopSession.setLogoutCleanup(async (scope) => {
  queryClient.clear()
  clearGatekeeperFrames()
  await createAccountPersister(scope).removeClient()
})

const router = createRouter()

workshopSession.onReconnect(() => {
  void queryClient.invalidateQueries()
  void router.invalidate()
})

const persistOptions = createAccountPersistOptions(workshopSession.cacheScope)

function RestoredApp() {
  const isRestoring = useIsRestoring()
  if (isRestoring) return null
  return (
    <ThemeProvider>
      <AnnouncementBanner />
      <RouterProvider
        router={router}
        context={{ session: workshopSession, queryClient }}
      />
    </ThemeProvider>
  )
}

const root = createRoot(document.getElementById('root')!, {
  onUncaughtError: (error) => reportIssue('workshop.react-root', error, {
    handled: false, severity: 'fatal', captureMechanism: 'react',
  }),
})

root.render(
  <StrictMode>
    <FrontendErrorBoundary>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={persistOptions}
      >
        <RestoredApp />
      </PersistQueryClientProvider>
    </FrontendErrorBoundary>
  </StrictMode>,
)
