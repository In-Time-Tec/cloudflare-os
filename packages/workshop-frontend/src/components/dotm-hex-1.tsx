import { useEffect, useState, type CSSProperties } from 'react'
import './dotm-hex-1.css'

const ROW_COUNTS = [3, 4, 5, 4, 3] as const
const BASE_OPACITY = 0.1
const MID_OPACITY = 0.2
const HIGH_OPACITY = 0.96
const CENTER_OPACITY = 0.1
const TRAIL_SPAN = 5
const HEX_ROW_PITCH_RATIO = Math.sqrt(3) / 2
const PERIMETER_PATH = [
  '0,0', '0,1', '0,2', '1,3', '2,4', '3,3', '4,2', '4,1', '4,0', '3,0', '2,0', '1,0',
] as const
const PATH_LEN = PERIMETER_PATH.length
const HALF_PATH = PATH_LEN / 2

function modF(n: number, m: number): number {
  return ((n % m) + m) % m
}

function smoothstep01(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function glowAlongPath(head: number, pathIndex: number | null): number {
  if (pathIndex === null) return BASE_OPACITY
  const distance = modF(head - pathIndex, PATH_LEN)
  const glow = 1 - smoothstep01(0, TRAIL_SPAN, distance)
  return BASE_OPACITY + glow * (HIGH_OPACITY - BASE_OPACITY)
}

function opacityForCell(id: string, phase: number): number {
  if (id === '2,2') return CENTER_OPACITY
  const pathIndex = PERIMETER_PATH.indexOf(id as (typeof PERIMETER_PATH)[number])
  const normalized = pathIndex === -1 ? null : pathIndex
  const headA = phase * PATH_LEN
  const headB = modF(headA + HALF_PATH, PATH_LEN)
  const perimeterGlow = Math.max(
    glowAlongPath(headA, normalized),
    glowAlongPath(headB, normalized) * 0.74,
  )
  if (normalized !== null) return Math.min(HIGH_OPACITY, perimeterGlow)
  const col = Number(id.split(',')[1])
  return Math.max(BASE_OPACITY, col === 2 ? MID_OPACITY : 0.18)
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return reduced
}

function useCyclePhase(active: boolean, cycleMsBase: number, speed: number): number {
  const [phase, setPhase] = useState(0)
  useEffect(() => {
    if (!active) {
      setPhase(0)
      return
    }
    const safeSpeed = speed > 0 ? speed : 1
    const raw = cycleMsBase / safeSpeed
    const cycleMs = raw > 0 && Number.isFinite(raw) ? raw : 1000
    const start = performance.now()
    let rafId = 0
    const tick = (now: number) => {
      const elapsed = ((now - start) % cycleMs + cycleMs) % cycleMs
      setPhase(elapsed / cycleMs)
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [active, cycleMsBase, speed])
  return phase
}

export function DotmHex1({
  size = 14,
  speed = 1.6,
  ariaLabel = 'Loading',
  className,
}: {
  size?: number
  speed?: number
  ariaLabel?: string
  className?: string
}) {
  const reducedMotion = usePrefersReducedMotion()
  const cyclePhase = useCyclePhase(!reducedMotion, 1500, speed)
  const phase = reducedMotion ? 0.08 : cyclePhase
  const gap = Math.max(1, Math.round(size * 0.08))
  const dotSize = Math.max(1.25, (size - gap * (ROW_COUNTS[2] - 1)) / ROW_COUNTS[2])
  const colPitch = dotSize + gap
  const rowGap = Math.max(1, colPitch * HEX_ROW_PITCH_RATIO - dotSize)
  const matrixWidth = dotSize * ROW_COUNTS[2] + gap * (ROW_COUNTS[2] - 1)
  const matrixHeight = dotSize * ROW_COUNTS.length + rowGap * (ROW_COUNTS.length - 1)

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
      className={['dmx-root', className].filter(Boolean).join(' ')}
      style={{
        width: size,
        height: size,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: rowGap,
          width: matrixWidth,
          height: matrixHeight,
        }}
      >
        {ROW_COUNTS.map((count, row) => (
          <div
            key={row}
            style={{
              display: 'flex',
              justifyContent: 'center',
              gap,
            }}
          >
            {Array.from({ length: count }, (_, col) => {
              const id = `${row},${col}`
              return (
                <span
                  key={id}
                  aria-hidden="true"
                  className="dmx-dot"
                  style={{
                    width: dotSize,
                    height: dotSize,
                    opacity: opacityForCell(id, phase),
                  } as CSSProperties}
                />
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
