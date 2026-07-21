import type { Project, Task } from '@agent-team/protocol'
import { isTerminalTaskState } from '@agent-team/protocol'

export type TaskFilter = 'active' | 'releasing' | 'done' | 'all'

export function matchesTaskFilter(task: Task, filter: TaskFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'done') return isTerminalTaskState(task.state)
  if (filter === 'releasing') return task.state === 'releasing'
  // active = 既不在终态也不在 releasing(用户期望:active 只关注真在跑的)
  return !isTerminalTaskState(task.state) && task.state !== 'releasing'
}

export function findFirstVisibleTask(tasks: Task[], projects: Project[], filter: TaskFilter): Task | null {
  for (const project of projects) {
    const task = tasks.find(
      (item) => (item.projectId ?? 'default') === project.id && matchesTaskFilter(item, filter),
    )
    if (task) return task
  }
  return null
}
