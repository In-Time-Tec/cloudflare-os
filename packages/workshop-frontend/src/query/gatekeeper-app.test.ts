import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import { queryClient } from './client'
import {
  GATEKEEPER_PERSISTED_GLOBAL,
  clearGatekeeperFrames,
  ensureGatekeeperAppHtml,
  persistGatekeeperAppHtml,
  resolveGatekeeperAppHtml,
  stashGatekeeperFrame,
  takeGatekeeperFrame,
  withHostTheme,
  withPersistedSnapshot,
} from './gatekeeper-app'

function frame(html: string, disposed?: { n: number }): GatekeeperUiFrame {
  return {
    iframeHtml: html,
    ui: {
      [Symbol.dispose]: () => {
        if (disposed) disposed.n += 1
      },
    } as GatekeeperUiFrame['ui'],
  }
}

afterEach(() => {
  clearGatekeeperFrames()
  queryClient.clear()
})

describe('withPersistedSnapshot', () => {
  it('injects a JSON snapshot before </head>', () => {
    const html = '<!doctype html><html><head><title>App</title></head><body></body></html>'
    const next = withPersistedSnapshot(html, { schedules: [{ title: 'Morning brief' }] })
    expect(next).toContain(`window.${GATEKEEPER_PERSISTED_GLOBAL}=`)
    expect(next).toContain('Morning brief')
    expect(next.indexOf(`window.${GATEKEEPER_PERSISTED_GLOBAL}`)).toBeLessThan(next.indexOf('</head>'))
  })

  it('escapes HTML in snapshot JSON', () => {
    const next = withPersistedSnapshot('<html></html>', { title: '</script><img>' })
    expect(next).not.toContain('</script><img>')
    expect(next).toContain('\\u003c/script>')
  })

  it('fills #root with the last paint when a snapshot exists', () => {
    const html = '<html><head></head><body><div id="root"></div></body></html>'
    const next = withPersistedSnapshot(html, { enabled: [] }, '<h1>Context &amp; Skills</h1>')
    expect(next).toContain('<div id="root"><h1>Context &amp; Skills</h1></div>')
    expect(withPersistedSnapshot(html, undefined, '<h1>Nope</h1>')).toBe(html)
  })
})

describe('withHostTheme', () => {
  it('stamps the host mode onto html before first paint', () => {
    const html = '<!doctype html><html lang="en"><head></head><body><div id="root"></div></body></html>'
    const next = withHostTheme(html, { mode: 'dark', baseColor: '#0e1516' })
    expect(next).toContain('data-mode="dark"')
    expect(next).toContain('color-scheme:dark')
    expect(next).toContain('background:#0e1516')
    expect(next.indexOf('data-mode="dark"')).toBeLessThan(next.indexOf('</head>'))
  })

  it('rejects non-color base values', () => {
    const next = withHostTheme('<html><head></head></html>', {
      mode: 'dark',
      baseColor: 'url(javascript:alert(1))',
    })
    expect(next).toContain('background:#0e1516')
    expect(next).not.toContain('javascript')
  })
})

describe('resolveGatekeeperAppHtml', () => {
  it('does not keep the previous app html when the id changes', async () => {
    await persistGatekeeperAppHtml('context', '<!doctype html><title>Context</title>')
    expect(resolveGatekeeperAppHtml('context', {
      appId: 'scheduler',
      iframeHtml: '<!doctype html><title>Scheduler</title>',
    })).toBe('<!doctype html><title>Context</title>')
    expect(resolveGatekeeperAppHtml('scheduler', {
      appId: 'scheduler',
      iframeHtml: '<!doctype html><title>Scheduler</title>',
    })).toBe('<!doctype html><title>Scheduler</title>')
  })
})

describe('ensureGatekeeperAppHtml', () => {
  it('returns cached html without fetching', async () => {
    await persistGatekeeperAppHtml('scheduler', '<!doctype html><title>Scheduler</title>')
    const fetchFrame = vi.fn<() => Promise<GatekeeperUiFrame>>(async () => frame('<!doctype html><title>Fresh</title>'))
    await expect(ensureGatekeeperAppHtml('scheduler', fetchFrame)).resolves.toBe(
      '<!doctype html><title>Scheduler</title>',
    )
    expect(fetchFrame).not.toHaveBeenCalled()
  })

  it('fetches, persists, and stashes when the cache is empty', async () => {
    const next = frame('<!doctype html><title>Context</title>')
    const fetchFrame = vi.fn<() => Promise<GatekeeperUiFrame>>(async () => next)
    await expect(ensureGatekeeperAppHtml('context', fetchFrame)).resolves.toBe(
      '<!doctype html><title>Context</title>',
    )
    expect(takeGatekeeperFrame('context')).toBe(next)
    expect(resolveGatekeeperAppHtml('context', null)).toBe('<!doctype html><title>Context</title>')
  })
})

describe('stashGatekeeperFrame', () => {
  it('disposes the previous frame for the same app', () => {
    const disposed = { n: 0 }
    stashGatekeeperFrame('scheduler', frame('one', disposed))
    stashGatekeeperFrame('scheduler', frame('two'))
    expect(disposed.n).toBe(1)
    expect(takeGatekeeperFrame('scheduler')?.iframeHtml).toBe('two')
  })
})
