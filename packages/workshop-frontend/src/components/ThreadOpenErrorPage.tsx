import { Lock, MagnifyingGlass, WarningCircle } from '@phosphor-icons/react'
import { useEffect, useId, useRef } from 'react'
import {
  getOpenGadgetErrorCode,
  OPEN_GADGET_ERROR_CODES,
} from '@gadgets/workshop-shared/api'
import { WorkshopButton } from './WorkshopControls'

export type ThreadOpenFailureKind = 'access-denied' | 'not-found' | 'unexpected'

const CONTENT = {
  'access-denied': {
    title: "You don't have access to this thread",
    message: 'Ask the thread owner to grant you access, then try again.',
    Icon: Lock,
    retryable: true,
  },
  'not-found': {
    title: 'Thread not found',
    message: 'The link may be incorrect, or the thread may have been deleted.',
    Icon: MagnifyingGlass,
    retryable: false,
  },
  unexpected: {
    title: "We couldn't load this thread",
    message: 'Try again. If the problem continues, return to your threads.',
    Icon: WarningCircle,
    retryable: true,
  },
} as const

export function classifyThreadOpenFailure(error: unknown): ThreadOpenFailureKind {
  switch (getOpenGadgetErrorCode(error)) {
    case OPEN_GADGET_ERROR_CODES.threadAccessDenied:
      return 'access-denied'
    case OPEN_GADGET_ERROR_CODES.threadNotFound:
      return 'not-found'
    default:
      return 'unexpected'
  }
}

type Props = {
  kind: ThreadOpenFailureKind
  onRetry: () => void
  onGoToThreads: () => void
}

export default function ThreadOpenErrorPage({ kind, onRetry, onGoToThreads }: Props) {
  const { title, message, Icon, retryable } = CONTENT[kind]
  const titleId = useId()
  const descriptionId = useId()
  const titleRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  return (
    <div className="flex h-full items-center justify-center bg-kumo-base px-6 py-12">
      <section
        aria-atomic="true"
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-live="polite"
        className="themed-compact-shadow w-full max-w-md rounded-2xl border border-kumo-line bg-kumo-base px-6 py-8 text-center"
      >
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-kumo-line bg-kumo-tint text-kumo-subtle">
          <Icon aria-hidden="true" size={20} weight="bold" />
        </div>
        <h1
          id={titleId}
          ref={titleRef}
          tabIndex={-1}
          className="mt-5 text-[20px] leading-7 font-semibold tracking-[-0.35px] text-kumo-default outline-none"
        >
          {title}
        </h1>
        <p
          id={descriptionId}
          className="mt-2 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle"
        >
          {message}
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <WorkshopButton
            tone={retryable ? 'secondary' : 'primary'}
            className="!h-9"
            onClick={onGoToThreads}
          >
            Go to threads
          </WorkshopButton>
          {retryable && (
            <WorkshopButton tone="primary" onClick={onRetry}>
              Try again
            </WorkshopButton>
          )}
        </div>
      </section>
    </div>
  )
}
