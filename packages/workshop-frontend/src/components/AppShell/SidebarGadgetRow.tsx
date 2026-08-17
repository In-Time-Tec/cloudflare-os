import { Link } from '@tanstack/react-router'
import { Star, ShareNetwork, Trash, Pencil } from '@phosphor-icons/react'
import { useState, useEffect, useRef } from 'react'
import type { GadgetMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { PendingIcon, useLinkPending } from '../PendingIcon'
import { workspacePreview } from '../../conversations/hoverPreviews'
import { hoverRowClassName } from './sidebarHover'
import { HoverActionBar, HoverFadeLabel, bindRowRef, hoverRowStyle, useRowPreview } from './SidebarHoverRow'

function initials(title: string | undefined): string {
  const t = (title || 'Untitled').trim()
  if (!t) return 'UG'
  const parts = t.split(/\s+/).slice(0, 2)
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || t.slice(0, 2).toUpperCase()
}

export default function SidebarGadgetRow({
  gadget,
  collapsed = false,
  onTogglePin,
  onRename,
  onShare,
  onDelete,
}: {
  gadget: GadgetMetadataWithTimestamps
  collapsed?: boolean
  onTogglePin: (g: GadgetMetadataWithTimestamps) => void
  onRename: (g: GadgetMetadataWithTimestamps, newTitle: string) => void
  onShare: (g: GadgetMetadataWithTimestamps) => void
  onDelete: (g: GadgetMetadataWithTimestamps) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(gadget.title || '')
  const inputRef = useRef<HTMLInputElement>(null)
  const preview = collapsed || renaming ? undefined : workspacePreview(gadget)
  const { rowRef, previewBind, previewPortal } = useRowPreview(preview)
  const pending = useLinkPending({ to: '/workspace/$id', params: { id: gadget.id } })

  useEffect(() => {
    if (renaming) inputRef.current?.focus()
  }, [renaming])

  const commit = () => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== gadget.title) onRename(gadget, trimmed)
    setRenaming(false)
  }

  const title = gadget.title || 'Untitled workspace'
  const rowClass = hoverRowClassName({
    hasActions: !collapsed && !renaming,
    className: 'h-7 gap-1.5 rounded-md pl-1.5 pr-1 text-[12.5px] leading-[18px] tracking-[-0.1px] text-kumo-default',
  })
  const activeClass = hoverRowClassName({
    active: true,
    hasActions: !collapsed && !renaming,
    className: 'h-7 gap-1.5 rounded-md pl-1.5 pr-1 text-[12.5px] leading-[18px] tracking-[-0.1px] text-kumo-strong',
  })

  return (
    <>
      <Link
        ref={bindRowRef(rowRef)}
        to="/workspace/$id"
        params={{ id: gadget.id }}
        className={rowClass}
        style={hoverRowStyle(renaming || collapsed ? 0 : 4)}
        activeProps={{ className: activeClass }}
        onClick={(event) => {
          if (renaming) event.preventDefault()
        }}
        title={collapsed ? title : undefined}
        aria-busy={pending}
        {...(renaming || collapsed ? {} : previewBind)}
      >
        <div
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-kumo-fill text-[10px] font-medium text-kumo-subtle"
          aria-hidden="true"
        >
          <PendingIcon pending={pending} size={16}>
            {initials(gadget.title)}
          </PendingIcon>
        </div>

        {!collapsed && (
          <>
            {renaming ? (
              <input
                ref={inputRef}
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onBlur={commit}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commit()
                  if (event.key === 'Escape') setRenaming(false)
                }}
                className="min-w-0 flex-1 border-b border-kumo-brand bg-transparent text-[12.5px] leading-[18px] tracking-[-0.1px] text-kumo-default outline-none"
                onClick={(event) => event.preventDefault()}
                onDoubleClick={(event) => event.preventDefault()}
              />
            ) : (
              <HoverFadeLabel className="text-[12.5px] leading-[18px] tracking-[-0.1px] text-kumo-default">
                {title}
              </HoverFadeLabel>
            )}

            {!renaming && (
              <HoverActionBar
                actions={[
                  {
                    label: gadget.pinned ? 'Unfavorite' : 'Favorite',
                    icon: <Star size={12} weight={gadget.pinned ? 'fill' : 'regular'} />,
                    onSelect: () => onTogglePin(gadget),
                  },
                  {
                    label: 'Rename',
                    icon: <Pencil size={12} />,
                    onSelect: () => {
                      setRenameValue(gadget.title || '')
                      setRenaming(true)
                    },
                  },
                  {
                    label: 'Share',
                    icon: <ShareNetwork size={12} />,
                    onSelect: () => onShare(gadget),
                  },
                  {
                    label: gadget.owner ? 'Dismiss' : 'Delete',
                    icon: <Trash size={12} />,
                    onSelect: () => onDelete(gadget),
                    danger: true,
                  },
                ]}
              />
            )}
          </>
        )}

        {collapsed && <span className="sr-only">{title}</span>}
      </Link>
      {previewPortal}
    </>
  )
}
