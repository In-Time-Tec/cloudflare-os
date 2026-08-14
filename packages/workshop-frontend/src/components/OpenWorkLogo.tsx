import type { CSSProperties } from 'react'

/** Low-contrast, deforming contour wordmark used on the empty home screen. */
export default function OpenWorkLogo() {
  return (
    <svg
      className="openwork-logo"
      viewBox="0 0 650 150"
      role="img"
      aria-label="OpenWork"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <filter id="openwork-warp" x="-8%" y="-25%" width="116%" height="160%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.006 0.018"
            numOctaves="2"
            seed="8"
            result="noise"
          >
            <animate
              attributeName="baseFrequency"
              dur="9.6s"
              values="0.006 0.018;0.009 0.026;0.005 0.021;0.011 0.03;0.007 0.019;0.006 0.018"
              keyTimes="0;0.2;0.42;0.64;0.82;1"
              calcMode="spline"
              keySplines=".45 0 .55 1;.45 0 .55 1;.45 0 .55 1;.45 0 .55 1;.45 0 .55 1"
              repeatCount="indefinite"
            />
          </feTurbulence>
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale="4"
            xChannelSelector="R"
            yChannelSelector="G"
          >
            <animate
              attributeName="scale"
              dur="9.6s"
              values="3;8;5;10;6;3"
              keyTimes="0;0.2;0.42;0.64;0.82;1"
              calcMode="spline"
              keySplines=".45 0 .55 1;.45 0 .55 1;.45 0 .55 1;.45 0 .55 1;.45 0 .55 1"
              repeatCount="indefinite"
            />
          </feDisplacementMap>
        </filter>
      </defs>

      <g className="openwork-logo-art" filter="url(#openwork-warp)" aria-hidden="true">
        {Array.from({ length: 7 }, (_, index) => (
          <text
            key={index}
            className="openwork-logo-contour"
            x="325"
            y="112"
            textAnchor="middle"
            style={{ '--openwork-depth': index + 1 } as CSSProperties}
          >
            OpenWork
          </text>
        ))}
        <text className="openwork-logo-face" x="325" y="104" textAnchor="middle">
          OpenWork
        </text>
      </g>
    </svg>
  )
}
