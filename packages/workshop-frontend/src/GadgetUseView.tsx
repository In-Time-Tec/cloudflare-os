import { FormatGlyph } from './components/format/FormatVisuals'
import { RpcStub } from 'capnweb'
import {
  AuthenticatedApi,
  Overseer,
  GadgetClient,
  GadgetMetadata,
  WorkpieceId,
  WorkpieceSummary,
} from '@gadgets/workshop-shared/api'
import GadgetUI from './GadgetUI'
import { GadgetPresence } from './components/GadgetPresence'
import GadgetExportMenu from './GadgetExportMenu'

type Props = {
  overseer: RpcStub<Overseer>
  gadget: RpcStub<GadgetClient> | null
  selectedGadgetId: WorkpieceId | null
  gadgets: WorkpieceSummary[]
  onSelectGadget: (id: WorkpieceId) => void
  metadata: GadgetMetadata
  authenticatedApi: RpcStub<AuthenticatedApi>
  currentUserId: string | null
}

const TOPBAR_H = 56

export default function GadgetUseView({
  overseer,
  gadget,
  selectedGadgetId,
  gadgets,
  onSelectGadget,
  metadata,
  authenticatedApi,
  currentUserId,
}: Props) {
  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-kumo-base">
      <div
        className="relative flex shrink-0 items-center justify-between gap-3 border-b border-kumo-line px-4 sm:px-6"
        style={{ height: TOPBAR_H }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[14px] font-medium leading-5 tracking-[-0.25px] text-kumo-default">
            {metadata.title}
          </span>

          {metadata.owner && (
            <span className="flex-shrink-0 text-xs text-kumo-inactive">
              by {metadata.owner.name}
            </span>
          )}
        </div>

        {gadgets.length > 1 && (
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
            {gadgets.map(g => (
              <button
                key={g.id}
                type="button"
                onClick={() => onSelectGadget(g.id)}
                aria-current={g.id === selectedGadgetId ? 'true' : undefined}
                className={`flex-shrink-0 cursor-pointer rounded-full px-3 py-1 text-[12px] leading-4 tracking-[-0.2px] transition-colors duration-150 ease-out ${
                  g.id === selectedGadgetId
                    ? 'bg-kumo-contrast font-medium text-kumo-inverse'
                    : 'bg-kumo-tint text-kumo-subtle hover:text-kumo-default'
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <FormatGlyph output={g.output} size="sm" className="flex-shrink-0" weight="regular" />
                  <span className="block max-w-[160px] truncate">{g.title}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-shrink-0 items-center gap-2">
          <GadgetExportMenu
            gadget={gadget}
            gadgetTitle={gadgets.find(g => g.id === selectedGadgetId)?.title ?? 'Gadget'}
          />
          <GadgetPresence
            overseer={overseer}
            authenticatedApi={authenticatedApi}
            currentUserId={currentUserId}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {gadget ? (
          <GadgetUI
            key={selectedGadgetId}
            gadget={gadget}
            height="100%"
            isVisible={true}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <p className="text-sm text-kumo-subtle">This thread has no gadgets yet.</p>
          </div>
        )}
      </div>
    </div>
  )
}
