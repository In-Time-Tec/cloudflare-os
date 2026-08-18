import type { ErrorComponentProps } from '@tanstack/react-router'
import { WorkshopButton } from '../WorkshopControls'

export default function RouteError({ reset }: ErrorComponentProps) {
  return (
    <div className="flex h-full items-center justify-center bg-kumo-base px-6 py-12">
      <section className="themed-compact-shadow w-full max-w-md rounded-2xl border border-kumo-line bg-kumo-base px-6 py-8 text-center">
        <h1 className="text-[20px] leading-7 font-semibold tracking-[-0.35px] text-kumo-default">
          Something went wrong
        </h1>
        <p className="mt-2 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
          This page could not be loaded. Try again, or pick another item in the sidebar.
        </p>
        <div className="mt-6 flex items-center justify-center">
          <WorkshopButton tone="primary" onClick={reset}>
            Try again
          </WorkshopButton>
        </div>
      </section>
    </div>
  )
}
