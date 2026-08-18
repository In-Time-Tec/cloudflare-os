// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { isRedirect } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { Route as AuthenticatedRoute } from './routes/_authenticated'
import { Route as AdminRoute } from './routes/_authenticated/admin'
import { Route as OutputsRoute } from './routes/_authenticated/outputs'
import { Route as LoginRoute } from './routes/login'
import { conversationsCapabilityOptions, emailDetailOptions, emailsOptions } from './query/conversations'
import type { WorkshopSession } from './session'

function context(session: Partial<WorkshopSession>, queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})) {
  return {
    context: { session: session as WorkshopSession, queryClient },
    // `search` is the router's parsed, null-prototype object — not a string. Interpolating it
    // into a template literal throws "Cannot convert object to primitive value".
    location: {
      pathname: '/email',
      search: Object.assign(Object.create(null), { tab: 'inbox' }),
      searchStr: '?tab=inbox',
      hash: '',
      href: '/email?tab=inbox',
    },
    search: { redirect: undefined as string | undefined },
  }
}

async function capture(run: () => Promise<unknown>) {
  try {
    await run()
    return undefined
  } catch (err) {
    return err
  }
}

describe('route guards', () => {
  it('sends unauthenticated users to login with the requested location', async () => {
    const err = await capture(() =>
      AuthenticatedRoute.options.beforeLoad!(context({ isAuthenticated: false }) as never),
    )
    expect(isRedirect(err)).toBe(true)
    expect((err as { options: { to: string; search: { redirect: string } } }).options.to).toBe('/login')
    expect((err as { options: { search: { redirect: string } } }).options.search.redirect).toBe('/email?tab=inbox')
  })

  it('lets authenticated users through the authenticated layout', async () => {
    const result = await AuthenticatedRoute.options.beforeLoad!(
      context({ isAuthenticated: true }) as never,
    )
    expect(result).toBeUndefined()
  })

  it('redirects non-admins away from admin', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const session = {
      cacheScope: 'acct',
      isAuthenticated: true,
      requireAuthenticatedApi: () => ({ amIAdmin: async () => false }),
    } as unknown as WorkshopSession
    queryClient.setQueryData(['account', 'acct', 'amIAdmin'], false)
    const err = await capture(() =>
      AdminRoute.options.beforeLoad!(context(session, queryClient) as never),
    )
    expect(isRedirect(err)).toBe(true)
    expect((err as { options: { to: string } }).options.to).toBe('/')
  })

  it('redirects already-authenticated users away from login', async () => {
    const err = await capture(() =>
      LoginRoute.options.beforeLoad!(context({ isAuthenticated: true }) as never),
    )
    expect(isRedirect(err)).toBe(true)
  })

  it('keeps the outputs page mounted when the index fails to load', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const session = {
      cacheScope: 'acct',
      isAuthenticated: true,
      requireAuthenticatedApi: () => ({
        listOutputs: async () => {
          throw new Error('outputs unavailable')
        },
      }),
    } as unknown as WorkshopSession
    await expect(
      OutputsRoute.options.loader!(context(session, queryClient) as never),
    ).resolves.toBeUndefined()
  })
})

describe('email loader cache hit', () => {
  it('does not refetch a warmed email detail', async () => {
    const getEmail = vi.fn<() => Promise<unknown>>()
    const session = {
      cacheScope: 'acct',
      isAuthenticated: true,
      ensureConversationsApi: async () => ({
        listEmails: async () => [],
        getEmail,
      }),
    } as unknown as WorkshopSession
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    queryClient.setQueryData(['account', 'acct', 'conversationsCapability'], true)
    queryClient.setQueryData(['account', 'acct', 'emails'], [{ id: 'm1' }])
    queryClient.setQueryData(['account', 'acct', 'emailDetail', 'm1'], { id: 'm1', subject: 'Hi' })
    await queryClient.ensureQueryData({
      ...conversationsCapabilityOptions(session),
      revalidateIfStale: true,
    })
    await queryClient.ensureQueryData({
      ...emailsOptions(session),
      revalidateIfStale: true,
    })
    await queryClient.ensureQueryData({
      ...emailDetailOptions(session, 'm1'),
      revalidateIfStale: true,
    })
    expect(getEmail).not.toHaveBeenCalled()
  })
})
