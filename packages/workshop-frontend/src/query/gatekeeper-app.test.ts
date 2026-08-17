import { describe, expect, it } from 'vitest'
import { GATEKEEPER_PERSISTED_GLOBAL, withPersistedSnapshot } from './gatekeeper-app'

describe('withPersistedSnapshot', () => {
  it('injects a JSON snapshot before </head>', () => {
    const html = '<!doctype html><html><head><title>App</title></head><body></body></html>'
    const next = withPersistedSnapshot(html, { schedules: [{ title: 'Morning brief' }] })
    expect(next).toContain(`window.${GATEKEEPER_PERSISTED_GLOBAL}=`)
    expect(next).toContain('Morning brief')
    expect(next.indexOf(`window.${GATEKEEPER_PERSISTED_GLOBAL}`)).toBeLessThan(next.indexOf('</head>'))
  })

  it('escapes HTML in snapshot JSON', () => {
    const next = withPersistedSnapshot('<html></html>', { title: '</script><img>' })
    expect(next).not.toContain('</script><img>')
    expect(next).toContain('\\u003c/script>')
  })
})
