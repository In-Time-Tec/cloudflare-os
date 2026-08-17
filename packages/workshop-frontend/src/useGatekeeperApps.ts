import { useGatekeeperApps as useGatekeeperAppsQuery, gatekeeperAppsKey } from './query/hooks'
import { queryClient } from './query/client'
import type { GatekeeperAppInfo } from '@gadgets/workshop-shared/api'

export function refreshGatekeeperApps(_api: object): void {
  void queryClient.invalidateQueries({ queryKey: gatekeeperAppsKey() })
}

export function useGatekeeperApps(): GatekeeperAppInfo[] {
  const { data = [] } = useGatekeeperAppsQuery()
  return data
}
