import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * Legacy URL. Threads historically lived at /gadget/$id (from when each thread held
 * exactly one gadget); the editor now lives at /thread/$id. Redirect old links there,
 * preserving search params (?chat=, ?w=) and the hash (#share=, #fullscreen).
 */
export const Route = createFileRoute('/gadget/$id')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/thread/$id',
      params: { id: params.id },
      search: true,
      hash: true,
      replace: true,
    })
  },
  component: () => null,
})
