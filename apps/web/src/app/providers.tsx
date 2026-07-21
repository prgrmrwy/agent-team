import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { useEffect, type FC } from 'react'
import { router } from './router.js'
import { wsClient } from '../shared/api/index.js'
import type { ServerToClient, Task } from '@agent-team/protocol'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 2,
    },
  },
})

export const Providers: FC = () => {
  // 在 app 挂载时启动 WS 连接(token 已由 rsbuild define 注入)
  useEffect(() => {
    wsClient.connect()
    // 全局 phase-change 监听:命中 tasks 列表 + 单 task cache 都同步更新
    // (避免 sidebar / state pill / done filter 等读列表的位置看不到状态变化)
    const remove = wsClient.addHandler((msg: ServerToClient) => {
      if (msg.type !== 'phase-change') return
      queryClient.setQueryData<Task[]>(['tasks'], (prev = []) =>
        prev.map((t) => (t.id === msg.taskId ? ({ ...t, state: msg.to } as Task) : t)),
      )
      queryClient.setQueryData<Task>(['task', msg.taskId], (prev) =>
        prev ? ({ ...prev, state: msg.to } as Task) : prev,
      )
    })
    return () => {
      remove()
      wsClient.destroy()
    }
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}
