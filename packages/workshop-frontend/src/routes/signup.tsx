import { createFileRoute, redirect } from '@tanstack/react-router'
import SignupPage from '../SignupPage'
import { CF_ACCESS_MODE } from '../session'
import { serverConfigOptions } from '../query/public'

export const Route = createFileRoute('/signup')({
  beforeLoad: () => {
    if (CF_ACCESS_MODE) {
      throw redirect({ to: '/' })
    }
  },
  loader: ({ context }) =>
    context.queryClient.ensureQueryData({
      ...serverConfigOptions(context.session),
      revalidateIfStale: true,
    }),
  component: SignupRoute,
})

function SignupRoute() {
  return <SignupPage rpcStub={Route.useRouteContext().session.publicApi} />
}
