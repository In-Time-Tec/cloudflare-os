import { createFileRoute } from '@tanstack/react-router'
import TemplatesPage from '../../TemplatesPage'
import { useDocumentTitle } from '../../useDocumentTitle'

export const Route = createFileRoute('/_authenticated/explore')({
  component: ExplorePage,
})

function ExplorePage() {
  useDocumentTitle('Explore')

  return <TemplatesPage />
}
