// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import OpenWorkLogo from './OpenWorkLogo'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('OpenWorkLogo', () => {
  it('renders an accessible rounded contour animation', () => {
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => root.render(<OpenWorkLogo />))

    const logo = container.querySelector('svg')!
    expect(logo.getAttribute('aria-label')).toBe('OpenWork')
    expect(container.querySelectorAll('.openwork-logo-contour')).toHaveLength(7)
    expect(container.querySelectorAll('animate')).toHaveLength(2)
    expect(container.querySelector('.openwork-logo-face')?.textContent).toBe('OpenWork')

    act(() => root.unmount())
  })
})
