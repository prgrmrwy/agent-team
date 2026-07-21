import type { FC } from 'react'
import { Chip } from '../../shared/ui/chip.js'
import { formatLocal } from '../../shared/lib/time.js'
import type { Task } from './model.js'
import { TASK_STATE_LABEL, taskStateVariant } from './model.js'

interface TaskCardProps {
  task: Task
  onClick?: () => void
  active?: boolean
}

export const TaskCard: FC<TaskCardProps> = ({ task, onClick, active = false }) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'w-full rounded-lg border p-4 text-left transition-colors',
        active
          ? 'border-primary bg-primary/5'
          : 'border-border bg-card hover:bg-accent',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium line-clamp-2">{task.title}</span>
        <Chip variant={taskStateVariant(task.state)} dot className="shrink-0">
          {TASK_STATE_LABEL[task.state]}
        </Chip>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground line-clamp-1">{task.description}</p>
      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span>{formatLocal(task.createdAt)}</span>
      </div>
    </button>
  )
}
