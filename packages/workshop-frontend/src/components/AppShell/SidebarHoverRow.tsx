import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
  SIDEBAR_PREVIEW_HANDOFF_MS,
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

export type PreviewPlacement = 'beside' | 'below'

function PreviewCard({ preview, top, left, placement }: {
  preview: SidebarHoverPreview
  top: number
  left: number
  placement: PreviewPlacement
}) {
  return (
    <div
      role="tooltip"
      data-sidebar-preview=""
      data-placement={placement}
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

type ShownPreview = {
  preview: SidebarHoverPreview
  top: number
  left: number
  placement: PreviewPlacement
}

type PreviewController = {
  show(preview: SidebarHoverPreview, row: HTMLElement, placement?: PreviewPlacement): void
  hide(): void
}

const PreviewContext = createContext<PreviewController | null>(null)

function previewBox(row: HTMLElement, placement: PreviewPlacement): { top: number; left: number } {
  const rect = row.getBoundingClientRect()
  if (placement === 'below') {
    return {
      left: Math.min(Math.max(8, rect.right - 280), window.innerWidth - 288),
      top: Math.min(rect.bottom + 8, Math.max(8, window.innerHeight - 168)),
    }
  }
  return {
    left: Math.min(rect.right + 8, Math.max(8, window.innerWidth - 296)),
    top: Math.max(8, Math.min(rect.top, window.innerHeight - 168)),
  }
}

export function SidebarHoverPreviewProvider({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<ShownPreview | null>(null)
  const openRef = useRef(false)
  const showTimerRef = useRef(0)
  const hideTimerRef = useRef(0)

  const clearTimers = useCallback(() => {
    window.clearTimeout(showTimerRef.current)
    window.clearTimeout(hideTimerRef.current)
  }, [])

  const close = useCallback(() => {
    clearTimers()
    openRef.current = false
    setShown(null)
  }, [clearTimers])

  const show = useCallback((preview: SidebarHoverPreview, row: HTMLElement, placement: PreviewPlacement = 'beside') => {
    const hover = window.matchMedia?.('(hover: hover)')
    const coarse = window.matchMedia?.('(pointer: coarse)')
    if (hover?.matches === false && coarse?.matches === true) return
    window.clearTimeout(hideTimerRef.current)
    window.clearTimeout(showTimerRef.current)
    const reveal = () => {
      openRef.current = true
      setShown({ preview, placement, ...previewBox(row, placement) })
    }
    if (openRef.current) reveal()
    else showTimerRef.current = window.setTimeout(reveal, SIDEBAR_PREVIEW_DELAY_MS)
  }, [])

  const hide = useCallback(() => {
    window.clearTimeout(showTimerRef.current)
    window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = window.setTimeout(close, SIDEBAR_PREVIEW_HANDOFF_MS)
  }, [close])

  useEffect(() => () => clearTimers(), [clearTimers])

  useEffect(() => {
    if (!shown) return
    window.addEventListener('scroll', close, true)
    return () => window.removeEventListener('scroll', close, true)
  }, [shown, close])

  const controller = useMemo(() => ({ show, hide }), [show, hide])

  return (
    <PreviewContext.Provider value={controller}>
      {children}
      {shown
        ? createPortal(
            <PreviewCard
              preview={shown.preview}
              top={shown.top}
              left={shown.left}
              placement={shown.placement}
            />,
            document.body,
          )
        : null}
    </PreviewContext.Provider>
  )
}

export function useRowPreview(
  preview: SidebarHoverPreview | undefined,
  options?: { placement?: PreviewPlacement },
): {
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
  const controller = useContext(PreviewContext)
  const previewRef = useRef(preview)
  previewRef.current = preview
  const placement = options?.placement ?? 'beside'
  const hoveringRef = useRef(false)

  const show = useCallback(() => {
    const next = previewRef.current
    const row = rowRef.current
    if (!next || !row) return
    hoveringRef.current = true
    controller?.show(next, row, placement)
  }, [controller, placement])

  const hide = useCallback(() => {
    hoveringRef.current = false
    controller?.hide()
  }, [controller])

  useEffect(() => {
    if (hoveringRef.current) show()
  }, [preview, show])

  return {
    rowRef,
    previewBind: {
      onMouseEnter: show,
      onMouseLeave: hide,
      onFocus: show,
      onBlur(event: FocusEvent<HTMLElement>) {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hide()
      },
    },
    previewPortal: null,
  }
}

export function bindRowRef(ref: RefObject<HTMLElement | null>): Ref<HTMLAnchorElement> {
  return (el) => {
    ref.current = el
  }
}
