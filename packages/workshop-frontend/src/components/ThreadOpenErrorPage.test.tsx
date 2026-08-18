// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenThreadError, OPEN_THREAD_ERROR_CODES } from '@gadgets/workshop-shared/api'
import ThreadOpenErrorPage, { classifyThreadOpenFailure } from './ThreadOpenErrorPage'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

vi.mock('./WorkshopControls', () => ({
  WorkshopButton: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}))

describe('ThreadOpenErrorPage', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
  })

  async function render(kind: 'access-denied' | 'not-found' | 'unexpected') {
    const onRetry = vi.fn<() => void>()
    const onGoToThreads = vi.fn<() => void>()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ThreadOpenErrorPage
        kind={kind}
        onRetry={onRetry}
        onGoToThreads={onGoToThreads}
      />,
    ))
    return { container, onGoToThreads, onRetry }
  }

  it('explains how to recover when access is denied without exposing thread metadata', async () => {
    const { container: renderedContainer, onGoToThreads, onRetry } = await render('access-denied')

    expect(renderedContainer.querySelector('h1')?.textContent).toBe("You don't have access to this thread")
    expect(renderedContainer.textContent).toContain('Ask the thread owner to grant you access, then try again.')
    expect(document.activeElement).toBe(renderedContainer.querySelector('h1'))

    const buttons = [...renderedContainer.querySelectorAll('button')]
    expect(buttons.map(button => button.textContent)).toEqual(['Go to threads', 'Try again'])
    act(() => buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    act(() => buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onGoToThreads).toHaveBeenCalledOnce()
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('gives a missing thread a distinct, non-retryable state', async () => {
    const { container: renderedContainer } = await render('not-found')

    expect(renderedContainer.querySelector('h1')?.textContent).toBe('Thread not found')
    expect(renderedContainer.textContent).toContain('The link may be incorrect, or the thread may have been deleted.')
    expect([...renderedContainer.querySelectorAll('button')].map(button => button.textContent))
      .toEqual(['Go to threads'])
  })

  it('keeps unexpected failures retryable', async () => {
    const { container: renderedContainer } = await render('unexpected')

    expect(renderedContainer.querySelector('h1')?.textContent).toBe("We couldn't load this thread")
    expect(renderedContainer.textContent).toContain('Try again. If the problem continues, return to your threads.')
    expect([...renderedContainer.querySelectorAll('button')].map(button => button.textContent))
      .toEqual(['Go to threads', 'Try again'])
  })

  it('classifies stable open error codes without treating unexpected errors as expected', () => {
    expect(classifyThreadOpenFailure(
      createOpenThreadError(OPEN_THREAD_ERROR_CODES.threadAccessDenied),
    )).toBe('access-denied')
    expect(classifyThreadOpenFailure(
      createOpenThreadError(OPEN_THREAD_ERROR_CODES.threadNotFound),
    )).toBe('not-found')
    expect(classifyThreadOpenFailure(
      new Error(OPEN_THREAD_ERROR_CODES.threadAccessDenied),
    )).toBe('unexpected')
    expect(classifyThreadOpenFailure(new Error('storage unavailable'))).toBe('unexpected')
  })
})
