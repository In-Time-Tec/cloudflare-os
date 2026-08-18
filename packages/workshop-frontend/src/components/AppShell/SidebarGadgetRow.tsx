import { Link } from '@tanstack/react-router'
import { Star, ShareNetwork, Trash, Pencil } from '@phosphor-icons/react'
import { useState, useEffect, useRef } from 'react'
import type { ThreadMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { PendingIcon, useLinkPending } from '../PendingIcon'
import { threadPreview } from '../../conversations/hoverPreviews'
import { hoverRowClassName } from './sidebarHover'
import { HoverActionBar, HoverFadeLabel, HoverRowTrail, bindRowRef, useRowPreview } from './SidebarHoverRow'

function initials(title: string | undefined): string {
  const t = (title || 'Untitled').trim()
  if (!t) return 'UG'
  const parts = t.split(/\s+/).slice(0, 2)
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || t.slice(0, 2).toUpperCase()
}

export default function SidebarGadgetRow({
  gadget,
  collapsed = false,
  nested = false,
  onTogglePin,
  onRename,
  onShare,
  onDelete,
}: {
  gadget: ThreadMetadataWithTimestamps
  collapsed?: boolean
  /** Render indented as a child thread (spawned by the row above's agent). */
  nested?: boolean
  onTogglePin: (g: ThreadMetadataWithTimestamps) => void
  onRename: (g: ThreadMetadataWithTimestamps, newTitle: string) => void
  onShare: (g: ThreadMetadataWithTimestamps) => void
  onDelete: (g: ThreadMetadataWithTimestamps) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(gadget.title || '')
  const inputRef = useRef<HTMLInputElement>(null)
  const preview = collapsed || renaming ? undefined : threadPreview(gadget)
  const { rowRef, previewBind, previewPortal } = useRowPreview(preview)
  const pending = useLinkPending({ to: '/thread/$id', params: { id: gadget.id } })

  useEffect(() => {
    if (renaming) inputRef.current?.focus()
  }, [renaming])

  const commit = () => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== gadget.title) onRename(gadget, trimmed)
    setRenaming(false)
  }

  const title = gadget.title || 'Untitled thread'
  const rowClass = hoverRowClassName({
    hasActions: !collapsed && !renaming,
    className: `h-7 gap-1.5 rounded-md pr-1 text-sm font-medium leading-5 tracking-normal text-kumo-default${nested ? ' ml-5 border-l border-kumo-line pl-2' : ''}`,
  })
  const activeClass = hoverRowClassName({
    active: true,
    hasActions: !collapsed && !renaming,
    className: `h-7 gap-1.5 rounded-md pr-1 text-sm font-medium leading-5 tracking-normal text-kumo-strong${nested ? ' ml-5 border-l border-kumo-line pl-2' : ''}`,
  })

  return (
    <>
      <Link
        ref={bindRowRef(rowRef)}
        to="/thread/$id"
        params={{ id: gadget.id }}
        className={rowClass}
        activeProps={{ className: activeClass }}
        onClick={(event) => {
          if (renaming) event.preventDefault()
        }}
        title={collapsed ? title : undefined}
        aria-busy={pending}
        {...(renaming || collapsed ? {} : previewBind)}
      >
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center"
          aria-hidden="true"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-kumo-fill text-[10px] font-medium text-kumo-subtle">
            <PendingIcon pending={pending} size={16}>
              {initials(gadget.title)}
            </PendingIcon>
          </span>
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
                className="min-w-0 flex-1 border-b border-kumo-brand bg-transparent text-sm font-medium leading-5 tracking-normal text-kumo-default outline-none"
                onClick={(event) => event.preventDefault()}
                onDoubleClick={(event) => event.preventDefault()}
              />
            ) : (
              <HoverRowTrail>
                <HoverFadeLabel className="text-sm font-medium leading-5 tracking-normal text-kumo-default">
                  {title}
                </HoverFadeLabel>
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
              </HoverRowTrail>
            )}
          </>
        )}

        {collapsed && <span className="sr-only">{title}</span>}
      </Link>
      {previewPortal}
    </>
  )
}
