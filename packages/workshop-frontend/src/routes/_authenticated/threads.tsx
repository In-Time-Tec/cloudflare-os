import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_authenticated/threads')({
  beforeLoad: () => {
    throw redirect({ to: '/' })
  },
  component: () => null,
})
