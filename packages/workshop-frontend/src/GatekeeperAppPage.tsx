import { useEffect, useState } from 'react'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import { useAuthenticatedApi } from './AuthContext'
import SandboxedGatekeeperApp from './SandboxedGatekeeperApp'
import { reportIssue } from './errorReporting'
import {
  disposeGatekeeperFrame,
  persistGatekeeperAppHtml,
  resolveGatekeeperAppHtml,
  takeGatekeeperFrame,
} from './query/gatekeeper-app'

export default function GatekeeperAppPage({ appId }: { appId: string }) {
  const { authenticatedApi } = useAuthenticatedApi()
  const [state, setState] = useState<{ appId: string; frame: GatekeeperUiFrame } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let acquired = takeGatekeeperFrame(appId)
    if (acquired) {
      persistGatekeeperAppHtml(appId, acquired.iframeHtml)
      setState({ appId, frame: acquired })
      setError(null)
    } else {
      setState((current) => (current?.appId === appId ? current : null))
      setError(null)
    }

    if (acquired) {
      return () => {
        cancelled = true
        disposeGatekeeperFrame(acquired)
      }
    }

    authenticatedApi
      .getGatekeeperApp(appId)
      .then((frame) => {
        if (!frame) {
          if (!cancelled) setError('This app is not available on this deployment.')
          return
        }
        if (cancelled) {
          disposeGatekeeperFrame(frame)
          return
        }
        acquired = frame
        persistGatekeeperAppHtml(appId, frame.iframeHtml)
        setState({ appId, frame })
      })
      .catch((err) => {
        console.error('Failed to load gatekeeper app:', err)
        reportIssue('gatekeeper-app.load', err, {
          gatekeeperVendorId: appId,
        })
        if (!cancelled) setError(`${err}`)
      })
    return () => {
      cancelled = true
      disposeGatekeeperFrame(acquired)
    }
  }, [authenticatedApi, appId])

  if (error) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center text-sm text-kumo-subtle">{error}</div>
    )
  }
  const iframeHtml = resolveGatekeeperAppHtml(
    appId,
    state ? { appId: state.appId, iframeHtml: state.frame.iframeHtml } : null,
  )
  if (!iframeHtml) {
    return <div className="h-full min-h-0" />
  }

  return (
    <div className="h-full min-h-0">
      <SandboxedGatekeeperApp
        key={appId}
        frame={{ iframeHtml, ui: state?.appId === appId ? state.frame.ui : undefined }}
        gatekeeperVendorId={appId}
      />
    </div>
  )
}
