import type { WorkpieceSummary } from '@gadgets/workshop-shared/api'
import { workshopSession, type WorkshopSession } from '../session'
import { persistQueryData, queryClient } from './client'
import { accountKey } from './hooks'

export function threadWorkpiecesKey(
  threadId: string,
  session: WorkshopSession = workshopSession,
) {
  return accountKey(session.cacheScope, 'threadWorkpieces', threadId)
}

export function readCachedWorkpieces(
  threadId: string,
  session: WorkshopSession = workshopSession,
): WorkpieceSummary[] | undefined {
  return queryClient.getQueryData(threadWorkpiecesKey(threadId, session))
}

export function persistThreadWorkpieces(
  threadId: string,
  workpieces: Iterable<WorkpieceSummary>,
  session: WorkshopSession = workshopSession,
): void {
  persistQueryData(queryClient, threadWorkpiecesKey(threadId, session), [...workpieces])
}
