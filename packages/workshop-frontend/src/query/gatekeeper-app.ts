import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import { workshopSession, type WorkshopSession } from '../session'
import { persistQueryData, queryClient } from './client'
import { accountKey } from './hooks'

export const GATEKEEPER_PERSISTED_GLOBAL = '__GADGETS_PERSISTED__'

const liveFrames = new Map<string, GatekeeperUiFrame>()

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

export function persistGatekeeperAppHtml(appId: string, html: string): Promise<string> {
  return persistQueryData(queryClient, gatekeeperAppHtmlKey(appId), html)
}

export function persistGatekeeperAppSnapshot(appId: string, snapshot: unknown): Promise<unknown> {
  return persistQueryData(queryClient, gatekeeperAppSnapshotKey(appId), snapshot)
}

export function disposeGatekeeperFrame(frame: GatekeeperUiFrame | null | undefined): void {
  (frame?.ui as { [Symbol.dispose]?(): void } | undefined)?.[Symbol.dispose]?.()
}

export function stashGatekeeperFrame(appId: string, frame: GatekeeperUiFrame): void {
  const previous = liveFrames.get(appId)
  if (previous && previous !== frame) disposeGatekeeperFrame(previous)
  liveFrames.set(appId, frame)
}

export function takeGatekeeperFrame(appId: string): GatekeeperUiFrame | null {
  const frame = liveFrames.get(appId) ?? null
  if (frame) liveFrames.delete(appId)
  return frame
}

export function clearGatekeeperFrames(): void {
  for (const frame of liveFrames.values()) disposeGatekeeperFrame(frame)
  liveFrames.clear()
}

export function resolveGatekeeperAppHtml(
  appId: string,
  live: { appId: string; iframeHtml: string } | null,
): string | undefined {
  if (live?.appId === appId) return live.iframeHtml
  return readGatekeeperAppHtml(appId)
}

export async function ensureGatekeeperAppHtml(
  appId: string,
  fetchFrame: () => Promise<GatekeeperUiFrame | null>,
): Promise<string | undefined> {
  const cached = readGatekeeperAppHtml(appId)
  if (cached) return cached
  const frame = await fetchFrame()
  if (!frame) return undefined
  persistGatekeeperAppHtml(appId, frame.iframeHtml)
  stashGatekeeperFrame(appId, frame)
  return frame.iframeHtml
}

export function withPersistedSnapshot(html: string, snapshot: unknown): string {
  if (snapshot === undefined) return html
  const json = JSON.stringify(snapshot).replace(/</g, '\\u003c')
  const tag = `<script>window.${GATEKEEPER_PERSISTED_GLOBAL}=${json}</script>`
  const headClose = html.search(/<\/head>/i)
  if (headClose >= 0) return `${html.slice(0, headClose)}${tag}${html.slice(headClose)}`
  return `${tag}${html}`
}
