import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { Tooltip } from '@cloudflare/kumo'
import {
  SIDEBAR_PREVIEW_DELAY_MS,
  type SidebarHoverAction,
  type SidebarHoverPreview,
} from './sidebarHover'

export function HoverFadeLabel({ children, className }: {
  children: ReactNode
  className?: string
}) {
  return (
    <span className={['sidebar-hover-label min-w-0 flex-1', className].filter(Boolean).join(' ')}>
      {children}
    </span>
  )
}

export function HoverRowTrail({ children }: { children: ReactNode }) {
  return <span className="flex min-w-0 flex-1 items-center">{children}</span>
}

export function HoverActionBar({ actions }: { actions: SidebarHoverAction[] }) {
  if (actions.length === 0) return null
  return (
    <div
      className="sidebar-hover-actions items-center gap-px"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      {actions.map((action) => (
        <Tooltip key={action.label} content={action.label}>
          <button
            type="button"
            aria-label={action.label}
            className={[
              'flex size-5 cursor-pointer items-center justify-center rounded-md',
              action.danger
                ? 'text-kumo-subtle hover:bg-kumo-danger-tint hover:text-kumo-danger'
                : 'text-kumo-subtle hover:bg-kumo-fill hover:text-kumo-default',
            ].join(' ')}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              action.onSelect()
            }}
          >
            {action.icon}
          </button>
        </Tooltip>
      ))}
    </div>
  )
}

function PreviewCard({ preview, top, left }: {
  preview: SidebarHoverPreview
  top: number
  left: number
}) {
  return (
    <div
      role="tooltip"
      data-sidebar-preview=""
      className="sidebar-hover-preview themed-floating-shadow pointer-events-none fixed z-[1000] w-[280px] rounded-xl border border-kumo-line bg-kumo-base px-3.5 py-3"
      style={{ top, left }}
    >
      <p className="text-[13px] font-medium leading-[18px] tracking-[-0.2px] text-kumo-default">
        {preview.title}
      </p>
      {preview.meta ? (
        <p className="mt-1 text-[11.5px] leading-4 tracking-[-0.1px] text-kumo-inactive">
          {preview.meta}
        </p>
      ) : null}
      {preview.body ? (
        <p className="mt-2 line-clamp-3 text-[12.5px] leading-[17px] tracking-[-0.15px] text-kumo-subtle">
          {preview.body}
        </p>
      ) : null}
      {preview.footer ? (
        <p className="mt-2.5 border-t border-kumo-line pt-2 text-[11px] leading-4 tracking-[-0.1px] text-kumo-inactive">
          {preview.footer}
        </p>
      ) : null}
    </div>
  )
}

export function useRowPreview(preview: SidebarHoverPreview | undefined): {
  rowRef: RefObject<HTMLElement | null>
  previewBind: {
    onMouseEnter(): void
    onMouseLeave(): void
    onFocus(): void
    onBlur(event: FocusEvent<HTMLElement>): void
  }
  previewPortal: ReactNode
} {
  const rowRef = useRef<HTMLElement | null>(null)
  const [box, setBox] = useState<{ top: number; left: number } | null>(null)
  const timerRef = useRef(0)

  const clear = useCallback(() => {
    window.clearTimeout(timerRef.current)
    setBox(null)
  }, [])

  const show = useCallback(() => {
    if (!preview) return
    const hover = window.matchMedia?.('(hover: hover)')
    const coarse = window.matchMedia?.('(pointer: coarse)')
    if (hover?.matches === false && coarse?.matches === true) return
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      const el = rowRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      setBox({
        left: Math.min(rect.right + 8, Math.max(8, window.innerWidth - 296)),
        top: Math.max(8, Math.min(rect.top, window.innerHeight - 168)),
      })
    }, SIDEBAR_PREVIEW_DELAY_MS)
  }, [preview])

  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  useEffect(() => {
    if (!box) return
    const onScroll = () => clear()
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [box, clear])

  return {
    rowRef,
    previewBind: {
      onMouseEnter: show,
      onMouseLeave: clear,
      onFocus: show,
      onBlur(event: FocusEvent<HTMLElement>) {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clear()
      },
    },
    previewPortal: box && preview
      ? createPortal(<PreviewCard preview={preview} top={box.top} left={box.left} />, document.body)
      : null,
  }
}

export function bindRowRef(ref: RefObject<HTMLElement | null>): Ref<HTMLAnchorElement> {
  return (el) => {
    ref.current = el
  }
}
