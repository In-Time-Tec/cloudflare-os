import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { AuthProvider } from '../AuthContext'
import { FeatureFlagsProvider } from '../FeatureFlagsContext'
import AppShell from '../components/AppShell/AppShell'
import OnboardingWizard from '../OnboardingWizard'
import AccountSelectionModal from '../components/billing/AccountSelectionModal'
import { loadAuthenticatedShell } from '../query/shell'
import { onboardingOptions, useOnboardingCompleted } from '../query/hooks'
import { workshopSession } from '../session'

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: ({ context, location }) => {
    if (!context.session.isAuthenticated) {
      throw redirect({
        to: '/login',
        search: { redirect: location.href },
      })
    }
  },
  loader: ({ context }) => loadAuthenticatedShell(context.session, context.queryClient),
  component: AuthenticatedLayout,
})

function AuthenticatedLayout() {
  const queryClient = useQueryClient()
  const { data: completed = true } = useOnboardingCompleted()

  if (!completed) {
    return (
      <AuthProvider>
        <OnboardingWizard
          onComplete={() => {
            queryClient.setQueryData(onboardingOptions(workshopSession).queryKey, true)
            void queryClient.invalidateQueries({ queryKey: onboardingOptions(workshopSession).queryKey })
          }}
        />
      </AuthProvider>
    )
  }

  return (
    <AuthProvider>
      <FeatureFlagsProvider>
        <AccountSelectionModal />
        <AppShell>
          <Outlet />
        </AppShell>
      </FeatureFlagsProvider>
    </AuthProvider>
  )
}
