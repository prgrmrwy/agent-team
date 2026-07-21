import type { FC } from 'react'
import { Chip } from '../../shared/ui/chip.js'
import { formatLocal } from '../../shared/lib/time.js'
import type { Agent } from './model.js'
import { AGENT_STATE_LABEL, agentStateVariant } from './model.js'
import { AgentAvatar } from './AgentAvatar.js'

interface AgentCardProps {
  agent: Agent
  onClick?: () => void
}

export const AgentCard: FC<AgentCardProps> = ({ agent, onClick }) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent"
    >
      <AgentAvatar agent={agent} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">{agent.displayName}</span>
          <Chip variant={agentStateVariant(agent.state)} dot>
            {AGENT_STATE_LABEL[agent.state]}
          </Chip>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span>{agent.factory}</span>
          <span>·</span>
          <span>v{agent.factoryVersion}</span>
          <span>·</span>
          <span>spawn {formatLocal(agent.spawnedAt)}</span>
        </div>
      </div>
    </button>
  )
}
