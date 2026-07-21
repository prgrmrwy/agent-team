import type { FC } from 'react'
import type { Agent } from './model.js'

interface AgentAvatarProps {
  agent: Pick<Agent, 'displayName' | 'factory' | 'state'>
  size?: 'sm' | 'md' | 'lg'
}

const FACTORY_COLOR: Record<string, string> = {
  planner: 'bg-purple-100 text-purple-700',
  engineer: 'bg-blue-100 text-blue-700',
  'pm-ux': 'bg-pink-100 text-pink-700',
  qa: 'bg-orange-100 text-orange-700',
  anti: 'bg-red-100 text-red-700',
  ci: 'bg-green-100 text-green-700',
}

const sizeClass = { sm: 'h-6 w-6 text-xs', md: 'h-9 w-9 text-sm', lg: 'h-12 w-12 text-base' }

export const AgentAvatar: FC<AgentAvatarProps> = ({ agent, size = 'md' }) => {
  const colorClass = FACTORY_COLOR[agent.factory] ?? 'bg-secondary text-secondary-foreground'
  return (
    <div
      className={[
        'flex items-center justify-center rounded-full font-bold',
        colorClass,
        sizeClass[size],
      ].join(' ')}
      title={`${agent.displayName} (${agent.factory})`}
    >
      {agent.displayName.slice(0, 1)}
    </div>
  )
}
