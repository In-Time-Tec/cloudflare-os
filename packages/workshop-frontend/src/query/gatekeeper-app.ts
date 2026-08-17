import { workshopSession, type WorkshopSession } from '../session'
import { persistQueryData, queryClient } from './client'
import { accountKey } from './hooks'

export const GATEKEEPER_PERSISTED_GLOBAL = '__GADGETS_PERSISTED__'

export function gatekeeperAppHtmlKey(
  appId: string,
  session: WorkshopSession = workshopSession,
) {
  return accountKey(session.cacheScope, 'gatekeeperAppHtml', appId)
}

export function gatekeeperAppSnapshotKey(
  appId: string,
  session: WorkshopSession = workshopSession,
) {
  return accountKey(session.cacheScope, 'gatekeeperAppSnapshot', appId)
}

export function readGatekeeperAppHtml(appId: string): string | undefined {
  return queryClient.getQueryData(gatekeeperAppHtmlKey(appId))
}

export function readGatekeeperAppSnapshot(appId: string): unknown {
  return queryClient.getQueryData(gatekeeperAppSnapshotKey(appId))
}

export function persistGatekeeperAppHtml(appId: string, html: string): void {
  persistQueryData(queryClient, gatekeeperAppHtmlKey(appId), html)
}

export function persistGatekeeperAppSnapshot(appId: string, snapshot: unknown): void {
  persistQueryData(queryClient, gatekeeperAppSnapshotKey(appId), snapshot)
}

export function withPersistedSnapshot(html: string, snapshot: unknown): string {
  if (snapshot === undefined) return html
  const json = JSON.stringify(snapshot).replace(/</g, '\\u003c')
  const tag = `<script>window.${GATEKEEPER_PERSISTED_GLOBAL}=${json}</script>`
  const headClose = html.search(/<\/head>/i)
  if (headClose >= 0) return `${html.slice(0, headClose)}${tag}${html.slice(headClose)}`
  return `${tag}${html}`
}
