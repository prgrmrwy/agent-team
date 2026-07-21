import { type FC } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { restClient } from '../../../shared/api/index.js'
import { RetroView } from '../../../features/review-retro/index.js'
import type { Artifact, Task } from '@agent-team/protocol'

interface RetroPageProps {
  taskId: string
}

export const RetroPage: FC<RetroPageProps> = ({ taskId }) => {
  const { data: task } = useQuery<Task>({
    queryKey: ['task', taskId],
    queryFn: () => restClient.get<Task>(`/tasks/${taskId}`),
  })

  const { data: artifacts = [] } = useQuery<Artifact[]>({
    queryKey: ['artifacts', taskId],
    queryFn: () => restClient.get<Artifact[]>(`/tasks/${taskId}/artifacts`),
  })

  const retroArtifact = artifacts.find((a) => a.type === 'retrospective') ?? null

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* 顶部导航 */}
      <header className="flex items-center gap-3 border-b px-6 py-3 bg-background">
        <Link to="/tasks/$taskId" params={{ taskId }} className="text-sm text-muted-foreground hover:text-foreground">
          ← 返回任务
        </Link>
        <h1 className="text-sm font-semibold">
          复盘 · {task?.title ?? taskId}
        </h1>
      </header>

      {/* 内容区 */}
      <main className="flex-1 overflow-y-auto px-6 py-6 max-w-3xl mx-auto w-full">
        <RetroView retroArtifact={retroArtifact} />
      </main>
    </div>
  )
}
