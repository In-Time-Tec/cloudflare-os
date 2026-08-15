import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'

// The authenticated RPC stub lives in React state (useAuth), but TanStack Query queryFns are plain
// functions that run outside React. This module-level holder mirrors main.tsx's currentStub pattern:
// useAuth updates it on every (re)connect, and query functions read through getAuthenticatedApi().
//
// Only the *current* stub is ever held — stubs are disposable and must not outlive their RPC
// session, so the holder is reassigned, never accumulated.

let active: RpcStub<AuthenticatedApi> | null = null

/** Called by useAuth whenever a fresh authenticatedApi stub is produced (or cleared on logout). */
export function setActiveAuthenticatedApi(stub: RpcStub<AuthenticatedApi> | null): void {
  active = stub
}

/** The current authenticatedApi stub, or null before auth resolves. */
export function getActiveAuthenticatedApi(): RpcStub<AuthenticatedApi> | null {
  return active
}

import type { ConversationsApi } from '@gadgets/workshop-shared/gatekeeper'

let activeConversations: RpcStub<ConversationsApi> | null = null

/** Called by ConversationsProvider once the account's conversations capability is acquired. */
export function setActiveConversationsApi(stub: RpcStub<ConversationsApi> | null): void {
  activeConversations = stub
}

export function getActiveConversationsApi(): RpcStub<ConversationsApi> | null {
  return activeConversations
}
