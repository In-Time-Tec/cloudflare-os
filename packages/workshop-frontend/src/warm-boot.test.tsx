// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'
import { emailDetailOptions, emailsOptions } from './query/conversations'
import { threadsOptions, whoamiOptions } from './query/hooks'
import type { WorkshopSession } from './session'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function sessionStub(): WorkshopSession {
  return {
    cacheScope: 'acct',
    isAuthenticated: true,
    ensureConversationsApi: async () => {
      throw new Error('should not fetch')
    },
    requireAuthenticatedApi: () => {
      throw new Error('should not fetch')
    },
  } as unknown as WorkshopSession
}

function WarmEmail({ session }: { session: WorkshopSession }) {
  const emailList = useQuery(emailsOptions(session))
  const selected = useQuery(emailDetailOptions(session, 'm1'))
  const gadgetList = useQuery(threadsOptions(session))
  const user = useQuery(whoamiOptions(session))
  return (
    <div>
      <nav>{gadgetList.data?.map((g) => <p key={g.id}>{g.title}</p>)}</nav>
      <aside>{emailList.data?.map((e) => <p key={e.id}>{e.subject}</p>)}</aside>
      <article>{selected.data?.subject}</article>
      <span>{user.data?.name}</span>
    </div>
  )
}

describe('warm boot from persisted query cache', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
  })

  it('first React commit contains sidebar, list, and selected email', () => {
    const session = sessionStub()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(whoamiOptions(session).queryKey, { type: 'user', id: 'u1', name: 'Ada' })
    client.setQueryData(threadsOptions(session).queryKey, [
      { id: 'g1', title: 'Quarterly', pinned: false, lastActive: new Date(), created: new Date(), totalCost: 0 },
    ])
    client.setQueryData(emailsOptions(session).queryKey, [
      { id: 'm1', subject: 'Budget review', from: { name: 'Lin', address: 'lin@x' }, received: new Date(), isRead: true, preview: 'Please look at Q3.', hasAttachments: false },
    ])
    client.setQueryData(emailDetailOptions(session, 'm1').queryKey, {
      id: 'm1',
      subject: 'Budget review',
      from: { name: 'Lin', address: 'lin@x' },
      preview: 'Please look at Q3.',
      isRead: true,
      hasAttachments: false,
      to: [],
      html: '<p>Please look at Q3.</p>',
      [Symbol.dispose]: () => {},
    })

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => {
      root!.render(
        <QueryClientProvider client={client}>
          <WarmEmail session={session} />
        </QueryClientProvider>,
      )
    })

    expect(container.textContent).toContain('Quarterly')
    expect(container.textContent).toContain('Budget review')
    expect(container.textContent).toContain('Ada')
  })
})
