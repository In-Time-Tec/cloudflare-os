import type { WorkpieceSummary } from '@gadgets/workshop-shared/api'
import { workshopSession, type WorkshopSession } from '../session'
import { persistQueryData, queryClient } from './client'
import { accountKey } from './hooks'

export function workspaceWorkpiecesKey(
  workspaceId: string,
  session: WorkshopSession = workshopSession,
) {
  return accountKey(session.cacheScope, 'workspaceWorkpieces', workspaceId)
}

export function readCachedWorkpieces(
  workspaceId: string,
  session: WorkshopSession = workshopSession,
): WorkpieceSummary[] | undefined {
  return queryClient.getQueryData(workspaceWorkpiecesKey(workspaceId, session))
}

export function persistWorkspaceWorkpieces(
  workspaceId: string,
  workpieces: Iterable<WorkpieceSummary>,
  session: WorkshopSession = workshopSession,
): void {
  persistQueryData(queryClient, workspaceWorkpiecesKey(workspaceId, session), [...workpieces])
}
