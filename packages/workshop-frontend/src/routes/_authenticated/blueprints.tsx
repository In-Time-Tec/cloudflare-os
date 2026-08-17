import { createFileRoute, Link } from '@tanstack/react-router'
import { useRef } from 'react'
import { Compass, UploadSimple } from '@phosphor-icons/react'
import BlueprintList from '../../components/BlueprintList'
import PageChrome, { PAGE_ACTION } from '../../components/AppShell/PageChrome'
import { useDocumentTitle } from '../../useDocumentTitle'

export const Route = createFileRoute('/_authenticated/blueprints')({
  component: BlueprintsRoutePage,
})

function BlueprintsRoutePage() {
  useDocumentTitle('Blueprints')
  const uploadInputRef = useRef<HTMLInputElement>(null)

  return (
    <PageChrome
      title="Blueprints"
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
      <BlueprintList hideToolbarActions uploadInputRef={uploadInputRef} />
    </PageChrome>
  )
}
