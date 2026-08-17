import type { QueryClient } from '@tanstack/react-query'
import type { WorkshopSession } from '../session'
import {
  amIAdminOptions,
  featureFlagsOptions,
  gadgetsOptions,
  gatekeeperAppsOptions,
  onboardingOptions,
  whoamiOptions,
} from './hooks'
import { serverConfigOptions } from './public'
import {
  channelsOptions,
  conversationsCapabilityOptions,
  conversationsOptions,
  emailsOptions,
} from './conversations'

export async function loadAuthenticatedShell(session: WorkshopSession, queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.ensureQueryData({ ...serverConfigOptions(session), revalidateIfStale: true }),
    queryClient.ensureQueryData({ ...whoamiOptions(session), revalidateIfStale: true }),
    queryClient.ensureQueryData({ ...amIAdminOptions(session), revalidateIfStale: true }),
    queryClient.ensureQueryData({ ...gadgetsOptions(session), revalidateIfStale: true }),
    queryClient.ensureQueryData({ ...gatekeeperAppsOptions(session), revalidateIfStale: true }),
    queryClient.ensureQueryData({ ...onboardingOptions(session), revalidateIfStale: true }),
    queryClient.ensureQueryData({ ...featureFlagsOptions(session), revalidateIfStale: true }),
  ])
  session.markAlive()
  const available = await queryClient.ensureQueryData({
    ...conversationsCapabilityOptions(session),
    revalidateIfStale: true,
  })
  if (!available) return
  await Promise.all([
    queryClient.ensureQueryData({ ...conversationsOptions(session), revalidateIfStale: true }),
    queryClient.ensureQueryData({ ...channelsOptions(session), revalidateIfStale: true }),
    queryClient.ensureQueryData({ ...emailsOptions(session), revalidateIfStale: true }),
  ])
}
