import { createContext, useContext, type ReactNode } from 'react'
import {
  DEFAULT_UI_FEATURE_FLAGS,
  type UiFeatureFlagName,
  type UiFeatureFlags,
} from '@gadgets/workshop-shared/feature-flags'
import { useFeatureFlagsQuery } from './query/hooks'

type FeatureFlagsContextValue = {
  flags: UiFeatureFlags
  loading: boolean
}

const FeatureFlagsContext = createContext<FeatureFlagsContextValue | null>(null)

export function FeatureFlagsProvider({ children }: { children: ReactNode }) {
  const { data, isPending } = useFeatureFlagsQuery()
  const value: FeatureFlagsContextValue = {
    flags: { ...DEFAULT_UI_FEATURE_FLAGS, ...data },
    loading: isPending && !data,
  }
  return <FeatureFlagsContext.Provider value={value}>{children}</FeatureFlagsContext.Provider>
}

export function useUiFeatureFlags() {
  const context = useContext(FeatureFlagsContext)
  if (!context) {
    throw new Error('useUiFeatureFlags must be used within FeatureFlagsProvider')
  }
  return context
}

export function useUiFeatureFlag(name: UiFeatureFlagName) {
  const { flags, loading } = useUiFeatureFlags()
  return { enabled: flags[name], loading }
}
