export const OPEN_NEW_THREAD_EVENT = 'gadgets:open-new-thread'

export type OpenNewThreadDetail = {
  seed?: string
}

export function openNewThread(detail: OpenNewThreadDetail = {}): void {
  window.dispatchEvent(new CustomEvent<OpenNewThreadDetail>(OPEN_NEW_THREAD_EVENT, { detail }))
}
