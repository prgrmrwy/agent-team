import type { FC } from 'react'
import type { Factory } from './model.js'

interface FactoryItemProps {
  factory: Factory
  onClick?: () => void
}

export const FactoryItem: FC<FactoryItemProps> = ({ factory, onClick }) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
    >
      <span className="font-medium">{factory.name}</span>
      <span className="text-xs text-muted-foreground">v{factory.version}</span>
      <span className="ml-auto text-xs text-muted-foreground truncate max-w-[120px]">{factory.persona}</span>
    </button>
  )
}
