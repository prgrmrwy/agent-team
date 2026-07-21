import type { FC } from 'react'
import { isTerminalTaskState, type TaskState } from '@agent-team/protocol'

interface StatePipelineProps {
  current: TaskState
}

/**
 * 12-seg 六边形状态机进度图 — design-handoff §5.2
 *
 * 我们目前实际的状态机:S0 / S1 / S2 / S6 / S7 / S9 / S10' / S11 / done(+ aborted / process-crashed 终态)
 * 12 个 segment 把这些映射并保留未来 S3-S5/S8/S10 留空槽。
 */

interface Seg {
  code: string
  state?: TaskState
  label: string
}

const SEGMENTS: Seg[] = [
  { code: 'S0', state: 'S0', label: '填写' },
  { code: 'S1', state: 'S1', label: '规划' },
  { code: 'S2', state: 'S2', label: '招募' },
  { code: 'S3', label: '需求' },        // pm-ux,m3 hold
  { code: 'S4', label: '设计' },        // pm-ux,m3 hold
  { code: 'S5', label: 'R1' },          // anti,m3 hold
  { code: 'S6', state: 'S6', label: '实现' },
  { code: 'S7', state: 'S7', label: '验收' },
  { code: 'S8', label: 'R2' },          // anti,m3 hold
  { code: 'S9', state: 'S9', label: 'CI' },
  { code: 'S10', state: "S10'", label: '等人' },
  { code: 'S11', state: 'S11', label: '复盘' },
]

export const StatePipeline: FC<StatePipelineProps> = ({ current }) => {
  // 找当前 active seg index
  const activeIdx = SEGMENTS.findIndex((s) => s.state === current)
  // 终态当全 passed
  const finished = isTerminalTaskState(current)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 12px' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(12, 1fr)',
          gap: 4,
        }}
        role="progressbar"
        aria-label="任务状态机进度"
        aria-valuemin={0}
        aria-valuemax={SEGMENTS.length}
        aria-valuenow={activeIdx + 1}
      >
        {SEGMENTS.map((seg, i) => {
          const passed = finished || (activeIdx >= 0 && i < activeIdx)
          const active = activeIdx === i
          const disabled = !seg.state // 未实现的态(S3-S5 / S8)永远 disabled
          return <Hexagon key={seg.code} passed={passed} active={active} disabled={disabled} />
        })}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(12, 1fr)',
          gap: 4,
          marginTop: 2,
        }}
      >
        {SEGMENTS.map((seg, i) => (
          <span
            key={seg.code}
            className="ab-tabular"
            style={{
              fontSize: 8,
              textAlign: 'center',
              color: activeIdx === i ? 'var(--cyan)' : 'var(--ink-dimmer)',
              letterSpacing: '0.05em',
            }}
          >
            {seg.code}
          </span>
        ))}
      </div>
    </div>
  )
}

const Hexagon: FC<{ passed: boolean; active: boolean; disabled: boolean }> = ({
  passed,
  active,
  disabled,
}) => {
  const bg = disabled
    ? 'transparent'
    : active
      ? 'var(--cyan-bright)'
      : passed
        ? 'var(--cyan-dim)'
        : 'var(--slate-elev)'
  const border = disabled ? 'var(--slate-edge)' : active ? 'var(--cyan)' : passed ? 'var(--cyan-dim)' : 'var(--slate-edge)'
  return (
    <div
      style={{
        position: 'relative',
        height: 14,
        clipPath: 'polygon(8% 0, 92% 0, 100% 50%, 92% 100%, 8% 100%, 0 50%)',
        background: bg,
        boxShadow: active ? 'inset 0 0 0 1px var(--cyan)' : `inset 0 0 0 1px ${border}`,
        opacity: disabled ? 0.3 : 1,
        overflow: 'hidden',
      }}
    >
      {active && (
        <div
          className="ab-pulse-fast"
          style={{
            position: 'absolute',
            inset: 2,
            background: 'var(--cyan)',
            clipPath: 'polygon(10% 0, 90% 0, 100% 50%, 90% 100%, 10% 100%, 0 50%)',
            boxShadow: '0 0 8px var(--cyan-glow)',
          }}
        />
      )}
    </div>
  )
}
