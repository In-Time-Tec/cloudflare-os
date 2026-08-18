import { mutationOptions, type QueryClient } from '@tanstack/react-query'
import type { ThreadMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import type { WorkshopSession } from '../session'
import { threadsOptions } from './hooks'

function threadsList(queryClient: QueryClient, session: WorkshopSession) {
  return queryClient.getQueryData(threadsOptions(session).queryKey)
}

export function pinThreadOptions(session: WorkshopSession, queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: ['threads', 'pin'] as const,
    scope: { id: 'threads' },
    mutationFn: async ({ id, pinned }: { id: string; pinned: boolean }) => {
      const overseer = session.requireAuthenticatedApi().openThread(id)
      try {
        await overseer.setPinned(pinned)
      } finally {
        overseer[Symbol.dispose]()
      }
    },
    onMutate: async ({ id, pinned }) => {
      const key = threadsOptions(session).queryKey
      await queryClient.cancelQueries({ queryKey: key })
      const previous = threadsList(queryClient, session)
      queryClient.setQueryData(key, (prev: ThreadMetadataWithTimestamps[] | undefined) =>
        (prev ?? []).map((g) => (g.id === id ? { ...g, pinned } : g)))
      return { previous }
    },
    onError: (_error, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(threadsOptions(session).queryKey, ctx.previous)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: threadsOptions(session).queryKey })
    },
  })
}

export function renameThreadOptions(session: WorkshopSession, queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: ['threads', 'rename'] as const,
    scope: { id: 'threads' },
    mutationFn: async ({ id, title }: { id: string; title: string }) => {
      const overseer = session.requireAuthenticatedApi().openThread(id)
      try {
        await overseer.setTitle(title)
      } finally {
        overseer[Symbol.dispose]()
      }
    },
    onMutate: async ({ id, title }) => {
      const key = threadsOptions(session).queryKey
      await queryClient.cancelQueries({ queryKey: key })
      const previous = threadsList(queryClient, session)
      queryClient.setQueryData(key, (prev: ThreadMetadataWithTimestamps[] | undefined) =>
        (prev ?? []).map((g) => (g.id === id ? { ...g, title } : g)))
      return { previous }
    },
    onError: (_error, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(threadsOptions(session).queryKey, ctx.previous)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: threadsOptions(session).queryKey })
    },
  })
}

export function deleteThreadOptions(session: WorkshopSession, queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: ['threads', 'delete'] as const,
    scope: { id: 'threads' },
    mutationFn: async ({ id, shared }: { id: string; shared: boolean }) => {
      const api = session.requireAuthenticatedApi()
      if (shared) {
        await api.dismissSharedThread(id)
        return
      }
      const overseer = api.openThread(id)
      try {
        await overseer.deleteSelf()
      } finally {
        overseer[Symbol.dispose]()
      }
    },
    onMutate: async ({ id }) => {
      const key = threadsOptions(session).queryKey
      await queryClient.cancelQueries({ queryKey: key })
      const previous = threadsList(queryClient, session)
      queryClient.setQueryData(key, (prev: ThreadMetadataWithTimestamps[] | undefined) =>
        (prev ?? []).filter((g) => g.id !== id))
      return { previous }
    },
    onError: (_error, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(threadsOptions(session).queryKey, ctx.previous)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: threadsOptions(session).queryKey })
    },
  })
}
