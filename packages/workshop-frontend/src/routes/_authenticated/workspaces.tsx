import { createFileRoute, Link } from '@tanstack/react-router'
import { Plus } from '@phosphor-icons/react'
import GadgetList from '../../components/GadgetList'
import PageChrome, { PAGE_ACTION } from '../../components/AppShell/PageChrome'
import { useDocumentTitle } from '../../useDocumentTitle'

export const Route = createFileRoute('/_authenticated/workspaces')({
  component: WorkspacesPage,
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
