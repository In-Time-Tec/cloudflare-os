import type { CSSProperties, ReactNode } from 'react'

// Loading placeholders.
//
// The rule this file exists to enforce: a skeleton is never a separate component that mirrors a
// layout, because a mirror always drifts from the thing it mirrors. Instead a component keeps its
// own layout and swaps only the *leaves* — a title becomes a bar of the same line height, an avatar
// becomes a circle of the same size — so the loading and loaded states occupy identical boxes by
// construction and there is nothing to keep in sync.
//
// Consequently these are deliberately small and unopinionated: everything about position, spacing
// and size comes from the caller's existing classes.

/** A neutral placeholder block. Size and shape are the caller's; only the fill is ours. */
export function Skeleton({ className = '', style }: {
  className?: string
  /** For placeholders positioned by computed geometry, e.g. a chip on the calendar's hour grid. */
  style?: CSSProperties
}) {
  return (
    <span
      aria-hidden="true"
      style={style}
      className={`block shrink-0 rounded bg-kumo-fill motion-safe:animate-pulse ${className}`}
    />
  )
}

/**
 * One line of text, or a bar exactly one line-box tall when the text hasn't arrived.
 *
 * `h-[1lh]` is what makes this exact: the bar resolves against the element's own inherited
 * font-size and line-height, so a 13px/18px title and a 10px/16px caption each reserve the height
 * their real text will occupy — without either one restating a pixel value that could go stale.
 */
export function SkeletonText({ children, width, className = '' }: {
  /** The text once loaded. `undefined` renders the placeholder bar. */
  children?: ReactNode
  /** Placeholder width, e.g. `'w-24'`. Ignored once `children` is present. */
  width?: string
  className?: string
}) {
  if (children === undefined || children === null || children === '') {
    // The zero-width space is load-bearing twice over: it gives the bar a line box exactly one
    // line-height tall at the inherited font-size, and it gives it a text baseline. Without one, a
    // baseline-aligned row (as in ListRow's title/timestamp line) aligns the bar by its bottom edge
    // instead and sits it a fraction of a pixel off where the real text will be.
    return (
      <span
        aria-hidden="true"
        className={`block h-[1lh] overflow-hidden rounded bg-kumo-fill motion-safe:animate-pulse ${width ?? 'w-24'} ${className}`}
      >
        {'\u200b'}
      </span>
    )
  }
  return <span className={`block truncate ${className}`}>{children}</span>
}

/** Renders `count` placeholder rows, for lists whose length isn't known until they load. */
export function SkeletonRows({ count, children }: {
  count: number
  children: (index: number) => ReactNode
}) {
  return <>{Array.from({ length: count }, (_, index) => children(index))}</>
}

/**
 * The placeholder for the app's standard list row — a rounded leading tile, a title line and an
 * optional subtitle — as used by workspaces, blueprints, providers, outputs and connectors.
 *
 * The geometry here is the row's, not a guess at it: `px-3 py-2.5` + `gap-3` + `h-9 w-9` tile, and
 * text lines sized by `1lh` at the row's own font sizes. A row is 56px without a subtitle and 58px
 * with one, matching the real rows exactly.
 */
export function SkeletonListRow({ subtitle = true, trailing = false, titleWidth = 'w-44' }: {
  /** Whether the loaded row has a second line. */
  subtitle?: boolean
  /** Whether the loaded row has a right-hand meta column (timestamp, count). */
  trailing?: boolean
  titleWidth?: string
}) {
  return (
    <div aria-hidden="true" className="flex items-center gap-3 rounded-lg px-3 py-2.5">
      <Skeleton className="h-9 w-9 rounded-lg" />
      <div className="min-w-0 flex-1">
        <Skeleton className={`h-[1lh] text-sm ${titleWidth}`} />
        {subtitle && <Skeleton className="mt-0.5 h-[1lh] w-28 text-[12px] leading-4" />}
      </div>
      {trailing && <Skeleton className="hidden h-[1lh] w-16 text-xs lg:block" />}
    </div>
  )
}

/**
 * The placeholder for a media card — a thumbnail above a meta strip of tile + two text lines, as
 * used by Outputs and the blueprint galleries.
 *
 * The meta strip is the part worth stating explicitly: a placeholder that draws only the thumbnail
 * is a whole strip shorter than the card it stands in for, so every card jumps on load.
 */
export function SkeletonThumbnailCard({ aspect = 'aspect-[4/3]' }: { aspect?: string }) {
  return (
    <div aria-hidden="true"
        className="flex flex-col overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
      <Skeleton className={`w-full rounded-none border-b border-kumo-line ${aspect}`} />
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <Skeleton className="h-7 w-7 rounded-lg" />
        <div className="min-w-0 flex-1">
          <Skeleton className="h-[1lh] w-28 text-[13px] leading-[18px]" />
          <Skeleton className="mt-0.5 h-[1lh] w-20 text-[12px] leading-4" />
        </div>
      </div>
    </div>
  )
}
