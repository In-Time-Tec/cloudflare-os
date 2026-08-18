import { useMemo, useSyncExternalStore } from 'react'
import { File } from '@pierre/diffs/react'
import type * as Y from 'yjs'
import { useTheme } from './ThemeContext'

/**
 * Subscribe to a Y.Text and return its current string contents. Re-renders on every remote
 * (agent) edit; users cannot edit files, so there is no local write path.
 */
export function useYTextString(ytext: Y.Text | null): string {
  return useSyncExternalStore(
    (cb) => {
      if (!ytext) return () => {}
      ytext.observe(cb)
      return () => ytext.unobserve(cb)
    },
    () => ytext?.toString() ?? '',
  )
}

/**
 * Read-only file view rendered with Pierre's Shiki-highlighted <File> component. Replaces the
 * old Monaco CodeEditor: only agents edit files, so there is no editing surface at all.
 */
export default function FileView({ filename, ytext }: {
  filename: string | null
  ytext: Y.Text | null
}) {
  const { resolvedThemeMode } = useTheme()
  const contents = useYTextString(ytext)
  const file = useMemo(
    () => (filename === null ? null : { name: filename, contents }),
    [filename, contents],
  )
  const options = useMemo(() => ({
    theme: { light: 'pierre-light', dark: 'pierre-dark' } as const,
    themeType: resolvedThemeMode,
    overflow: 'wrap' as const,
    disableFileHeader: true,
  }), [resolvedThemeMode])

  if (!file) return null
  return (
    <div className="h-full overflow-y-auto bg-kumo-base">
      <File file={file} options={options} />
    </div>
  )
}
