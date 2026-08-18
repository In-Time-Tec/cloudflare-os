// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { ListRow } from './conversations/primitives'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
window.scrollTo = () => {}

function makeRouter(initial: string) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const emailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/email',
    validateSearch: (search: Record<string, unknown>) => ({
      m: typeof search.m === 'string' ? search.m : undefined,
    }),
    loader: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    },
    component: () => {
      return (
        <div>
          <ListRow title="One" to="/email" search={{ m: '1' }} />
          <ListRow title="Two" to="/email" search={{ m: '2' }} />
          <p data-page>email</p>
        </div>
      )
    },
  })
  const otherRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/threads',
    loader: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    },
    component: () => <p data-page>threads</p>,
  })
  const history = createMemoryHistory({ initialEntries: [initial] })
  return createRouter({
    history,
    routeTree: rootRoute.addChildren([emailRoute, otherRoute]),
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  })
}

describe('link pending match', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
  })

  it('marks only the clicked row pending while the current route stays', async () => {
    const router = makeRouter('/email?m=1')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<RouterProvider router={router} />))
    await act(async () => { await router.load() })
    expect(container.querySelector('[data-page]')?.textContent).toBe('email')

    const two = [...container.querySelectorAll('a')].find((el) => el.textContent?.includes('Two'))
    expect(two).toBeDefined()
    act(() => {
      two!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(two!.getAttribute('aria-busy')).toBe('true')
    expect(container.querySelector('[data-page]')?.textContent).toBe('email')
  })
})
