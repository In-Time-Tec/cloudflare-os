// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import { queryClient } from './query/client'
import { persistGatekeeperAppHtml } from './query/gatekeeper-app'

vi.mock('./SandboxedGatekeeperApp', () => ({
  default: ({ frame, gatekeeperVendorId }: {
    frame: { iframeHtml: string }
    gatekeeperVendorId: string
  }) => (
    <iframe data-app={gatekeeperVendorId} srcDoc={frame.iframeHtml} title="Gatekeeper app" sandbox="" />
  ),
}))

const { getGatekeeperApp, authenticatedApi } = vi.hoisted(() => {
  const fetchApp = vi.fn<(id: string) => Promise<GatekeeperUiFrame | null>>()
  return { getGatekeeperApp: fetchApp, authenticatedApi: { getGatekeeperApp: fetchApp } }
})

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi }),
}))

vi.mock('./errorReporting', () => ({
  reportIssue: () => {},
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import GatekeeperAppPage from './GatekeeperAppPage'

function Host({ initial }: { initial: string }) {
  const [appId, setAppId] = useState(initial)
  return (
    <div>
      <button type="button" onClick={() => setAppId(appId === 'scheduler' ? 'context' : 'scheduler')}>
        swap
      </button>
      <GatekeeperAppPage appId={appId} />
    </div>
  )
}

describe('GatekeeperAppPage', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  beforeEach(async () => {
    getGatekeeperApp.mockReset()
    await persistGatekeeperAppHtml('scheduler', '<!doctype html><title>Scheduler</title>')
    await persistGatekeeperAppHtml('context', '<!doctype html><title>Context</title>')
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    queryClient.clear()
  })

  it('paints cached html and swaps apps without keeping the previous iframe', async () => {
    getGatekeeperApp.mockImplementation(async (id) => ({
      iframeHtml: id === 'context'
        ? '<!doctype html><title>Context</title>'
        : '<!doctype html><title>Scheduler</title>',
      ui: {} as GatekeeperUiFrame['ui'],
    }))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Host initial="scheduler" />))
    const first = container.querySelector('iframe')
    expect(first?.getAttribute('data-app')).toBe('scheduler')
    expect(first?.getAttribute('srcdoc')).toContain('Scheduler')

    await act(async () => {
      container!.querySelector('button')!.click()
    })
    const next = container.querySelector('iframe')
    expect(next?.getAttribute('data-app')).toBe('context')
    expect(next?.getAttribute('srcdoc')).toContain('Context')
    expect(next?.getAttribute('srcdoc')).not.toContain('Scheduler')
  })
})
