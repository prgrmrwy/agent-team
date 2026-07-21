import type { FC } from 'react'
import { RoleIcon, ROLE_NAMES, type RoleName } from '../../icons/index.js'

export type AvatarStatus =
  | 'working'
  | 'idle'
  | 'init'
  | 'offline'
  | 'vacant'
  | 'terminated'

interface AvatarProps {
  role: RoleName
  size?: number
  displayName?: string
  /** 实时 seat 状态 — 渲染右下角小角标(working 时 pulse;idle 静止 cyan;offline/vacant 灰/red) */
  status?: AvatarStatus
  /** 关掉原生 HTML title 浮层(被高级 hover card 包裹时用,避免双 tooltip) */
  disableTitle?: boolean
}

/**
 * 怪物头像 — design-handoff §5.1
 * 40×40 圆形 / 2px role 色描边 / 外辉光圈 / 内 30×30 SVG 继承 currentColor
 * 可选右下角 status badge(working = role 色 pulse + glow,idle = role 色静止,offline = ink-dim,vacant = malice)
 */
export const Avatar: FC<AvatarProps> = ({ role, size = 40, displayName, status, disableTitle }) => {
  const roleVar = `var(--${role})`
  const innerSize = Math.round((size * 30) / 40)
  const badgeSize = Math.max(8, Math.round(size * 0.28))

  return (
    <div
      style={{
        position: 'relative',
        width: size,
        height: size,
        flexShrink: 0,
      }}
      aria-label={
        displayName
          ? `${displayName} (${ROLE_NAMES[role]}${status ? `, ${status}` : ''})`
          : `${ROLE_NAMES[role]}${status ? ` (${status})` : ''}`
      }
      {...(disableTitle
        ? {}
        : {
            title: displayName
              ? `${displayName} · ${ROLE_NAMES[role]}${status ? ` · ${status}` : ''}`
              : `${ROLE_NAMES[role]}${status ? ` (${status})` : ''}`,
          })}
    >
      <div
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          background:
            'radial-gradient(circle at 30% 25%, var(--slate-elev), var(--slate-bg) 80%)',
          border: `2px solid ${roleVar}`,
          color: roleVar,
          boxShadow: `0 0 8px ${roleVar}, inset 0 0 4px rgba(0,0,0,0.4)`,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span
          style={{
            color: roleVar,
            filter: `drop-shadow(0 0 3px ${roleVar})`,
            display: 'inline-flex',
          }}
        >
          <RoleIcon role={role} size={innerSize} />
        </span>
      </div>

      {status && <StatusBadge status={status} size={badgeSize} />}
    </div>
  )
}

/**
 * 右下角状态角标 — 颜色与 role 无关,只反映 seat 运行态(agent-presence-ui spec):
 *   working    = amber(黄)+ pulse + glow
 *   idle       = link(绿)+ 微 glow
 *   init       = ink-dim(灰,spawn 进行中)
 *   vacant     = ink-dim(灰,空位 / 未招募)
 *   terminated = ink-dim(灰,任务终态归档)
 *   offline    = malice(红,网络/连接异常)
 */
const StatusBadge: FC<{ status: AvatarStatus; size: number }> = ({ status, size }) => {
  const color =
    status === 'working'
      ? 'var(--amber)'
      : status === 'idle'
        ? 'var(--link)' // idle online — 绿
        : status === 'offline'
          ? 'var(--malice)'
          : 'var(--ink-dim)' // init / vacant / terminated + 兜底
  const glow =
    status === 'working'
      ? `0 0 6px var(--amber-glow)`
      : status === 'idle'
        ? `0 0 4px var(--link-glow)`
        : 'none'

  return (
    <span
      aria-hidden="true"
      className={
        status === 'working' ? 'ab-pulse' : status === 'init' ? 'ab-blink' : ''
      }
      style={{
        position: 'absolute',
        right: '-1px',
        bottom: '-1px',
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        border: '2px solid var(--slate-bg)',
        boxShadow: glow,
      }}
    />
  )
}
