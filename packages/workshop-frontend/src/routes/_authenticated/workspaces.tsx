import { createFileRoute, Link } from '@tanstack/react-router'
import { Plus } from '@phosphor-icons/react'
import GadgetList from '../../components/GadgetList'
import PageChrome, { PAGE_ACTION } from '../../components/AppShell/PageChrome'
import { useDocumentTitle } from '../../useDocumentTitle'
import { gadgetsOptions } from '../../query/hooks'

export const Route = createFileRoute('/_authenticated/workspaces')({
  component: WorkspacesPage,
  loader: ({ context }) =>
    context.queryClient.ensureQueryData({
      ...gadgetsOptions(context.session),
      revalidateIfStale: true,
    }),
})

function WorkspacesPage() {
  useDocumentTitle('Workspaces')
  return (
    <PageChrome
      title="Workspaces"
      actions={
        <Link to="/" className={PAGE_ACTION}>
          <Plus size={14} />
          Create
        </Link>
      }
    >
      <GadgetList showHeader={false} />
    </PageChrome>
  )
}
