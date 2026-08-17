// Entrypoint for the sandboxed Context Library iframe. All data flows through the host-injected
// ContextApi RPC capability.

import { createRoot } from 'react-dom/client'
import { TooltipProvider, Toasty } from '@cloudflare/kumo'
import { RpcTarget, newMessagePortRpcSession } from 'capnweb'
import type { RpcStub } from 'capnweb'
import type { ContextApi } from '../src/context-types'
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from '@gadgets/workshop-shared/theme'
import ContextLibraryPage, { type ContextLibrarySnapshot } from './ContextLibraryPage'
import { ContextApiProvider, PresentationProvider, type PresentAck } from './bridge'
import { applyAppTheme } from './theme'
import './styles.css'
import ErrorBoundary from './ErrorBoundary'
import { installErrorReporting, reportIssue } from './error-reporting'

installErrorReporting()

// The only capability the iframe exposes back to the host: a receiver for theme pushes.
class AppIframe extends RpcTarget implements GatekeeperAppThemeReceiver {
  setTheme(theme: GatekeeperAppTheme): void {
    applyAppTheme(theme)
  }
}

interface HostCapability extends RpcTarget {
  readonly ui: RpcStub<ContextApi>
  setPresenting(active: boolean): Promise<PresentAck>
  subscribeTheme(receiver: GatekeeperAppThemeReceiver): Promise<GatekeeperAppTheme>
  readPersistedSnapshot(): Promise<ContextLibrarySnapshot | null>
  writePersistedSnapshot(data: ContextLibrarySnapshot): Promise<void>
  writePersistedPaint(html: string): Promise<void>
}

function readBootSnapshot(): ContextLibrarySnapshot | undefined {
  return (window as Window & { __GADGETS_PERSISTED__?: ContextLibrarySnapshot }).__GADGETS_PERSISTED__
}

function main() {
  const root = document.getElementById('root')
  if (!root) throw new Error('missing #root')

  const { port1, port2 } = new MessageChannel()
  // Opaque-origin iframes can't name their parent origin. The parent accepts this handshake only from
  // this frame + null origin; the message only transfers a private port.
  window.parent.postMessage({ type: 'handshake' }, '*', [port2])
  const iframe = new AppIframe()
  const host = newMessagePortRpcSession<HostCapability>(port1, iframe)
  // The initial theme comes back from the call; later changes arrive via iframe.setTheme().
  host.subscribeTheme(iframe).then(applyAppTheme).catch(() => {})

  createRoot(root, {
    onUncaughtError: (error) => reportIssue('context.react-root', error, {
      handled: false, severity: 'fatal', captureMechanism: 'react',
    }),
  }).render(
    <ErrorBoundary><ContextApiProvider value={host.ui}>
      <PresentationProvider setPresenting={(active) => host.setPresenting(active)}>
        <TooltipProvider>
          <Toasty>
            <ContextLibraryPage
              initialSnapshot={readBootSnapshot()}
              persistSnapshot={(snapshot) => host.writePersistedSnapshot(snapshot)}
              persistPaint={() => {
                const paintRoot = document.getElementById('root')
                if (paintRoot) void host.writePersistedPaint(paintRoot.innerHTML)
              }}
            />
          </Toasty>
        </TooltipProvider>
      </PresentationProvider>
    </ContextApiProvider></ErrorBoundary>,
  )
}

main()
