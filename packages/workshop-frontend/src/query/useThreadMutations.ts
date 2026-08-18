import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { ThreadMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { workshopSession } from '../session'
import { deleteThreadOptions, pinThreadOptions, renameThreadOptions } from '../query/threads'

export function useThreadMutations() {
  const queryClient = useQueryClient()
  const toasts = useKumoToastManager()
  const pin = useMutation(pinThreadOptions(workshopSession, queryClient))
  const rename = useMutation(renameThreadOptions(workshopSession, queryClient))
  const remove = useMutation(deleteThreadOptions(workshopSession, queryClient))

  return {
    pin,
    rename,
    remove,
    togglePin(gadget: ThreadMetadataWithTimestamps) {
      pin.mutate(
        { id: gadget.id, pinned: !gadget.pinned },
        { onError: () => toasts.add({ title: 'Failed to update favorite status', variant: 'error' }) },
      )
    },
    renameThread(gadget: ThreadMetadataWithTimestamps, title: string) {
      rename.mutate(
        { id: gadget.id, title },
        { onError: () => toasts.add({ title: 'Failed to rename thread', variant: 'error' }) },
      )
    },
    deleteThread(gadget: ThreadMetadataWithTimestamps) {
      return remove.mutateAsync(
        { id: gadget.id, shared: !!gadget.owner },
        {
          onSuccess: () => toasts.add({
            title: gadget.owner ? 'Thread removed from list' : 'Thread deleted',
            variant: 'success',
          }),
          onError: () => toasts.add({ title: 'Failed to delete thread', variant: 'error' }),
        },
      )
    },
  }
}
