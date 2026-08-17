import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { GadgetMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { workshopSession } from '../session'
import { deleteGadgetOptions, pinGadgetOptions, renameGadgetOptions } from '../query/gadgets'

export function useGadgetMutations() {
  const queryClient = useQueryClient()
  const toasts = useKumoToastManager()
  const pin = useMutation(pinGadgetOptions(workshopSession, queryClient))
  const rename = useMutation(renameGadgetOptions(workshopSession, queryClient))
  const remove = useMutation(deleteGadgetOptions(workshopSession, queryClient))

  return {
    pin,
    rename,
    remove,
    togglePin(gadget: GadgetMetadataWithTimestamps) {
      pin.mutate(
        { id: gadget.id, pinned: !gadget.pinned },
        { onError: () => toasts.add({ title: 'Failed to update favorite status', variant: 'error' }) },
      )
    },
    renameGadget(gadget: GadgetMetadataWithTimestamps, title: string) {
      rename.mutate(
        { id: gadget.id, title },
        { onError: () => toasts.add({ title: 'Failed to rename workspace', variant: 'error' }) },
      )
    },
    deleteGadget(gadget: GadgetMetadataWithTimestamps) {
      return remove.mutateAsync(
        { id: gadget.id, shared: !!gadget.owner },
        {
          onSuccess: () => toasts.add({
            title: gadget.owner ? 'Workspace removed from list' : 'Workspace deleted',
            variant: 'success',
          }),
          onError: () => toasts.add({ title: 'Failed to delete workspace', variant: 'error' }),
        },
      )
    },
  }
}
