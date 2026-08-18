import { createFileRoute } from '@tanstack/react-router'
import TemplateLandingPage from '../TemplateLandingPage'
import Header from '../components/Header'
import { AuthProvider } from '../AuthContext'
import AppShell from '../components/AppShell/AppShell'
import { useWorkshopSession } from '../session'
import { loadAuthenticatedShell } from '../query/shell'
import { publicTemplateOptions } from '../query/public'

export const Route = createFileRoute('/template/$id')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData({
      ...publicTemplateOptions(context.session, params.id),
      revalidateIfStale: true,
    })
    if (context.session.isAuthenticated) {
      await loadAuthenticatedShell(context.session, context.queryClient)
    }
  },
  component: TemplateRoute,
})

function TemplateRoute() {
  const session = useWorkshopSession()
  const page = <TemplateLandingPage rpcStub={session.publicApi} />
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
