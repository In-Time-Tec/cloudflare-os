import { resolveSiteName, type AuthVendorInfo, type ServerConfig } from '@gadgets/workshop-shared/api'
import { useServerConfigQuery } from './query/public'

export function useServerConfig(): ServerConfig | null {
  return useServerConfigQuery().data ?? null
}

export function useServerConfigError(): boolean {
  return useServerConfigQuery().isError
}

export function useSiteName(): string {
  return resolveSiteName(useServerConfig()?.siteName)
}

export function useAuthVendors(): AuthVendorInfo[] {
  return useServerConfig()?.authVendors ?? []
}

export function useCloudflareLimitsEnabled(): boolean {
  return useServerConfig()?.cloudflareLimitsEnabled ?? false
}
