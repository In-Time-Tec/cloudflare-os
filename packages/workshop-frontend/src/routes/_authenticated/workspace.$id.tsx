import { createFileRoute } from '@tanstack/react-router'
import GadgetEditor from '../../GadgetEditor'
import { aiConfigOptions, gadgetsOptions, modelsOptions } from '../../query/hooks'
import { ensureWorkspaceBoot } from '../../query/workspace-session'

type GadgetSearch = {
  chat?: number
  // Selected workpiece (gadget) ID. Workpiece IDs start at 0, so parsing must not treat 0 as
  // absent.
  w?: number
}

function parseIntParam(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && value !== '') {
    const parsed = Number(value)
    if (Number.isInteger(parsed)) return parsed
  }
  return undefined
}

export const Route = createFileRoute('/_authenticated/workspace/$id')({
  component: GadgetEditor,
  validateSearch: (search: Record<string, unknown>): GadgetSearch => ({
    chat: typeof search.chat === 'number' ? search.chat
      : typeof search.chat === 'string' ? Number(search.chat) || undefined
      : undefined,
    w: parseIntParam(search.w),
  }),
  loaderDeps: ({ search }) => ({ chat: search.chat, w: search.w }),
  loader: async ({ context, params, cause }) => {
    await Promise.all([
      context.queryClient.ensureQueryData({
        ...gadgetsOptions(context.session),
        revalidateIfStale: true,
      }),
      context.queryClient.ensureQueryData({
        ...modelsOptions(context.session),
        revalidateIfStale: true,
      }),
      context.queryClient.ensureQueryData({
        ...aiConfigOptions(context.session),
        revalidateIfStale: true,
      }),
    ])
    if (cause === 'preload' || cause === 'stay') return
    try {
      await ensureWorkspaceBoot(params.id, context.session.requireAuthenticatedApi())
    } catch {
    }
  },
})
