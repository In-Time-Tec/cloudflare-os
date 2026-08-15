import type { ReactNode } from 'react'

// Two-pane communications layout: a section-scoped list pane (left) and the detail pane (right).
// Borders run the full height of the main area — no PageChrome content-width wrapper here.

export default function CommsLayout({ title, list, detail }: {
  title: string
  list: ReactNode
  detail: ReactNode
}) {
  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex h-14 shrink-0 items-center border-b border-kumo-line px-6">
        <h1 className="min-w-0 truncate text-[14px] font-medium tracking-[-0.25px] text-kumo-default">
          {title}
        </h1>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-80 shrink-0 flex-col overflow-y-auto border-r border-kumo-line">
          {list}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {detail}
        </div>
      </div>
    </div>
  )
}
