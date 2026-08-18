import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * The sidebar's scrolling middle: everything between the pinned brand row and the pinned utility
 * strip. Gradient fades appear at the top/bottom edges only while content is actually scrolled
 * beneath them, so a fully-scrolled list has no dead gradient sitting over it.
 */
export default function SidebarScrollRegion({ children }: { children: ReactNode }) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [atTop, setAtTop] = useState(true)
  const [atBottom, setAtBottom] = useState(true)

  const update = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    setAtTop(el.scrollTop <= 1)
    setAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - 1)
  }, [])

  // Re-check on scroll, on viewport resize, and whenever the lists inside grow/shrink
  // (sections collapse, threads load, conversations arrive).
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    for (const child of el.children) observer.observe(child)
    const mutations = new MutationObserver(() => {
      update()
      for (const child of el.children) observer.observe(child)
    })
    mutations.observe(el, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      mutations.disconnect()
    }
  }, [update])

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollerRef}
        onScroll={update}
        className="sidebar-scroll h-full overflow-y-auto"
      >
        {children}
      </div>
      <div
        aria-hidden="true"
        className={[
          'pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-kumo-elevated to-transparent transition-opacity duration-150',
          atTop ? 'opacity-0' : 'opacity-100',
        ].join(' ')}
      />
      <div
        aria-hidden="true"
        className={[
          'pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-kumo-elevated to-transparent transition-opacity duration-150',
          atBottom ? 'opacity-0' : 'opacity-100',
        ].join(' ')}
      />
    </div>
  )
}
