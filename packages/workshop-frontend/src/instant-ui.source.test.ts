import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('.', import.meta.url))
const SKIP = new Set(['routeTree.gen.ts'])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'generated' || name.endsWith('.test.ts') || name.endsWith('.test.tsx')) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (/\.(ts|tsx)$/.test(name) && !SKIP.has(name)) out.push(path)
  }
  return out
}

describe('instant UI source', () => {
  it('does not use Skeleton, Loader, animate-spin, or spinner loading props', () => {
    const hits: string[] = []
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8')
      if (/\bSkeleton\b/.test(text)) hits.push(`${file}: Skeleton`)
      if (/\bLoader\b/.test(text) && !file.endsWith('query-layer.test.tsx')) hits.push(`${file}: Loader`)
      if (/animate-spin/.test(text)) hits.push(`${file}: animate-spin`)
      if (/<(Button|button)[^>]*\sloading=\{/.test(text) || /\sloading=\{[^}]+\}/.test(text) && /from '@cloudflare\/kumo'/.test(text) && /Button/.test(text)) {
        const lines = text.split('\n')
        lines.forEach((line, i) => {
          if (/loading=\{/.test(line) && !/ResourceConfiguratorHost|VendorCard|frameLoading|configuratorLoading/.test(line) && !/loading\?:/.test(line) && !/loading = /.test(line) && !/vendorsLoading/.test(line)) {
            if (/<(Button|[A-Z][A-Za-z]*)[^>]*loading=\{/.test(line) || /^\s+loading=\{/.test(line)) {
              hits.push(`${file}:${i + 1}: ${line.trim()}`)
            }
          }
        })
      }
    }
    expect(hits).toEqual([])
  })
})
