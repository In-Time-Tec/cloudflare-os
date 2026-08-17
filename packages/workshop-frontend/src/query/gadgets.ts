import { mutationOptions, type QueryClient } from '@tanstack/react-query'
import type { GadgetMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import type { WorkshopSession } from '../session'
import { gadgetsOptions } from './hooks'

function gadgetsList(queryClient: QueryClient, session: WorkshopSession) {
  return queryClient.getQueryData(gadgetsOptions(session).queryKey)
}

export function pinGadgetOptions(session: WorkshopSession, queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: ['gadgets', 'pin'] as const,
    scope: { id: 'gadgets' },
    mutationFn: async ({ id, pinned }: { id: string; pinned: boolean }) => {
      const overseer = session.requireAuthenticatedApi().openGadget(id)
      try {
        await overseer.setPinned(pinned)
      } finally {
        overseer[Symbol.dispose]()
      }
    },
    onMutate: async ({ id, pinned }) => {
      const key = gadgetsOptions(session).queryKey
      await queryClient.cancelQueries({ queryKey: key })
      const previous = gadgetsList(queryClient, session)
      queryClient.setQueryData(key, (prev: GadgetMetadataWithTimestamps[] | undefined) =>
        (prev ?? []).map((g) => (g.id === id ? { ...g, pinned } : g)))
      return { previous }
    },
    onError: (_error, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(gadgetsOptions(session).queryKey, ctx.previous)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: gadgetsOptions(session).queryKey })
    },
  })
}

export function renameGadgetOptions(session: WorkshopSession, queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: ['gadgets', 'rename'] as const,
    scope: { id: 'gadgets' },
    mutationFn: async ({ id, title }: { id: string; title: string }) => {
      const overseer = session.requireAuthenticatedApi().openGadget(id)
      try {
        await overseer.setTitle(title)
      } finally {
        overseer[Symbol.dispose]()
      }
    },
    onMutate: async ({ id, title }) => {
      const key = gadgetsOptions(session).queryKey
      await queryClient.cancelQueries({ queryKey: key })
      const previous = gadgetsList(queryClient, session)
      queryClient.setQueryData(key, (prev: GadgetMetadataWithTimestamps[] | undefined) =>
        (prev ?? []).map((g) => (g.id === id ? { ...g, title } : g)))
      return { previous }
    },
    onError: (_error, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(gadgetsOptions(session).queryKey, ctx.previous)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: gadgetsOptions(session).queryKey })
    },
  })
}

export function deleteGadgetOptions(session: WorkshopSession, queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: ['gadgets', 'delete'] as const,
    scope: { id: 'gadgets' },
    mutationFn: async ({ id, shared }: { id: string; shared: boolean }) => {
      const api = session.requireAuthenticatedApi()
      if (shared) {
        await api.dismissSharedGadget(id)
        return
      }
      const overseer = api.openGadget(id)
      try {
        await overseer.deleteSelf()
      } finally {
        overseer[Symbol.dispose]()
      }
    },
    onMutate: async ({ id }) => {
      const key = gadgetsOptions(session).queryKey
      await queryClient.cancelQueries({ queryKey: key })
      const previous = gadgetsList(queryClient, session)
      queryClient.setQueryData(key, (prev: GadgetMetadataWithTimestamps[] | undefined) =>
        (prev ?? []).filter((g) => g.id !== id))
      return { previous }
    },
    onError: (_error, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(gadgetsOptions(session).queryKey, ctx.previous)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: gadgetsOptions(session).queryKey })
    },
  })
}
