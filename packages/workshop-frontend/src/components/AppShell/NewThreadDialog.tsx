import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useKumoToastManager } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import {
  CapsuleSpecifier,
  ChatAttachmentHandle,
  MessageFormatRef,
  Overseer,
  SlashCommandRequest,
} from '@gadgets/workshop-shared/api'
import { ChatInput } from '../../ChatInterface'
import { useAuthenticatedApi } from '../../AuthContext'
import { composerDraftStorageKey } from '../../composerDraft'
import { getStoredSelectedModel, persistSelectedModel } from '../../modelSelection'
import { useModels } from '../../query/hooks'
import { logRpcFailure } from '../../rpcErrors'
import { OPEN_NEW_THREAD_EVENT, type OpenNewThreadDetail } from './newThreadBus'

export default function NewThreadDialog() {
  const { authenticatedApi, currentUser } = useAuthenticatedApi()
  const navigate = useNavigate()
  const toasts = useKumoToastManager()
  const { data: models = [] } = useModels()

  const [open, setOpen] = useState(false)
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null)
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const provisionalOverseerRef = useRef<{ stub: RpcStub<Overseer> } | null>(null)

  useEffect(() => {
    if (models.length > 0) setSelectedModel(getStoredSelectedModel(models))
  }, [models])

  const handleModelChange = useCallback((value: string | null) => {
    setSelectedModel(value)
    persistSelectedModel(value)
  }, [])

  const disposeProvisional = useCallback(() => {
    provisionalOverseerRef.current?.stub[Symbol.dispose]()
    provisionalOverseerRef.current = null
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    setSeed(null)
    disposeProvisional()
  }, [disposeProvisional])

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenNewThreadDetail>).detail
      if (detail?.seed) {
        setSeed((previous) => ({ text: detail.seed!, nonce: (previous?.nonce ?? 0) + 1 }))
      } else {
        setSeed(null)
      }
      setOpen(true)
    }
    window.addEventListener(OPEN_NEW_THREAD_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_NEW_THREAD_EVENT, onOpen)
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [close, open])

  useEffect(() => () => disposeProvisional(), [disposeProvisional])

  const ensureProvisionalGadget = useCallback(() => {
    if (!provisionalOverseerRef.current) {
      provisionalOverseerRef.current = { stub: authenticatedApi.newThread() }
    }
  }, [authenticatedApi])

  const handleSend = useCallback(
    async (
      message: string | SlashCommandRequest,
      modelId: string | null,
      capsules?: CapsuleSpecifier[],
      attachments?: ChatAttachmentHandle[],
      formats?: MessageFormatRef[],
    ) => {
      try {
        ensureProvisionalGadget()
        const overseer = provisionalOverseerRef.current!.stub
        const [, { id }] = await Promise.all([
          overseer.newChat(message, modelId, capsules, attachments, formats),
          overseer.getMetadata(),
        ])
        disposeProvisional()
        setOpen(false)
        setSeed(null)
        navigate({ to: '/thread/$id', params: { id } })
      } catch (err) {
        const transient = logRpcFailure('Failed to create gadget:', err, {
          reportSite: 'thread.create',
        })
        if (!attachments?.length && !capsules?.length) {
          disposeProvisional()
        }
        if (!transient) {
          toasts.add({ title: 'Failed to create thread', variant: 'error' })
        }
        throw err
      }
    },
    [disposeProvisional, ensureProvisionalGadget, navigate, toasts],
  )

  const getOverseer = useCallback((): RpcStub<Overseer> => {
    ensureProvisionalGadget()
    return provisionalOverseerRef.current!.stub
  }, [ensureProvisionalGadget])

  const createCapsuleGatekeeper = useCallback(
    (accountId: number, url: string) => {
      ensureProvisionalGadget()
      return provisionalOverseerRef.current!.stub.newGatekeeper(accountId, url)
    },
    [ensureProvisionalGadget],
  )

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[1600] flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-thread-dialog-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div className="absolute inset-0 bg-black/45" aria-hidden="true" onMouseDown={close} />
      <div className="themed-floating-shadow-lg relative w-full max-w-xl overflow-hidden rounded-2xl border border-kumo-line bg-kumo-elevated">
        <div className="flex items-center justify-between px-3.5 pt-3">
          <button
            type="button"
            onClick={close}
            className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-[13px] leading-5 tracking-[-0.25px] text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default"
          >
            <X size={14} />
            Close
          </button>
          <h2 id="new-thread-dialog-title" className="sr-only">
            New thread
          </h2>
        </div>
        <ChatInput
          createCapsuleGatekeeper={createCapsuleGatekeeper}
          getOverseer={getOverseer}
          onSend={handleSend}
          isAgentActive={false}
          models={models}
          selectedModel={selectedModel}
          onModelChange={handleModelChange}
          newChat
          offerFormats
          dialog
          autoFocus
          minRows={5}
          seedText={seed?.text}
          seedNonce={seed?.nonce}
          draftStorageKey={
            currentUser ? composerDraftStorageKey(currentUser.id, 'home') : undefined
          }
        />
      </div>
    </div>
  )
}
