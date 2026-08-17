import { createFileRoute } from '@tanstack/react-router'
import BlueprintLandingPage from '../BlueprintLandingPage'
import Header from '../components/Header'
import { AuthProvider } from '../AuthContext'
import AppShell from '../components/AppShell/AppShell'
import { useWorkshopSession } from '../session'
import { loadAuthenticatedShell } from '../query/shell'
import { publicBlueprintOptions } from '../query/public'

export const Route = createFileRoute('/blueprint/$id')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData({
      ...publicBlueprintOptions(context.session, params.id),
      revalidateIfStale: true,
    })
    if (context.session.isAuthenticated) {
      await loadAuthenticatedShell(context.session, context.queryClient)
    }
  },
  component: BlueprintRoute,
})

function BlueprintRoute() {
  const session = useWorkshopSession()
  const page = <BlueprintLandingPage rpcStub={session.publicApi} />
  if (session.isAuthenticated) {
    return (
      <AuthProvider>
        <AppShell>{page}</AppShell>
      </AuthProvider>
    )
  }
  return (
    <>
      <Header />
      {page}
    </>
  )
}
