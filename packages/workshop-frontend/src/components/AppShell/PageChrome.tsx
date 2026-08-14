import type { ReactNode } from 'react'

export const PAGE_ACTION =
  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[13px] tracking-[-0.25px] text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default disabled:cursor-default disabled:opacity-50'

export default function PageChrome({
  title,
  actions,
  children,
}: {
  title: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-kumo-line px-6">
        <h1 className="min-w-0 truncate text-[14px] font-medium tracking-[-0.25px] text-kumo-default">
          {title}
        </h1>
        {actions ? <div className="flex shrink-0 items-center gap-0.5">{actions}</div> : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto h-full w-full max-w-4xl px-6 py-4 sm:px-10">
          {children}
        </div>
      </div>
    </div>
  )
}
