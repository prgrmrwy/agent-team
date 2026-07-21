import type { FC } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { Agent, Seat } from '@agent-team/protocol'
import { Avatar, type AvatarStatus } from '../avatar/avatar.js'
import type { RoleName } from '../../icons/index.js'
import { computeAvatarStatus, STATUS_LABEL } from './status.js'

export interface AgentAvatarProps {
  agent?: Agent
  seat?: Seat
  /** 显式 override(罕用,agent/seat 都缺时给 fallback) */
  status?: AvatarStatus
  /** 显式 override displayName(罕用;无 agent 时 fallback 用 seat.role 或 role 名) */
  displayName?: string
  /** 显式 override role(无 agent/seat 时 fallback,如 SeatsBar 未招募 role) */
  role?: RoleName
  size?: number
  /** 关掉 hover 浮层:profile 内嵌头像、popup 内嵌头像用 */
  disableHoverCard?: boolean
  /** 点击行为;传 null 显式禁用;默认无(调用方显式给) */
  onClick?: (() => void) | null
}

/**
 * 统一 agent 头像组件 — 头像内核 + 状态 badge + 可选 hover 名片 + 可选 click。
 * 状态由 computeAvatarStatus 单点计算(agent-presence-ui spec)。
 *
 * 用法:
 *   <AgentAvatar agent={a} seat={s} onClick={() => openProfile(a.id)} />
 *   <AgentAvatar agent={a} seat={s} disableHoverCard /> // profile 内嵌
 *   <AgentAvatar role="qa" /> // 未招募 role,显灰
 */
export const AgentAvatar: FC<AgentAvatarProps> = ({
  agent,
  seat,
  status: statusProp,
  displayName: displayNameProp,
  role: roleProp,
  size = 36,
  disableHoverCard,
  onClick,
}) => {
  const status = statusProp ?? computeAvatarStatus(seat, agent)
  const role = roleProp ?? (agent ? factoryToRoleName(agent.factory) : null)
  const displayName = displayNameProp ?? agent?.displayName ?? seat?.role ?? role ?? '?'
  const clickable = !!onClick

  const [hover, setHover] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const enter = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setHover(true), 180)
  }
  const leave = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    setHover(false)
  }
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
  }, [])

  const colorVar = role ? `var(--${role})` : 'var(--ink-dim)'

  // 无 role 走简化版(罕见 fallback)
  if (!role) {
    return (
      <span
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          background: 'var(--slate-elev)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--ink-dim)',
          fontSize: 11,
          flexShrink: 0,
        }}
        title={displayName}
      >
        ?
      </span>
    )
  }

  const avatarNode = (
    <Avatar
      role={role}
      size={size}
      displayName={displayName}
      status={status}
      disableTitle
    />
  )

  const trigger = clickable ? (
    <button
      type="button"
      onClick={onClick ?? undefined}
      aria-label={`查看 ${displayName} 详情`}
      style={{
        all: 'unset',
        cursor: 'pointer',
        display: 'inline-flex',
      }}
    >
      {avatarNode}
    </button>
  ) : (
    avatarNode
  )

  if (disableHoverCard) {
    // 即使关 hover popup 也保留 click trigger
    return (
      <span
        style={{
          display: 'inline-block',
          width: size,
          height: size,
          lineHeight: 0,
          flexShrink: 0,
        }}
      >
        {trigger}
      </span>
    )
  }

  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-block',
        width: size,
        height: size,
        lineHeight: 0,
        flexShrink: 0,
      }}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      {trigger}

      {hover && (
        <span
          role="tooltip"
          style={{
            position: 'absolute',
            top: 0,
            left: 'calc(100% + 8px)',
            zIndex: 50,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 10px',
            background: 'var(--slate-elev)',
            border: `1px solid ${colorVar}`,
            borderRadius: 2,
            boxShadow: `0 4px 16px rgba(0,0,0,0.5), 0 0 8px ${colorVar}`,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            minWidth: 200,
            lineHeight: 1.4,
          }}
        >
          <Avatar role={role} size={32} displayName={displayName} status={status} disableTitle />
          <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span
              style={{
                fontSize: 13,
                color: colorVar,
                fontWeight: 600,
                textShadow: `0 0 4px ${colorVar}`,
              }}
            >
              {displayName}
            </span>
            <span
              className="ab-eyebrow ab-tabular"
              style={{ fontSize: 9, color: 'var(--ink-dim)', letterSpacing: '0.1em' }}
            >
              {seat?.role ?? agent?.factory ?? '?'}
              {agent?.factoryVersion ? ` · v${agent.factoryVersion}` : ''}
            </span>
            <span
              className="ab-eyebrow ab-tabular"
              style={{ fontSize: 9, color: 'var(--ink-soft)', letterSpacing: '0.08em' }}
            >
              {STATUS_LABEL[status]}
            </span>
          </span>
        </span>
      )}
    </span>
  )
}

/** factory → RoleName(SeatsBar / chatroom 复用) */
export function factoryToRoleName(factory: string): RoleName {
  if (factory === 'pm-ux') return 'pmux'
  if (
    factory === 'planner' ||
    factory === 'engineer' ||
    factory === 'qa' ||
    factory === 'anti' ||
    factory === 'ci'
  ) {
    return factory
  }
  return 'planner'
}
