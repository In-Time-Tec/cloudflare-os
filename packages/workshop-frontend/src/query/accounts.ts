import { queryOptions, useQuery } from '@tanstack/react-query'
import type {
  AccountDescription,
  SupportedResource,
  VendorDescription,
} from '@gadgets/workshop-shared/gatekeeper'
import { AccountsSubscriberAdapter } from '../accountsSubscriber'
import { workshopSession, type WorkshopSession } from '../session'
import { persistedQueryMeta } from './client'
import { accountKey } from './hooks'

export type ConnectedAccountSnapshot = {
  id: number
  accountDescription: AccountDescription
  vendorId: string
  vendorDescription: VendorDescription
  supportedResources: SupportedResource[]
  credentialsValid: boolean
}

function api(session: WorkshopSession) {
  return session.requireAuthenticatedApi()
}

export function connectedAccountsOptions(session: WorkshopSession) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'connectedAccounts'),
    queryFn: async (): Promise<ConnectedAccountSnapshot[]> => {
      const authenticated = api(session)
      return await new Promise((resolve, reject) => {
        const accountMap = new Map<number, ConnectedAccountSnapshot>()
        let settled = false
        const finish = (result: ConnectedAccountSnapshot[] | Error) => {
          if (settled) return
          settled = true
          subscription[Symbol.dispose]()
          if (result instanceof Error) reject(result)
          else resolve(result)
        }
        const subscriber = new AccountsSubscriberAdapter({
          add(event) {
            accountMap.set(event.id, {
              id: event.id,
              accountDescription: event.description,
              vendorId: event.vendorId,
              vendorDescription: event.vendor,
              supportedResources: event.supportedResources,
              credentialsValid: event.credentialsValid,
            })
          },
          remove(id) {
            accountMap.delete(id)
          },
          ready() {
            finish([...accountMap.values()])
          },
        })
        const subscription = authenticated.subscribeConnectedAccounts(subscriber)
        subscription.catch((err) => {
          finish(err instanceof Error ? err : new Error(String(err)))
        })
      })
    },
    meta: persistedQueryMeta,
  })
}

export const connectedAccountsKey = (session: WorkshopSession = workshopSession) =>
  connectedAccountsOptions(session).queryKey

export function useConnectedAccounts() {
  return useQuery(connectedAccountsOptions(workshopSession))
}
