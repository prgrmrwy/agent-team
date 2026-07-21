import { type FC } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { FactoryItem } from '../../../entities/factory/index.js'
import { restClient } from '../../../shared/api/index.js'
import type { Factory } from '@agent-team/protocol'

export const FactoryList: FC = () => {
  const { data: factories = [] } = useQuery<Factory[]>({
    queryKey: ['factories'],
    queryFn: () => restClient.get<Factory[]>('/factories'),
  })

  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        工厂
      </h3>
      {factories.map((factory) => (
        <Link
          key={factory.name}
          to="/factories/$name"
          params={{ name: factory.name }}
          className="block rounded-md [&.active]:bg-accent"
          activeProps={{ className: 'active' }}
        >
          <FactoryItem factory={factory} />
        </Link>
      ))}
      {factories.length === 0 && (
        <p className="text-xs text-muted-foreground">暂无工厂配置</p>
      )}
    </div>
  )
}
