import { createFileRoute } from '@tanstack/react-router'
import ThreadEditor from '../../ThreadEditor'
import { aiConfigOptions, threadsOptions, modelsOptions } from '../../query/hooks'
import { ensureThreadBoot } from '../../query/thread-session'

type ThreadSearch = {
  // Selected workpiece (artifact) ID. Workpiece IDs start at 0, so parsing must not treat 0 as
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

export const Route = createFileRoute('/_authenticated/thread/$id')({
  component: ThreadEditor,
  validateSearch: (search: Record<string, unknown>): ThreadSearch => ({
    w: parseIntParam(search.w),
  }),
  loaderDeps: ({ search }) => ({ w: search.w }),
  loader: async ({ context, params, cause }) => {
    await Promise.all([
      context.queryClient.ensureQueryData({
        ...threadsOptions(context.session),
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
      await ensureThreadBoot(params.id, context.session.requireAuthenticatedApi())
    } catch {
    }
  },
})
