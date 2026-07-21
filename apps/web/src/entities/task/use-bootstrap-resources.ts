import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ServerToClient, TaskBootstrapResource } from '@agent-team/protocol'
import { restClient, wsClient } from '../../shared/api/index.js'

/**
 * 订阅 task 的 bootstrap resources:REST 拉初始快照 + WS bootstrap-resource 事件增量。
 *
 * WS event 只带状态字段(没有 path/branch/baseRef/attempts),所以收到事件后 invalidate query
 * 让 REST 重新拉完整 row;同时本地乐观更新 status/summary/error 让 UI 立刻反应。
 */
export function useBootstrapResources(taskId: string) {
  const queryClient = useQueryClient()
  const query = useQuery<TaskBootstrapResource[]>({
    queryKey: ['bootstrap-resources', taskId],
    queryFn: () => restClient.get<TaskBootstrapResource[]>(`/tasks/${taskId}/resources`),
    staleTime: 5_000,
  })

  useEffect(() => {
    const remove = wsClient.addHandler((msg: ServerToClient) => {
      if (msg.type !== 'bootstrap-resource' || msg.taskId !== taskId) return
      queryClient.setQueryData<TaskBootstrapResource[]>(['bootstrap-resources', taskId], (prev = []) => {
        const idx = prev.findIndex((r) => r.id === msg.resourceId)
        const patch: Partial<TaskBootstrapResource> = {
          status: msg.status,
          provider: msg.provider,
          kind: msg.kind,
          ...(msg.mode ? { mode: msg.mode } : {}),
          ...(msg.summary !== undefined ? { summary: msg.summary } : {}),
          ...(msg.error !== undefined ? { error: msg.error } : {}),
        }
        if (idx === -1) {
          // 新 resource:用 minimum stub,等 invalidate 后 REST 拉到完整。
          const now = new Date().toISOString()
          return [
            ...prev,
            {
              id: msg.resourceId,
              taskId,
              kind: msg.kind,
              status: msg.status,
              provider: msg.provider,
              mode: msg.mode,
              summary: msg.summary,
              error: msg.error,
              attempts: 0,
              createdAt: now,
              updatedAt: now,
            } as TaskBootstrapResource,
          ]
        }
        return prev.map((r, i) => (i === idx ? { ...r, ...patch, updatedAt: new Date().toISOString() } : r))
      })
      queryClient.invalidateQueries({ queryKey: ['bootstrap-resources', taskId] })
    })
    return remove
  }, [queryClient, taskId])

  return query
}
