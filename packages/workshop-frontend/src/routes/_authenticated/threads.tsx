import { createFileRoute, Link } from '@tanstack/react-router'
import { Plus } from '@phosphor-icons/react'
import ThreadList from '../../components/ThreadList'
import PageChrome, { PAGE_ACTION } from '../../components/AppShell/PageChrome'
import { useDocumentTitle } from '../../useDocumentTitle'
import { threadsOptions } from '../../query/hooks'

export const Route = createFileRoute('/_authenticated/threads')({
  component: ThreadsPage,
  loader: ({ context }) =>
    context.queryClient.ensureQueryData({
      ...threadsOptions(context.session),
      revalidateIfStale: true,
    }),
})

function ThreadsPage() {
  useDocumentTitle('Threads')
  return (
    <PageChrome
      title="Threads"
      actions={
        <Link to="/" className={PAGE_ACTION}>
          <Plus size={14} />
          Create
        </Link>
      }
    >
      <ThreadList showHeader={false} />
    </PageChrome>
  )
}
