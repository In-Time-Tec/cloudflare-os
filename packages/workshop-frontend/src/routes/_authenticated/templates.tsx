import { createFileRoute, Link } from '@tanstack/react-router'
import { useRef } from 'react'
import { Compass, UploadSimple } from '@phosphor-icons/react'
import TemplateList from '../../components/TemplateList'
import PageChrome, { PAGE_ACTION } from '../../components/AppShell/PageChrome'
import { useDocumentTitle } from '../../useDocumentTitle'

export const Route = createFileRoute('/_authenticated/templates')({
  component: TemplatesRoutePage,
})

function TemplatesRoutePage() {
  useDocumentTitle('Templates')
  const uploadInputRef = useRef<HTMLInputElement>(null)

  return (
    <PageChrome
      title="Templates"
      actions={
        <>
          <Link to="/explore" className={PAGE_ACTION}>
            <Compass size={14} />
            Explore
          </Link>
          <button
            type="button"
            onClick={() => uploadInputRef.current?.click()}
            className={PAGE_ACTION}
          >
            <UploadSimple size={14} />
            Upload
          </button>
        </>
      }
    >
      <TemplateList hideToolbarActions uploadInputRef={uploadInputRef} />
    </PageChrome>
  )
}
