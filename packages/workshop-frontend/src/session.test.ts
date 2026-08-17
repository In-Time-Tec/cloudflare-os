// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { WorkshopSession, AUTH_TOKEN_KEY } from './session'
import type { PublicApi } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'

function stubPublic(overrides: Partial<RpcStub<PublicApi>> = {}): RpcStub<PublicApi> {
  const authenticated = {
    whoami: async () => ({ id: 'user-1', name: 'Ada' }),
    logout: vi.fn<() => Promise<void>>(async () => {}),
    [Symbol.dispose]: vi.fn<() => void>(),
  }
  return {
    authenticate: vi.fn<() => typeof authenticated>(() => authenticated),
    authenticateFromCfAccess: vi.fn<() => typeof authenticated>(() => authenticated),
    onRpcBroken: vi.fn<(handler: (error: unknown) => void) => void>(),
    [Symbol.dispose]: vi.fn<() => void>(),
    ...overrides,
  } as unknown as RpcStub<PublicApi>
}

describe('WorkshopSession', () => {
  it('pipelines token auth without clearing the stub on reconnect', async () => {
    const first = stubPublic()
    const second = stubPublic()
    const startConnection = vi.fn<() => RpcStub<PublicApi>>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
    const storage = {
      getItem: vi.fn<(key: string) => string | null>((key) => key === AUTH_TOKEN_KEY ? 'tok' : null),
      setItem: vi.fn<(key: string, value: string) => void>(),
      removeItem: vi.fn<(key: string) => void>(),
    }
    const session = new WorkshopSession({
      startConnection,
      storage,
      now: () => 0,
      wait: async () => {},
    })
    session.connect()
    await session.applyStoredAuth()
    const firstAuth = session.authenticatedApi
    expect(firstAuth).toBeTruthy()
    expect(session.cacheScope).not.toBe('anonymous')

    const broken = first.onRpcBroken as ReturnType<typeof vi.fn<(handler: (error: unknown) => void) => void>>
    const handler = broken.mock.calls[0][0]
    await handler(new Error('ws closed'))
    expect(session.authenticatedApi).toBeTruthy()
    expect(session.authenticatedApi).not.toBe(firstAuth)
    expect(session.connectionLost).toBe(false)
    expect(session.isAuthenticated).toBe(true)
  })

  it('clears memory and the persisted store on logout', async () => {
    const publicApi = stubPublic()
    const storage = {
      getItem: vi.fn<() => string | null>(() => 'tok'),
      setItem: vi.fn<(key: string, value: string) => void>(),
      removeItem: vi.fn<(key: string) => void>(),
    }
    const session = new WorkshopSession({
      startConnection: () => publicApi,
      storage,
      now: () => 0,
      wait: async () => {},
    })
    session.connect()
    await session.applyStoredAuth()
    const cleanup = vi.fn<(scope: string) => Promise<void>>(async () => {})
    session.setLogoutCleanup(cleanup)
    await session.logout()
    expect(session.authenticatedApi).toBeNull()
    expect(session.cacheScope).toBe('anonymous')
    expect(storage.removeItem).toHaveBeenCalledWith(AUTH_TOKEN_KEY)
    expect(cleanup).toHaveBeenCalled()
  })
})
