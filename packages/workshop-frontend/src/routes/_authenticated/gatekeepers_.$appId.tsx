import { createFileRoute } from '@tanstack/react-router'
import GatekeeperAppPage from '../../GatekeeperAppPage'
import { useDocumentTitle } from '../../useDocumentTitle'
import { useGatekeeperApps } from '../../useGatekeeperApps'
import { ensureGatekeeperAppHtml } from '../../query/gatekeeper-app'

/**
 * Generic host for any gatekeeper-served management app (VendorDescription.providesUi). The set of
 * apps and their nav entries come from the backend (useGatekeeperApps); nothing about a specific
 * gatekeeper is hardcoded here. GatekeeperAppPage renders "not available" if the id isn't bound.
 *
 * The file is `gatekeepers_.$appId` (trailing underscore) so the URL is /gatekeepers/$appId without
 * nesting inside the /gatekeepers connectors page's component.
 */
export const Route = createFileRoute('/_authenticated/gatekeepers_/$appId')({
  loader: ({ context, params }) =>
    ensureGatekeeperAppHtml(params.appId, () =>
      context.session.requireAuthenticatedApi().getGatekeeperApp(params.appId),
    ),
  component: GatekeeperApp,
})

function GatekeeperApp() {
  const { appId } = Route.useParams()
  const app = useGatekeeperApps().find((a) => a.id === appId)
  useDocumentTitle(app?.title ?? 'App')
  return <GatekeeperAppPage appId={appId} />
}
