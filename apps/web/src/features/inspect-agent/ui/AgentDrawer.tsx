import type { FC } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatLocal } from '../../../shared/lib/time.js'
import { formatTokenCount } from '../../../shared/lib/token-usage.js'
import { restClient } from '../../../shared/api/index.js'
import type { Agent, AgentUsageResponse } from '@agent-team/protocol'
import { AGENT_STATE_LABEL } from '../../../entities/agent/index.js'
import { AgentAvatar } from '../../../shared/ui/agent-avatar/index.js'
import type { RoleName } from '../../../shared/icons/index.js'

interface AgentDrawerProps {
  agent: Agent | null
  open: boolean
  onClose: () => void
}

export const AgentDrawer: FC<AgentDrawerProps> = ({ agent, open, onClose }) => {
  const { data: usage } = useQuery<AgentUsageResponse>({
    queryKey: ['agent-usage', agent?.taskId, agent?.id],
    queryFn: () => restClient.get<AgentUsageResponse>(`/tasks/${agent!.taskId}/agents/${agent!.id}/usage`),
    enabled: Boolean(agent?.taskId && agent?.id && open),
  })

  if (!agent) return null
  if (!open) return null

  const role = factoryToRoleName(agent.factory)

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 39, background: 'rgba(0,0,0,0.45)' }}
        aria-label="关闭"
      />
      <aside
        className="paper-panel"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 360,
          maxWidth: '78vw',
          zIndex: 40,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          className="paper-head"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '12px 16px',
          }}
        >
          <div className="paper-head-title">agent profile</div>
          <button type="button" onClick={onClose} aria-label="关闭" className="paper-close">
            ×
          </button>
        </div>

        <div className="paper-body" style={{ padding: '20px 22px', overflowY: 'auto', flex: 1 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              paddingBottom: 14,
              borderBottom: '1px solid var(--paper-shadow)',
              marginBottom: 14,
            }}
          >
            <AgentAvatar
              agent={agent}
              role={role}
              size={52}
              disableHoverCard
              onClick={null}
            />
            <div style={{ minWidth: 0 }}>
              <h2
                style={{
                  margin: 0,
                  fontSize: 22,
                  color: 'var(--paper-deep)',
                  fontVariant: 'small-caps',
                }}
              >
                {agent.displayName}
              </h2>
              <div className="ab-eyebrow" style={{ marginTop: 4 }}>
                {agent.factory} · v{agent.factoryVersion}
              </div>
            </div>
          </div>

          <dl
            style={{
              display: 'grid',
              gridTemplateColumns: '86px 1fr',
              gap: '8px 12px',
              margin: 0,
              fontSize: 14,
            }}
          >
            <dt className="ab-eyebrow">state</dt>
            <dd style={{ margin: 0 }}>{AGENT_STATE_LABEL[agent.state]}</dd>
            <dt className="ab-eyebrow">tokens</dt>
            <dd className="ab-tabular" style={{ margin: 0 }}>
              {formatTokenCount(usage?.runtime.totalTokens ?? 0)}
            </dd>
            <dt className="ab-eyebrow">agent id</dt>
            <dd className="ab-tabular" style={{ margin: 0, wordBreak: 'break-all' }}>
              {agent.id}
            </dd>
            <dt className="ab-eyebrow">factory</dt>
            <dd style={{ margin: 0 }}>{agent.factory}</dd>
            <dt className="ab-eyebrow">spawned</dt>
            <dd className="ab-tabular" style={{ margin: 0 }}>{formatLocal(agent.spawnedAt)}</dd>
            {agent.terminatedAt && (
              <>
                <dt className="ab-eyebrow">ended</dt>
                <dd className="ab-tabular" style={{ margin: 0 }}>
                  {formatLocal(agent.terminatedAt)}
                </dd>
              </>
            )}
            <dt className="ab-eyebrow">seat id</dt>
            <dd className="ab-tabular" style={{ margin: 0, wordBreak: 'break-all' }}>
              {agent.seatId}
            </dd>
          </dl>

          <hr className="paper-rule" style={{ margin: '18px 0 12px' }} />
          <p style={{ margin: 0, color: 'var(--ink-brown-d)', fontStyle: 'italic' }}>
            Workspace: ~/.agent-team/projects/.../agents/{agent.id}/
          </p>
          <p style={{ margin: '8px 0 0', color: 'var(--ink-brown-d)', fontStyle: 'italic' }}>
            工作目录、MCP 配置、factory.lock.yaml 均在此目录内。
          </p>
        </div>
      </aside>
    </>
  )
}

function factoryToRoleName(factory: string): RoleName {
  if (factory === 'pm-ux') return 'pmux'
  if (factory === 'planner' || factory === 'engineer' || factory === 'qa' || factory === 'anti' || factory === 'ci') {
    return factory
  }
  return 'planner'
}
