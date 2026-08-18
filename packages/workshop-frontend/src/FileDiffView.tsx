import { useMemo } from 'react'
import { MultiFileDiff, type DiffFileInput } from '@pierre/diffs/react'
import type * as Y from 'yjs'
import { useTheme } from './ThemeContext'
import { useYTextString } from './FileView'

/**
 * Read-only diff of one file's original vs. proposed contents, rendered with Pierre's
 * MultiFileDiff. Replaces the old Monaco-based CodeDiffEditor (+ custom diff renderer).
 * A null side renders as a fully added/deleted file.
 */
export default function FileDiffView({ filename, originalYText, modifiedYText }: {
  filename: string | null
  originalYText: Y.Text | null
  modifiedYText: Y.Text | null
}) {
  const { resolvedThemeMode } = useTheme()
  const originalContents = useYTextString(originalYText)
  const modifiedContents = useYTextString(modifiedYText)

  // MultiFileDiff takes a discriminated union: {oldFile, newFile} where at most one side is
  // null (added/deleted file). Build it in explicit branches so TypeScript sees the union.
  const diffInput = useMemo((): DiffFileInput | null => {
    if (filename === null) return null
    const oldContents = originalYText === null ? null : { name: filename, contents: originalContents }
    const newContents = modifiedYText === null ? null : { name: filename, contents: modifiedContents }
    if (newContents !== null) return { oldFile: oldContents, newFile: newContents }
    if (oldContents !== null) return { oldFile: oldContents, newFile: null }
    return null
  }, [filename, originalYText, originalContents, modifiedYText, modifiedContents])
  const options = useMemo(() => ({
    theme: { light: 'pierre-light', dark: 'pierre-dark' } as const,
    themeType: resolvedThemeMode,
    diffStyle: 'unified' as const,
    overflow: 'wrap' as const,
    disableFileHeader: true,
  }), [resolvedThemeMode])

  if (diffInput === null) return null
  return (
    <div className="h-full overflow-y-auto bg-kumo-base">
      <MultiFileDiff {...diffInput} options={options} />
    </div>
  )
}
