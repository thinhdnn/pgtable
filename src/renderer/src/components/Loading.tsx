import { Spin } from 'antd'
import { LoadingOutlined } from '@ant-design/icons'

interface Props {
  tip?: string
  /** Antd Spin's delay (ms) — suppresses a flash for fetches that finish quickly. */
  delay?: number
  /** Pixel size of the spinner glyph. */
  size?: number
}

const indicator = (px: number) => <LoadingOutlined spin style={{ fontSize: px }} />

// First-load placeholder: takes the full area of its parent and centres a spinner.
export function LoadingPanel({ tip, delay = 0, size = 40 }: Props) {
  return (
    <div className="pg-loading-panel">
      <Spin tip={tip} delay={delay} indicator={indicator(size)} />
    </div>
  )
}

// Background-refetch indicator: absolutely positioned, sits on top of stale content
// without blocking interaction. Use inside a `position: relative` parent.
export function LoadingOverlay({ tip, delay = 200, size = 40 }: Props) {
  return (
    <div className="pg-loading-overlay" aria-hidden>
      <Spin tip={tip} delay={delay} indicator={indicator(size)} />
    </div>
  )
}
