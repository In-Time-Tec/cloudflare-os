import { createFileRoute, redirect } from '@tanstack/react-router'
import LoginPage from '../LoginPage'
import { CF_ACCESS_MODE } from '../session'
import { serverConfigOptions } from '../query/public'
import { safeRedirectPath } from '../safeRedirect'

type LoginSearch = { redirect?: string }

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
  }),
  beforeLoad: ({ context, search }) => {
    if (CF_ACCESS_MODE) {
      throw redirect({ to: '/' })
    }
    if (context.session.isAuthenticated) {
      throw redirect({ to: safeRedirectPath(search.redirect) })
    }
  },
  loader: ({ context }) =>
    context.queryClient.ensureQueryData({
      ...serverConfigOptions(context.session),
      revalidateIfStale: true,
    }),
  component: LoginRoute,
})

function LoginRoute() {
  const { redirect: redirectTo } = Route.useSearch()
  const rpcStub = Route.useRouteContext().session.publicApi
  return (
    <LoginPage
      rpcStub={rpcStub}
      onLoginSuccess={() => {
        window.location.assign(safeRedirectPath(redirectTo))
      }}
    />
  )
}
