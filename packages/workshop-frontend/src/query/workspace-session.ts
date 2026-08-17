import { RpcStub, RpcTarget } from 'capnweb'
import type {
  AiChatAuthorInfo,
  AiChatHistoryPage,
  AiChatMetadata,
  AuthenticatedApi,
  GadgetMetadata,
  ObserverAccountChoice,
  ObserverBindingNeed,
  ObserverConfigCallback,
  Overseer,
  WorkpieceId,
  WorkpieceSummary,
  WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'
import { persistWorkspaceWorkpieces } from './workpieces'

export type WorkspaceBoot = {
  id: string
  overseer: RpcStub<Overseer>
  metadata: GadgetMetadata
  chats: AiChatMetadata[]
  models: AiChatAuthorInfo[]
  history: { chatId: number; page: AiChatHistoryPage } | null
  workpieces: WorkpieceSummary[]
  configureObservers: RpcStub<ObserverConfigCallback>
}

const boots = new Map<string, WorkspaceBoot>()

function disposeBoot(boot: WorkspaceBoot): void {
  boot.overseer[Symbol.dispose]?.()
  boot.configureObservers[Symbol.dispose]?.()
}

export function stashWorkspaceBoot(boot: WorkspaceBoot): void {
  const previous = boots.get(boot.id)
  if (previous && previous !== boot) disposeBoot(previous)
  boots.set(boot.id, boot)
}

export function takeWorkspaceBoot(id: string): WorkspaceBoot | null {
  const boot = boots.get(id) ?? null
  if (boot) boots.delete(id)
  return boot
}

export function clearWorkspaceBoots(): void {
  for (const boot of boots.values()) disposeBoot(boot)
  boots.clear()
}

class DeferredObserverConfig extends RpcTarget implements ObserverConfigCallback {
  configure(_needs: ObserverBindingNeed[]): Promise<ObserverAccountChoice[]> {
    return Promise.reject(new Error('OBSERVER_CONFIG_DEFERRED'))
  }
}

class BootWorkpiecesCollector extends RpcTarget implements WorkpiecesSubscriber {
  #items = new Map<WorkpieceId, WorkpieceSummary>()
  #resolve: (items: WorkpieceSummary[]) => void

  constructor(resolve: (items: WorkpieceSummary[]) => void) {
    super()
    this.#resolve = resolve
  }

  entry(summary: WorkpieceSummary) {
    this.#items.set(summary.id, summary)
  }

  removed(id: WorkpieceId) {
    this.#items.delete(id)
  }

  ready() {
    this.#resolve([...this.#items.values()])
  }
}

async function listWorkpiecesOnce(overseer: RpcStub<Overseer>): Promise<WorkpieceSummary[]> {
  let subscription: RpcStub<{}> | undefined
  try {
    return await new Promise<WorkpieceSummary[]>((resolve, reject) => {
      void overseer.subscribeToWorkpieces(new BootWorkpiecesCollector(resolve)).then((sub) => {
        subscription = sub
      }, reject)
    })
  } finally {
    subscription?.[Symbol.dispose]?.()
  }
}

export async function ensureWorkspaceBoot(
  id: string,
  api: RpcStub<AuthenticatedApi>,
): Promise<WorkspaceBoot> {
  const existing = boots.get(id)
  if (existing) return existing

  const configureObservers = new RpcStub(new DeferredObserverConfig())
  const overseer = api.openGadget(id, undefined, configureObservers)
  try {
    let settled = false
    const metadata = await new Promise<GadgetMetadata>((resolve, reject) => {
      void overseer.subscribeToMetadata((next) => {
        if (settled) return
        settled = true
        resolve(next)
      }).catch(reject)
    })
    const [chats, models, workpieces] = await Promise.all([
      overseer.listChats(),
      overseer.listModels(),
      listWorkpiecesOnce(overseer),
    ])
    const first = chats[0]
    const history = first
      ? { chatId: first.id, page: await overseer.getChatHistory(first.id) }
      : null
    persistWorkspaceWorkpieces(id, workpieces)
    const boot = { id, overseer, metadata, chats, models, history, workpieces, configureObservers }
    stashWorkspaceBoot(boot)
    return boot
  } catch (error) {
    overseer[Symbol.dispose]?.()
    configureObservers[Symbol.dispose]?.()
    throw error
  }
}
