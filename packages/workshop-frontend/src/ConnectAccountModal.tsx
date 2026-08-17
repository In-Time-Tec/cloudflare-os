import { useState, useEffect } from 'react'
import { Dialog, Text, useKumoToastManager } from '@cloudflare/kumo'
import { useQuery } from '@tanstack/react-query'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi, GatekeeperVendorFilter } from '@gadgets/workshop-shared/api'
import VendorCard from './VendorCard'
import { gatekeeperVendorsOptions } from './query/hooks'
import { workshopSession } from './session'

interface ConnectAccountModalProps {
  visible: boolean
  onCancel: () => void
  onInitiated: () => void
  authenticatedApi: RpcStub<AuthenticatedApi>
  filter?: GatekeeperVendorFilter
}

export default function ConnectAccountModal({
  visible,
  onCancel,
  onInitiated,
  authenticatedApi,
  filter,
}: ConnectAccountModalProps) {
  const toasts = useKumoToastManager()
  const [connecting, setConnecting] = useState<string | null>(null)
  const { data: vendorList, isFetched } = useQuery({
    ...gatekeeperVendorsOptions(workshopSession, filter),
    enabled: visible,
  })
  const vendors = (vendorList ?? []).filter(v => !v.unavailable)

  useEffect(() => {
    if (!visible) {
      setConnecting(null)
      return
    }
    const unavailable = (vendorList ?? []).filter(v => v.unavailable)
    if (unavailable.length > 0) {
      toasts.add({
        title: `Some services are temporarily unavailable: ${unavailable.map(v => v.id).join(', ')}`,
        variant: 'warning',
      })
    }
  }, [visible, vendorList, toasts])

  const handleConnect = async (vendorId: string) => {
    setConnecting(vendorId)
    try {
      const result = await authenticatedApi.connectAccount(vendorId)
      window.open(result.url, '_blank', 'noopener,noreferrer')
      onInitiated()
    } catch (error) {
      console.error('Failed to initiate connection:', error)
      toasts.add({ title: 'Failed to start connection flow', variant: 'error' })
      setConnecting(null)
    }
  }

  return (
    <Dialog.Root open={visible} onOpenChange={(open) => { if (!open) onCancel() }}>
      <Dialog className="p-6" size="base">
        <Dialog.Title className="text-lg font-semibold mb-4">Connect Account</Dialog.Title>
        {!isFetched ? (
          null
        ) : vendors.length === 0 ? (
          <div className="text-center py-8">
            <Text variant="secondary">No services available to connect.</Text>
          </div>
        ) : (
          <div className="flex flex-col gap-3 mt-2">
            {vendors.map(vendor => (
              <VendorCard
                key={vendor.id}
                vendor={vendor.description}
                onClick={() => handleConnect(vendor.id)}
                loading={connecting === vendor.id}
                disabled={connecting !== null && connecting !== vendor.id}
              />
            ))}
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  )
}
