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

export function gatekeeperAppPaintKey(
  appId: string,
  session: WorkshopSession = workshopSession,
) {
  return accountKey(session.cacheScope, 'gatekeeperAppPaint', appId)
}

export function readGatekeeperAppHtml(appId: string): string | undefined {
  return queryClient.getQueryData(gatekeeperAppHtmlKey(appId))
}

export function readGatekeeperAppSnapshot(appId: string): unknown {
  return queryClient.getQueryData(gatekeeperAppSnapshotKey(appId))
}

export function readGatekeeperAppPaint(appId: string): string | undefined {
  return queryClient.getQueryData(gatekeeperAppPaintKey(appId))
}

export function persistGatekeeperAppHtml(appId: string, html: string): Promise<string> {
  return persistQueryData(queryClient, gatekeeperAppHtmlKey(appId), html)
}

export function persistGatekeeperAppSnapshot(appId: string, snapshot: unknown): Promise<unknown> {
  return persistQueryData(queryClient, gatekeeperAppSnapshotKey(appId), snapshot)
}

const MAX_PAINT_HTML = 500_000

export function persistGatekeeperAppPaint(appId: string, html: string): Promise<string> | undefined {
  if (html.length === 0 || html.length > MAX_PAINT_HTML) return undefined
  return persistQueryData(queryClient, gatekeeperAppPaintKey(appId), html)
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

export function withPersistedSnapshot(html: string, snapshot: unknown, paintHtml?: string): string {
  if (snapshot === undefined) return html
  const json = JSON.stringify(snapshot).replace(/</g, '\\u003c')
  const tag = `<script>window.${GATEKEEPER_PERSISTED_GLOBAL}=${json}</script>`
  const headClose = html.search(/<\/head>/i)
  let next = headClose >= 0 ? `${html.slice(0, headClose)}${tag}${html.slice(headClose)}` : `${tag}${html}`
  if (paintHtml) {
    const safe = paintHtml.replace(/<script\b/gi, '<span')
    next = next.replace(/<div\s+id=["']?root["']?\s*>\s*<\/div>/i, `<div id="root">${safe}</div>`)
  }
  return next
}

export type GatekeeperAppBootTheme = {
  mode: 'light' | 'dark'
  baseColor: string
}

const FALLBACK_BASE = { light: '#fafdf7', dark: '#0e1516' } as const

export function safeThemeBaseColor(value: string, mode: 'light' | 'dark'): string {
  const v = value.trim()
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) return v
  if (/^rgba?\(\s*[\d.]+\s*(,\s*[\d.]+\s*){2}(,\s*[\d.]+\s*)?\)$/.test(v)) return v
  return FALLBACK_BASE[mode]
}

export function readHostBaseColor(mode: 'light' | 'dark'): string {
  if (typeof document === 'undefined') return FALLBACK_BASE[mode]
  return safeThemeBaseColor(
    getComputedStyle(document.documentElement).getPropertyValue('--color-kumo-base'),
    mode,
  )
}

export function withHostTheme(html: string, theme: GatekeeperAppBootTheme): string {
  const mode = theme.mode === 'dark' ? 'dark' : 'light'
  const base = safeThemeBaseColor(theme.baseColor, mode)
  const boot = `<style>html,body,#root{background:${base}!important;color-scheme:${mode}}</style><script>document.documentElement.dataset.mode=${JSON.stringify(mode)};document.documentElement.style.colorScheme=${JSON.stringify(mode)}</script>`
  const next = html.replace(/<html\b([^>]*)>/i, (_all, attrs: string) => {
    const cleaned = String(attrs)
      .replace(/\sdata-mode\s*=\s*(['"]).*?\1/i, '')
      .replace(/\sstyle\s*=\s*(['"]).*?\1/i, '')
    return `<html${cleaned} data-mode="${mode}" style="color-scheme:${mode};background:${base}">`
  })
  const headClose = next.search(/<\/head>/i)
  if (headClose >= 0) return `${next.slice(0, headClose)}${boot}${next.slice(headClose)}`
  return `${boot}${next}`
}
