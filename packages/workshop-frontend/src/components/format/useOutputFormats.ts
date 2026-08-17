import { useCallback, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { Overseer, OutputFormatOffer } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { useOutputFormatsQuery } from '../../query/hooks'

type AuthenticatedApiStub = ReturnType<typeof useAuthenticatedApi>['authenticatedApi']
type Navigate = ReturnType<typeof useNavigate>
type Toasts = ReturnType<typeof useKumoToastManager>

export type OutputFormats = {
  formats: OutputFormatOffer[]
  creating: string | null
  create: (format: OutputFormatOffer) => Promise<void>
}

export async function createFromFormat(
  api: AuthenticatedApiStub,
  navigate: Navigate,
  toasts: Toasts,
  format: OutputFormatOffer,
): Promise<void> {
  if (format.requiresSetup) {
    navigate({ to: '/blueprint/$id', params: { id: format.blueprintId } })
    return
  }

  let overseer: RpcStub<Overseer> | undefined
  try {
    overseer = await api.newGadgetFromBlueprint(format.blueprintId, {})
    const { id } = await overseer.getMetadata()
    navigate({ to: '/workspace/$id', params: { id } })
  } catch (err) {
    console.error('Failed to create from format:', err)
    toasts.add({ title: `Couldn't create a new ${format.output.noun}`, variant: 'error' })
    throw err
  } finally {
    overseer?.[Symbol.dispose]()
  }
}

export function useOutputFormats(): OutputFormats {
  const { authenticatedApi } = useAuthenticatedApi()
  const navigate = useNavigate()
  const toasts = useKumoToastManager()
  const { data: formats = [] } = useOutputFormatsQuery()
  const [creating, setCreating] = useState<string | null>(null)

  const create = useCallback(async (format: OutputFormatOffer) => {
    setCreating(format.blueprintId)
    try {
      await createFromFormat(authenticatedApi, navigate, toasts, format)
    } catch {
      setCreating(null)
    }
  }, [authenticatedApi, navigate, toasts])

  return { formats, creating, create }
}
