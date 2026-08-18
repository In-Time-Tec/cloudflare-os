import { useEffect, useMemo } from 'react'
import { FileTree, useFileTree } from '@pierre/trees/react'
import { DownloadSimple } from '@phosphor-icons/react'
import { WorkshopIconButton } from './components/WorkshopControls'
import type { FileChangeStatus } from './fileChangeStatus'

/**
 * Read-only file tree for a thread's artifact files, rendered with Pierre's FileTree.
 * Replaces the old FileSidebar: agents own file mutations, so there are no create/rename/
 * delete affordances — just selection, change-status badges, and per-file download.
 */
export default function FileTreePanel({
  files,
  activeFile,
  fileChangeStatuses,
  onFileSelect,
  onFileDownload,
}: {
  files: string[]
  activeFile: string | null
  fileChangeStatuses?: Map<string, FileChangeStatus>
  onFileSelect: (filename: string) => void
  onFileDownload: (filename: string) => void
}) {
  const { model } = useFileTree({
    paths: files,
    initialExpansion: 'open',
    onSelectionChange: (paths) => {
      const path = paths[0]
      if (typeof path === 'string' && path) onFileSelect(path)
    },
  })

  useEffect(() => {
    model.resetPaths(files)
  }, [files, model])

  useEffect(() => {
    if (!activeFile) return
    model.getItem(activeFile)?.select()
  }, [activeFile, model])

  const gitStatus = useMemo(() => {
    if (!fileChangeStatuses) return []
    return [...fileChangeStatuses]
      .filter((entry): entry is [string, 'added' | 'deleted' | 'modified'] =>
        entry[1] !== 'unchanged')
      .map(([path, status]) => ({ path, status }))
  }, [fileChangeStatuses])

  useEffect(() => {
    model.setGitStatus(gitStatus)
  }, [gitStatus, model])

  const header = (
    <div className="flex h-9 items-center justify-between border-b border-kumo-line px-3">
      <span className="text-[12px] leading-4 font-medium tracking-[-0.2px] text-kumo-subtle">
        Files
      </span>
      {activeFile && (
        <WorkshopIconButton
          aria-label={`Download ${activeFile}`}
          title="Download file"
          onClick={() => onFileDownload(activeFile)}
          className="!h-6 !w-6"
        >
          <DownloadSimple size={13} weight="bold" />
        </WorkshopIconButton>
      )}
    </div>
  )

  return (
    <div className="flex w-[220px] shrink-0 flex-col border-r border-kumo-line bg-kumo-elevated">
      <FileTree model={model} header={header} style={{ flex: 1, minHeight: 0 }} />
    </div>
  )
}
