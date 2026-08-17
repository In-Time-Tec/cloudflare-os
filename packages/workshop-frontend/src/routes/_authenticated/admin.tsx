import { createFileRoute, redirect } from '@tanstack/react-router'
import AdminPage from '../../AdminPage'
import { adminSettingsOptions, amIAdminOptions } from '../../query/hooks'

export const Route = createFileRoute('/_authenticated/admin')({
  beforeLoad: async ({ context }) => {
    const isAdmin = await context.queryClient.ensureQueryData(amIAdminOptions(context.session))
    if (!isAdmin) throw redirect({ to: '/' })
  },
  loader: ({ context }) =>
    context.queryClient.ensureQueryData({
      ...adminSettingsOptions(context.session),
      revalidateIfStale: true,
    }),
  component: AdminPage,
})
